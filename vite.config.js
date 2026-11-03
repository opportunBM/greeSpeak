import { defineConfig, loadEnv } from "vite";
import { EdgeTTS } from "node-edge-tts";
import { resolve } from "node:path";

const GROQ_CHAT_MODEL = "openai/gpt-oss-20b";
const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

export default defineConfig(({ mode }) => {
  const { GROQ_API_KEY: groqApiKey } = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [{
      name: "greespeak-ai-api",
      configureServer(server) {
        server.middlewares.use("/api/speak", async (request, response) => {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ error: "Use POST to generate speech." }));
            return;
          }

          try {
            let body = "";
            for await (const chunk of request) {
              body += chunk;
              if (body.length > 12000) {
                response.statusCode = 413;
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ error: "The text is too long to speak." }));
                return;
              }
            }
            const { text, language } = JSON.parse(body);
            if (typeof text !== "string" || !text.trim()) {
              response.statusCode = 400;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ error: "Text is required." }));
              return;
            }
            const isFrench = language === "fr";
            const tts = new EdgeTTS({
              voice: isFrench ? "fr-FR-HenriNeural" : "en-US-GuyNeural",
              lang: isFrench ? "fr-FR" : "en-US",
              outputFormat: "audio-24khz-48kbitrate-mono-mp3",
              rate: "-5%",
              timeout: 20000,
            });
            const audioChunks = [];
            for await (const chunk of tts.streamAudio(text.slice(0, 1000))) {
              if (Buffer.isBuffer(chunk)) audioChunks.push(chunk);
            }
            if (audioChunks.length === 0) {
              response.statusCode = 502;
              response.setHeader("Content-Type", "application/json; charset=utf-8");
              response.end(JSON.stringify({ error: "Microsoft Edge TTS returned no speech audio." }));
              return;
            }
            const audio = Buffer.concat(audioChunks);
            response.statusCode = 200;
            response.setHeader("Content-Type", "audio/mpeg");
            response.setHeader("Content-Length", audio.length);
            response.setHeader("Cache-Control", "no-store");
            response.end(audio);
          } catch (error) {
            if (!response.headersSent) {
              response.statusCode = 502;
              response.setHeader("Content-Type", "application/json; charset=utf-8");
              response.end(JSON.stringify({
                error: error instanceof Error && error.message.includes("Timed out")
                  ? "Microsoft Edge TTS took too long to respond. Please try again."
                  : error instanceof Error
                    ? error.message
                    : "Could not generate speech with Microsoft Edge TTS.",
              }));
            } else {
              response.end();
            }
          }
        });

        server.middlewares.use("/api/transcribe", async (request, response) => {
          response.setHeader("Content-Type", "application/json");
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end(JSON.stringify({ error: "Use POST to transcribe audio." }));
            return;
          }
          if (!groqApiKey) {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: "Groq is not configured. Add GROQ_API_KEY to .env.local and restart the server." }));
            return;
          }

          try {
            let body = "";
            for await (const chunk of request) {
              body += chunk;
              if (body.length > 4_000_000) {
                response.statusCode = 413;
                response.end(JSON.stringify({ error: "The recording is too large. Please speak for less time." }));
                return;
              }
            }
            const { audio, language } = JSON.parse(body);
            if (typeof audio !== "string" || !audio) {
              response.statusCode = 400;
              response.end(JSON.stringify({ error: "No recorded audio was received." }));
              return;
            }

            const form = new FormData();
            form.append("file", new Blob([Buffer.from(audio, "base64")], { type: "audio/wav" }), "recording.wav");
            form.append("model", GROQ_TRANSCRIPTION_MODEL);
            const transcriptionLanguage = language === "fr" ? "fr" : "en";
            form.append("language", transcriptionLanguage);
            form.append("prompt", `Transcribe the speech verbatim in ${transcriptionLanguage === "fr" ? "French" : "English"}. Do not translate.`);
            form.append("response_format", "json");
            const transcriptionResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
              method: "POST",
              headers: { Authorization: `Bearer ${groqApiKey}` },
              body: form,
              signal: AbortSignal.timeout(30000),
            });
            const raw = await transcriptionResponse.text();
            let result;
            try {
              result = raw ? JSON.parse(raw) : {};
            } catch {
              response.statusCode = 502;
              response.end(JSON.stringify({ error: "Groq returned an invalid transcription response." }));
              return;
            }
            if (!transcriptionResponse.ok) {
              response.statusCode = transcriptionResponse.status;
              response.end(JSON.stringify({ error: result.error?.message || `Groq transcription failed (HTTP ${transcriptionResponse.status}).` }));
              return;
            }
            const text = typeof result.text === "string" ? result.text.trim() : "";
            if (!text) {
              response.statusCode = 502;
              response.end(JSON.stringify({ error: "Groq could not recognize any words." }));
              return;
            }
            response.end(JSON.stringify({ text }));
          } catch (error) {
            response.statusCode = 502;
            response.end(JSON.stringify({
              error: error?.name === "TimeoutError"
                ? "Groq transcription took too long to respond."
                : error instanceof Error
                  ? error.message
                  : "Could not transcribe the audio with Groq.",
            }));
          }
        });

        server.middlewares.use("/api/chat", async (request, response) => {
          response.setHeader("Content-Type", "application/json");

          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end(JSON.stringify({ error: "Use POST to send a chat message." }));
            return;
          }

          if (!groqApiKey) {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: "Groq is not configured. Add GROQ_API_KEY to .env.local and restart the server." }));
            return;
          }

          try {
            let body = "";
            for await (const chunk of request) {
              body += chunk;
              if (body.length > 60000) {
                response.statusCode = 413;
                response.end(JSON.stringify({ error: "The message is too long." }));
                return;
              }
            }

            const { message, context, language: requestedLanguage } = JSON.parse(body);
            if (typeof message !== "string" || !message.trim()) {
              response.statusCode = 400;
              response.end(JSON.stringify({ error: "A non-empty message is required." }));
              return;
            }
            const responseLanguage = requestedLanguage === "fr" ? "French" : "English";

            const safeContext = context && typeof context === "object" ? context : {};
            const { history: conversationHistory, ...appState } = safeContext;
            const stateMessage = `Current greeSpeak app state (JSON): ${JSON.stringify(appState)}`;
            const history = Array.isArray(conversationHistory)
              ? conversationHistory
                .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
                .slice(-8)
                .map((entry) => ({ role: entry.role, content: entry.content.slice(0, 1000) }))
              : [];
            const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${groqApiKey}`,
              },
              signal: AbortSignal.timeout(15000),
              body: JSON.stringify({
                model: GROQ_CHAT_MODEL,
                messages: [
                  {
                    role: "system",
                    content: `You are greeSpeak, a concise voice assistant that can control this productivity app. Understand both English and French, but ALWAYS write every reply in ${responseLanguage}, regardless of the language used in the user's message or conversation history. Use the supplied app state to answer questions about the user's notes, calendar tasks, timer, stopwatch, current page and local time. If the user requests an action, return it in the action field so the app can execute it; never claim an action was completed without returning a valid action. Use these exact action formats: ADD_NOTE {content}; DELETE_NOTE {id or keyword}; READ_NOTES {}; ADD_TASK {title, date as YYYY-MM-DD, time as HH:mm}; DELETE_TASK {title}; START_STOPWATCH {}; STOP_STOPWATCH {}; RESET_STOPWATCH {}; START_TIMER {durationSeconds}; STOP_TIMER {}. Interpret English and French dates relative to the supplied current date and time zone. Preserve note and task text in the language the user used. Respond as a JSON object with exactly {"reply":"short natural reply in ${responseLanguage}","action":null or {"action":"...",...}}. For actions, reply in one concise sentence. Never return empty content.`,
                  },
                  ...history,
                  { role: "user", content: `${stateMessage}\nUser request: ${message}` },
                ],
                max_tokens: 400,
                temperature: 0.2,
                reasoning_effort: "low",
                response_format: { type: "json_object" },
              }),
            });
            const raw = await groqResponse.text();
            let result;
            try {
              result = raw ? JSON.parse(raw) : {};
            } catch {
              response.statusCode = 502;
              response.end(JSON.stringify({ error: "Groq returned an invalid response." }));
              return;
            }
            if (!groqResponse.ok) {
              response.statusCode = groqResponse.status;
              response.end(JSON.stringify({ error: result.error?.message || `Groq request failed (HTTP ${groqResponse.status}).` }));
              return;
            }
            const choice = result.choices?.[0];
            const content = typeof choice?.message?.content === "string"
              ? choice.message.content.trim()
              : "";
            if (!content) {
              response.statusCode = 502;
              const finishReason = choice?.finish_reason;
              response.end(JSON.stringify({
                error: finishReason === "length"
                  ? "The answer was cut short. Please try a shorter request."
                  : "The AI could not form a reply this time. Please try again.",
              }));
              return;
            }
            let answer;
            try {
              answer = JSON.parse(content);
            } catch {
              answer = { reply: content, action: null };
            }
            const reply = typeof answer.reply === "string" ? answer.reply.trim() : "";
            const action = answer.action && typeof answer.action.action === "string" ? answer.action : null;
            if (!reply && !action) {
              response.statusCode = 502;
              response.end(JSON.stringify({ error: "The AI response was incomplete. Please try again." }));
              return;
            }
            response.end(JSON.stringify({ text: reply, action }));
          } catch (error) {
            response.statusCode = 502;
            response.end(JSON.stringify({
              error: error?.name === "TimeoutError"
                ? "Groq took too long to respond. Please try again."
                : error instanceof Error
                  ? error.message
                  : "Could not contact Groq.",
            }));
          }
        });
      },
    }],
    build: {
      rollupOptions: {
        input: {
          index: resolve(process.cwd(), "index.html"),
          home: resolve(process.cwd(), "home.html"),
          notes: resolve(process.cwd(), "notes.html"),
          calendar: resolve(process.cwd(), "calendar.html"),
          clock: resolve(process.cwd(), "clock.html"),
        },
      },
    },
  };
});
