// This file uses plain browser JavaScript: no framework is required.
const $ = (selector) => document.querySelector(selector);
const STORAGE_NOTES = "assistant-notes";
const STORAGE_TASKS = "assistant-tasks";
const STORAGE_CLOCK = "assistant-clock";
const STORAGE_CHAT = "greespeak-chat";

let notes = readList(STORAGE_NOTES);
let tasks = readList(STORAGE_TASKS);
let chatMessages = readChatMessages();
const selectedMessageIds = new Set();
const savedClockState = readClockState();
let recognition;
let recognitionActive = false;
let speechSendTimeout;
let nativeSpeechTimeout;
let recorderState;
let replyPending = false;
let voiceCallActive = sessionStorage.getItem("greespeak-voice-call") === "true";
let voiceCallStarting = false;
let voiceTurnPending = false;
let voiceCallStartTimer;
let speechRequestId = 0;
let speechAbortController;
let speechAudioContext;
let speechSources = new Set();
let alarmAudio;
let alarmInterval;
let timerInterval;
let timerEnd = Number.isFinite(savedClockState.timerEnd) ? savedClockState.timerEnd : 0;
let timerRemaining = Number.isFinite(savedClockState.timerRemaining) ? savedClockState.timerRemaining : 0;
let timerLanguage = savedClockState.timerLanguage === "fr" ? "fr" : "en";
let stopwatchInterval;
let stopwatchStarted = Number.isFinite(savedClockState.stopwatchStarted) ? savedClockState.stopwatchStarted : 0;
let stopwatchElapsed = Number.isFinite(savedClockState.stopwatchElapsed) ? savedClockState.stopwatchElapsed : 0;
let laps = Array.isArray(savedClockState.laps) ? savedClockState.laps.filter((lap) => typeof lap === "string") : [];
let alarmActive = savedClockState.alarmActive === true;

const voiceLanguageSelect = $("#voice-language");
const currentPage = document.body.dataset.page;
const savedVoiceLanguage = sessionStorage.getItem("greespeak-language");
if (savedVoiceLanguage === "en-US" || savedVoiceLanguage === "fr-FR") {
  voiceLanguageSelect.value = savedVoiceLanguage;
}

function getSelectedLanguage() {
  return voiceLanguageSelect.value === "fr-FR" ? "fr" : "en";
}

voiceLanguageSelect.addEventListener("change", () => {
  sessionStorage.setItem("greespeak-language", voiceLanguageSelect.value);
  if (recognition) recognition.lang = voiceLanguageSelect.value;
});

const waveform = $(".waveform");
if (waveform) {
  for (let i = 0; i < 36; i += 1) {
    const bar = document.createElement("span");
    const height = 8 + Math.round((Math.sin(i * 2.3) + 1) * 13);
    bar.style.setProperty("--bar-height", `${height}px`);
    bar.style.animationDelay = `${(i % 8) * 70}ms`;
    waveform.append(bar);
  }
}

function readList(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function readClockState() {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_CLOCK) || "{}");
    return state && typeof state === "object" ? state : {};
  } catch {
    return {};
  }
}

function readChatMessages() {
  try {
    const messages = JSON.parse(localStorage.getItem(STORAGE_CHAT) || "[]");
    if (!Array.isArray(messages)) return [];
    return messages.filter((message) =>
      message
      && typeof message.id === "string"
      && typeof message.text === "string"
      && (message.sender === "assistant" || message.sender === "user"),
    );
  } catch {
    return [];
  }
}

function saveLists() {
  localStorage.setItem(STORAGE_NOTES, JSON.stringify(notes));
  localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks));
}

function saveChatMessages() {
  localStorage.setItem(STORAGE_CHAT, JSON.stringify(chatMessages));
}

function saveClockState() {
  localStorage.setItem(STORAGE_CLOCK, JSON.stringify({
    timerEnd,
    timerRemaining,
    timerLanguage,
    stopwatchStarted,
    stopwatchElapsed,
    laps,
    alarmActive,
  }));
}

document.querySelector(`[data-nav="${currentPage}"]`)?.classList.add("active");

function logout() {
  stopVoiceCall("Call ended");
  sessionStorage.removeItem("greespeak-user");
  sessionStorage.removeItem("greespeak-language");
  sessionStorage.removeItem("greespeak-pending-message");
  sessionStorage.removeItem("greespeak-pending-command");
  window.location.replace("/");
}

$("#logout-button").addEventListener("click", logout);

function addChatMessage(text, sender) {
  chatMessages.push({ id: crypto.randomUUID(), text, sender });
  saveChatMessages();
  renderChatMessages();
}

function renderChatMessages() {
  const list = $("#chat-messages");
  if (!list) return;
  list.replaceChildren();

  if (!chatMessages.length) {
    list.textContent = "No messages yet. Start a conversation!";
  }
  chatMessages.forEach((entry) => {
    const message = document.createElement("div");
    message.className = `message ${entry.sender}-message`;
    const selectLabel = document.createElement("label");
    selectLabel.className = "message-select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedMessageIds.has(entry.id);
    checkbox.setAttribute("aria-label", "Select message");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedMessageIds.add(entry.id);
      else selectedMessageIds.delete(entry.id);
      updateConversationActions();
    });
    selectLabel.append(checkbox);

    const content = document.createElement("span");
    content.className = "message-text";
    content.textContent = entry.text;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-button message-delete";
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg><span>Delete</span>';
    remove.setAttribute("aria-label", "Delete message");
    remove.title = "Delete message";
    remove.addEventListener("click", () => deleteChatMessages(new Set([entry.id])));

    message.append(selectLabel, content, remove);
    list.append(message);
  });
  list.scrollTop = list.scrollHeight;
  updateConversationActions();
}

function updateConversationActions() {
  const deleteSelected = $("#delete-selected-messages");
  if (deleteSelected) {
    deleteSelected.disabled = selectedMessageIds.size === 0;
    deleteSelected.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg><span>Delete selected${selectedMessageIds.size ? ` (${selectedMessageIds.size})` : ""}</span>`;
  }
  const clearConversation = $("#clear-conversation");
  if (clearConversation) {
    clearConversation.disabled = chatMessages.length === 0;
    clearConversation.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg><span>Clear conversation</span>';
  }
}

function deleteChatMessages(ids) {
  chatMessages = chatMessages.filter((message) => !ids.has(message.id));
  ids.forEach((id) => selectedMessageIds.delete(id));
  saveChatMessages();
  renderChatMessages();
}

function setSpeakingState() {
  $("#mic-button").classList.remove("listening", "thinking");
  $("#mic-button").classList.add("speaking");
  $("#voice-status").textContent = "Speaking...";
}

function finishSpeaking() {
  $("#voice-status").textContent = "Ready";
  $("#mic-button").classList.remove("speaking");
  if (voiceCallActive) resumeVoiceCallListening();
}

function updateVoiceCallButton() {
  const button = $("#mic-button");
  button.setAttribute("aria-pressed", String(voiceCallActive));
  button.setAttribute("aria-label", voiceCallActive ? "End voice call" : "Start voice call");
  button.title = voiceCallActive ? "End voice call" : "Start a hands-free voice call";
  button.classList.toggle("call-active", voiceCallActive);
}

updateVoiceCallButton();

function pauseVoiceCallInput() {
  clearTimeout(speechSendTimeout);
  speechSendTimeout = null;
  clearTimeout(nativeSpeechTimeout);
  if (recorderState) recorderState.fallbackPending = false;
  if (recorderState && !recorderState.recorder) recorderState = null;
  if (recognition && recognitionActive) recognition.stop();
  if (recorderState?.recorder?.state === "recording") {
    recorderState.discard = true;
    recorderState.manualStop = true;
    recorderState.fallbackPending = false;
    recorderState.recorder.stop();
  }
}

function resumeVoiceCallListening() {
  if (!voiceCallActive) return;
  voiceTurnPending = false;
  clearTimeout(voiceCallStartTimer);
  voiceCallStartTimer = window.setTimeout(() => {
    startVoiceCallListening();
  }, 500);
}

async function startVoiceCallListening() {
  const micButton = $("#mic-button");
  if (!voiceCallActive
    || voiceCallStarting
    || replyPending
    || recognitionActive
    || recorderState
    || micButton.classList.contains("speaking")
    || micButton.classList.contains("thinking")) return;
  voiceCallStarting = true;
  $("#mic-button").classList.remove("speaking", "thinking");
  $("#voice-status").textContent = "Connecting microphone...";

  const started = await startRecordedSpeech(Boolean(recognition));
  if (!started) {
    voiceCallStarting = false;
    stopVoiceCall($("#voice-status").textContent || "Could not start the microphone.");
    return;
  }
  if (!voiceCallActive) {
    pauseVoiceCallInput();
    voiceCallStarting = false;
    return;
  }
  if (recognition) {
    recognition.lang = voiceLanguageSelect.value;
    try {
      recognition.start();
    } catch (error) {
      voiceCallStarting = false;
      $("#voice-status").textContent = error instanceof Error
        ? `Could not start speech recognition: ${error.message}`
        : "Could not start speech recognition.";
      pauseVoiceCallInput();
      stopVoiceCall($("#voice-status").textContent);
      return;
    }
  }
  voiceCallStarting = false;
}

function startVoiceCall() {
  voiceCallActive = true;
  voiceTurnPending = false;
  sessionStorage.setItem("greespeak-voice-call", "true");
  updateVoiceCallButton();
  startVoiceCallListening();
}

function stopVoiceCall(status = "Call ended") {
  voiceCallActive = false;
  voiceTurnPending = false;
  voiceCallStarting = false;
  sessionStorage.removeItem("greespeak-voice-call");
  clearTimeout(voiceCallStartTimer);
  pauseVoiceCallInput();
  speechRequestId += 1;
  speechAbortController?.abort();
  speechSources.forEach((source) => source.stop());
  speechSources.clear();
  $("#mic-button").classList.remove("listening", "thinking", "speaking");
  $("#voice-status").textContent = status;
  updateVoiceCallButton();
}

async function speak(text, language = getSelectedLanguage()) {
  if (voiceCallActive) {
    voiceTurnPending = true;
    pauseVoiceCallInput();
  }
  const requestId = ++speechRequestId;
  speechAbortController?.abort();
  speechAbortController = new AbortController();
  speechSources.forEach((source) => source.stop());
  speechSources.clear();
  $("#mic-button").classList.remove("speaking");
  $("#mic-button").classList.add("thinking");
  $("#voice-status").textContent = "Preparing voice...";

  try {
    const response = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, language }),
      signal: speechAbortController.signal,
    });
    if (requestId !== speechRequestId) return;
    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = "Microsoft Edge voice is unavailable.";
      try {
        const errorData = errorText ? JSON.parse(errorText) : {};
        errorMessage = errorData.error || errorMessage;
      } catch {
        if (errorText) errorMessage = errorText;
      }
      throw new Error(errorMessage);
    }
    if (!response.body) throw new Error("Microsoft Edge TTS did not return audio.");

    speechAudioContext ||= new AudioContext();
    await speechAudioContext.resume();
    const audio = await speechAudioContext.decodeAudioData(await response.arrayBuffer());
    if (requestId !== speechRequestId) return;
    const source = speechAudioContext.createBufferSource();
    source.buffer = audio;
    source.connect(speechAudioContext.destination);
    speechSources.add(source);
    source.addEventListener("ended", () => {
      speechSources.delete(source);
      if (requestId === speechRequestId) finishSpeaking();
    }, { once: true });
    source.start();
    setSpeakingState();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (requestId !== speechRequestId) return;
    speechSources.forEach((source) => source.stop());
    speechSources.clear();
    $("#mic-button").classList.remove("thinking", "speaking");
    $("#voice-status").textContent = "Voice unavailable";
    addChatMessage(error instanceof Error ? error.message : "Could not play the voice response.", "assistant");
    if (voiceCallActive) resumeVoiceCallListening();
  }
}

function todayString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function tomorrowString() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function commandAction(message) {
  const normalized = message.trim().toLowerCase();
  let match = message.match(/^(?:add|create|make)\s+(?:a\s+)?note\s*[:,-]?\s*(.+)$/i)
    || message.match(/^(?:ajoute|ajouter|cree|créer|note)\s+(?:une?\s+)?note\s*[:,-]?\s*(.+)$/i);
  if (match) return { action: "ADD_NOTE", content: match[1].trim() };
  if (/\b(read|show|list)\s+(?:my\s+)?notes\b/i.test(message) || /\b(lis|affiche|montre)\s+(?:mes\s+)?notes\b/i.test(message)) {
    return { action: "READ_NOTES" };
  }
  if (/\b(delete|remove)\s+(?:the\s+)?last\s+note\b/i.test(message) || /\b(supprime|efface)\s+(?:la\s+)?derni[eè]re\s+note\b/i.test(message)) {
    return { action: "DELETE_NOTE", id: 1 };
  }
  match = message.match(/(?:delete|remove)\s+note\s+(\d+)/i) || message.match(/(?:supprime|efface)\s+(?:la\s+)?note\s+(\d+)/i);
  if (match) return { action: "DELETE_NOTE", id: Number(match[1]) };
  match = message.match(/(?:delete|remove)\s+note\s+(?:about|on)\s+(.+)/i) || message.match(/(?:supprime|efface)\s+(?:la\s+)?note\s+(?:sur|de|a propos de|à propos de)\s+(.+)/i);
  if (match) return { action: "DELETE_NOTE", keyword: match[1].trim() };

  if (/^(start|begin|lance|demarre|démarre) (?:a |un |le |la )?(stopwatch|chrono|chronometre|chronom[eè]tre)/i.test(normalized)) {
    return { action: "START_STOPWATCH" };
  }
  if (/^(stop|pause|arr[eê]te|mets en pause) (?:the |le |la )?(stopwatch|chrono|chronometre|chronom[eè]tre)/i.test(normalized)) {
    return { action: "STOP_STOPWATCH" };
  }
  if (/^(reset|clear|reinitialise|réinitialise|remets a zero|remets à zéro) (?:the |le |la )?(stopwatch|chrono|chronometre|chronom[eè]tre)/i.test(normalized)) {
    return { action: "RESET_STOPWATCH" };
  }
  if (/^(stop|cancel|arr[eê]te|annule) (?:the |le |la )?(timer|minuteur)/i.test(normalized)) {
    return { action: "STOP_TIMER" };
  }

  match = message.match(/(?:start|set|lance|demarre|démarre|mets)\s+(?:a\s+|un\s+|le\s+|la\s+)?(?:timer|minuteur)(?:\s+(?:for|pendant|pour))?\s+(.+)/i);
  if (match) {
    let seconds = 0;
    for (const part of match[1].matchAll(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|heures?|h|minutes?|min|secondes?|secs?|s)\b/gi)) {
      const unit = part[2].toLowerCase();
      const amount = Number(part[1].replace(",", "."));
      seconds += amount * (unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1);
    }
    if (!seconds) seconds = Number(match[1].match(/\d+/)?.[0]) * 60;
    if (seconds > 0) return { action: "START_TIMER", durationSeconds: Math.round(seconds) };
  }

  match = message.match(/^(?:add|create|schedule|set)\s+(?:(?:a|the)\s+)?(?:task|reminder|calendar reminder)\s+(.+)/i)
    || message.match(/^(?:ajoute|ajouter|cr[eé]e|planifie|programme)\s+(?:(?:un|une|le|la)\s+)?(?:rappel|t[aâ]che|evenement|événement)(?:\s+(?:dans|sur)\s+(?:mon\s+)?calendrier)?\s*(?:pour\s+)?(.+)/i)
    || message.match(/^(?:ajoute|ajouter|cr[eé]e|planifie|programme)\s+(?:dans|sur)\s+(?:mon\s+)?calendrier\s+(.+)/i);
  if (match) {
    const body = match[1].trim()
      .replace(/^(?:(?:in|on)\s+my\s+calendar|(?:dans|sur)\s+mon\s+calendrier)\s*/i, "")
      .replace(/^(?:to|for|pour)\s+/i, "");
    const weekdays = {
      sunday: 0, dimanche: 0, monday: 1, lundi: 1, tuesday: 2, mardi: 2,
      wednesday: 3, mercredi: 3, thursday: 4, jeudi: 4, friday: 5, vendredi: 5,
      saturday: 6, samedi: 6,
    };
    let date = todayString();
    if (/\b(tomorrow|demain)\b/i.test(body)) {
      date = tomorrowString();
    } else if (/\b(today|aujourd'hui|aujourd’hui)\b/i.test(body)) {
      date = todayString();
    } else {
      const weekdayMatch = body.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b/i);
      if (weekdayMatch) {
        const day = new Date();
        let add = (weekdays[weekdayMatch[1].toLowerCase()] - day.getDay() + 7) % 7;
        if (add === 0) add = 7;
        day.setDate(day.getDate() + add);
        date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      }
    }
    const timeMatch = body.match(/\b(?:at|around|à|vers)\s*(\d{1,2})(?::(\d{2})|h(\d{1,2})?)?\s*(am|pm)?\b|(?<!\w)(\d{1,2})(?::(\d{2})|h(\d{1,2})?)\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b/i);
    let time = "09:00";
    if (timeMatch) {
      let hour = Number(timeMatch[1] || timeMatch[5] || timeMatch[9]);
      const minute = Number(timeMatch[2] || timeMatch[3] || timeMatch[6] || timeMatch[7] || 0);
      const meridiem = (timeMatch[4] || timeMatch[8] || timeMatch[10])?.toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      if (hour < 24 && minute < 60) time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    let title = body
      .replace(/\b(?:tomorrow|demain|today|aujourd'hui|aujourd’hui)\b/gi, "")
      .replace(/\b(?:on|this|next|le)\s+(?=(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\b)/gi, "")
      .replace(/\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
      .replace(/(?:\b(?:at|around)\s*|(?:à|vers)\s*)\d{1,2}(?::\d{2}|h\d{0,2})?\s*(?:am|pm)?\b/gi, "")
      .replace(/\b\d{1,2}(?::\d{2}|h\d{0,2})\s*(?:am|pm)?\b/gi, "")
      .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, "")
      .replace(/^\s*(?:for|pour)\s+/i, "")
      .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
      .trim();
    if (!title) title = french ? "Nouveau rappel" : "New reminder";
    return { action: "ADD_TASK", title, date, time };
  }

  match = message.match(/^(?:delete|remove)\s+(?:the\s+)?(?:task|reminder)\s+(.+)/i)
    || message.match(/^(?:supprime|efface)\s+(?:le\s+)?(?:rappel|t[aâ]che)\s+(.+)/i);
  if (match) return { action: "DELETE_TASK", title: match[1].trim() };
  return null;
}

function performAction(action, language = "en") {
  const french = language === "fr";
  switch (action.action) {
    case "ADD_NOTE":
      notes.unshift({ id: Date.now(), content: action.content, createdAt: new Date().toLocaleDateString("en-US") });
      saveLists();
      renderNotes();
      return french ? `J'ai ajouté la note : ${action.content}.` : `I added the note: ${action.content}.`;
    case "DELETE_NOTE": {
      const index = action.id ? action.id - 1 : notes.findIndex((note) => note.content.toLowerCase().includes(String(action.keyword || "").toLowerCase()));
      if (index < 0 || index >= notes.length) return french ? "Je n'ai pas trouvé cette note." : "I could not find that note.";
      notes.splice(index, 1);
      saveLists();
      renderNotes();
      return french ? "J'ai supprimé cette note." : "I deleted that note.";
    }
    case "READ_NOTES":
      return notes.length
        ? french ? `Voici vos notes : ${notes.map((note) => note.content).join(". ")}.` : `Your notes are: ${notes.map((note) => note.content).join(". ")}.`
        : french ? "Vous n'avez pas encore de notes." : "You have no notes yet.";
    case "ADD_TASK":
      tasks.push({
        id: Date.now(),
        title: action.title,
        date: action.date || todayString(),
        time: action.time || "09:00",
        completed: false,
      });
      saveLists();
      renderTasks();
      return french ? `J'ai ajouté le rappel « ${action.title} » à votre calendrier.` : `I added the reminder “${action.title}” to your calendar.`;
    case "DELETE_TASK": {
      const index = tasks.findIndex((task) => task.title.toLowerCase() === action.title.toLowerCase());
      if (index < 0) return french ? "Je n'ai pas trouvé ce rappel dans le calendrier." : "I could not find that reminder in your calendar.";
      tasks.splice(index, 1);
      saveLists();
      renderTasks();
      return french ? "J'ai supprimé ce rappel." : "I deleted that reminder.";
    }
    case "START_STOPWATCH":
      startStopwatch();
      return french ? "J'ai démarré le chronomètre." : "I started the stopwatch.";
    case "STOP_STOPWATCH":
      pauseStopwatch();
      return french ? "J'ai mis le chronomètre en pause." : "I paused the stopwatch.";
    case "RESET_STOPWATCH":
      resetStopwatch();
      return french ? "J'ai remis le chronomètre à zéro." : "I reset the stopwatch.";
    case "START_TIMER":
      timerLanguage = french ? "fr" : "en";
      startTimer(action.durationSeconds);
      return french ? `J'ai démarré un minuteur de ${action.durationSeconds} secondes.` : `I started a timer for ${action.durationSeconds} seconds.`;
    case "STOP_TIMER":
      pauseTimer();
      stopAlarm();
      return french ? "J'ai arrêté le minuteur." : "I stopped the timer.";
    default:
      return "";
  }
}

function isValidAction(action) {
  switch (action.action) {
    case "ADD_NOTE":
      return typeof action.content === "string" && Boolean(action.content.trim());
    case "DELETE_NOTE":
      return (Number.isInteger(action.id) && action.id > 0)
        || (typeof action.keyword === "string" && Boolean(action.keyword.trim()));
    case "READ_NOTES":
    case "START_STOPWATCH":
    case "STOP_STOPWATCH":
    case "RESET_STOPWATCH":
    case "STOP_TIMER":
      return true;
    case "ADD_TASK":
      return typeof action.title === "string"
        && Boolean(action.title.trim())
        && (action.date === undefined || /^\d{4}-\d{2}-\d{2}$/.test(action.date))
        && (action.time === undefined || /^\d{2}:\d{2}$/.test(action.time));
    case "DELETE_TASK":
      return typeof action.title === "string" && Boolean(action.title.trim());
    case "START_TIMER":
      return Number.isFinite(action.durationSeconds) && action.durationSeconds > 0;
    default:
      return false;
  }
}

function getAssistantContext() {
  const history = chatMessages
    .slice(-8)
    .map((message) => ({
      role: message.sender,
      content: message.text.slice(0, 1000),
    }));
  return {
    currentDate: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    activePage: currentPage,
    notes: notes.map(({ content, createdAt }) => ({ content, createdAt })),
    tasks: tasks.map(({ title, date, time, completed }) => ({ title, date, time, completed })),
    clock: {
      currentTime: $("#digital-clock")?.textContent || "",
      stopwatch: $("#stopwatch-display")?.textContent || "",
      timer: $("#timer-display")?.textContent || "",
      alarmActive: Boolean($("#alarm-stop") && !$("#alarm-stop").classList.contains("hidden")),
      timerLanguage,
    },
    history,
  };
}

function getNavigationCommand(message) {
  const normalized = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const intent = /\b(go|open|show|take|navigate|switch|visit|head|return|back|va|ouvre|affiche|montre|aller|amene|ramene|reviens|revenir|retourner|retour|retourne|accede)\b/.test(normalized);
  if (!intent) return null;

  const page = /\b(home|homepage|chat|accueil)\b/.test(normalized)
    ? "home"
    : /\b(notes?)\b/.test(normalized)
      ? "notes"
      : /\b(calendar|calendrier|agenda)\b/.test(normalized)
        ? "calendar"
        : /\b(clock|horloge|timer|minuteur|stopwatch|chrono|chronometre)\b/.test(normalized)
          ? "clock"
          : null;
  if (!page) return null;

  const label = { home: "home", notes: "notes", calendar: "calendar", clock: "clock" }[page];
  const reply = getSelectedLanguage() === "fr"
    ? `J'ouvre la page ${label === "home" ? "d'accueil" : label}.`
    : `Opening the ${label} page.`;
  return { page, reply };
}

function isLogoutCommand(message) {
  const normalized = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
  return /\b(log\s*(?:me\s*)?out|sign\s*(?:me\s*)?out|logout|sign\s*off|logoff|disconnect(?:\s+me)?|deconnect(?:e|er|ion)(?:[- ]moi)?|quitte(?:[- ]la)?\s*session|ferme(?:[- ]la)?\s*session)\b/.test(normalized);
}

function isVoiceCallStopCommand(message) {
  const normalized = message.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
  return /\b(end|stop|close|hang up|finish)\s+(?:the\s+)?(?:voice\s+)?call\b/.test(normalized)
    || /\b(stop|pause|disable)\s+(?:the\s+)?(?:voice\s+)?listening\b/.test(normalized)
    || /\b(termine|arrete|stoppe|raccroche|finis)\s+(?:l'appel|l ecoute|la conversation vocale|l appel)\b/.test(normalized)
    || /\b(arrete|stoppe)\s+(?:d'?ecouter|l'assistant vocal)\b/.test(normalized);
}

async function askAssistant(message) {
  if (isLogoutCommand(message)) {
    return getSelectedLanguage() === "fr" ? "Je vous déconnecte." : "Logging you out.";
  }
  const navigation = getNavigationCommand(message);
  if (navigation) return navigation.reply;
  const directAction = commandAction(message);
  const language = getSelectedLanguage();
  if (directAction) return performAction(directAction, language);

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, language, context: getAssistantContext() }),
  });
  const responseText = await response.text();
  let data;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(
      response.status === 404
        ? "The AI chat endpoint was not found. Stop the old Vite server and restart it with npm run dev."
        : `The server returned an invalid response (HTTP ${response.status}). Restart the app and try again.`,
    );
  }
  if (!response.ok) {
    throw new Error(data.error || `AI request failed (HTTP ${response.status}).`);
  }
  const reply = typeof data.text === "string" ? data.text.trim() : "";
  if (data.action && typeof data.action.action === "string") {
    if (!isValidAction(data.action)) {
      return language === "fr"
        ? "Je n'ai pas pu effectuer cette action. Pouvez-vous reformuler votre demande ?"
        : "I could not complete that action. Could you rephrase your request?";
    }
    const actionReply = performAction(data.action, language);
    return reply || actionReply || (language === "fr" ? "C'est fait." : "Done.");
  }
  if (reply) return reply;
  throw new Error(language === "fr"
    ? "Je n'ai pas pu générer de réponse. Veuillez réessayer."
    : "I could not generate a reply. Please try again.");
}

async function sendMessage(message, recordUser = true) {
  const text = message.trim();
  if (!text || replyPending) return;
  if (voiceCallActive && isVoiceCallStopCommand(text)) {
    addChatMessage(text, "user");
    const reply = getSelectedLanguage() === "fr" ? "J'ai terminé l'appel vocal." : "The voice call has ended.";
    addChatMessage(reply, "assistant");
    stopVoiceCall("Call ended");
    speak(reply);
    return;
  }
  const submittedDuringVoiceCall = voiceCallActive;
  voiceTurnPending = voiceCallActive;
  pauseVoiceCallInput();
  if (isLogoutCommand(text)) {
    if (recordUser) addChatMessage(text, "user");
    addChatMessage(getSelectedLanguage() === "fr" ? "Je vous déconnecte." : "Logging you out.", "assistant");
    logout();
    return;
  }
  const navigation = getNavigationCommand(text);
  if (navigation && navigation.page !== currentPage) {
    if (recordUser) addChatMessage(text, "user");
    sessionStorage.setItem("greespeak-pending-message", JSON.stringify({
      message: navigation.reply,
      sender: "assistant",
      speak: true,
      language: getSelectedLanguage(),
    }));
    window.location.assign(`/${navigation.page}.html`);
    return;
  }
  const directAction = commandAction(text);
  const clockActions = new Set(["START_STOPWATCH", "STOP_STOPWATCH", "RESET_STOPWATCH", "START_TIMER", "STOP_TIMER"]);
  if (currentPage !== "clock" && directAction && clockActions.has(directAction.action)) {
    if (recordUser) addChatMessage(text, "user");
    sessionStorage.setItem("greespeak-pending-command", text);
    window.location.assign("/clock.html");
    return;
  }
  if (currentPage !== "home" && !directAction) {
    if (recordUser) addChatMessage(text, "user");
    sessionStorage.setItem("greespeak-pending-command", text);
    window.location.assign("/home.html");
    return;
  }
  replyPending = true;
  const sendButton = $('#chat-form button[type="submit"]');
  if (sendButton) sendButton.disabled = true;
  if (recordUser) addChatMessage(text, "user");
  if ($("#chat-input")) $("#chat-input").value = "";
  $("#voice-status").textContent = "Thinking...";
  $("#mic-button").classList.remove("listening", "speaking");
  $("#mic-button").classList.add("thinking");
  try {
    const reply = await askAssistant(text);
    addChatMessage(reply, "assistant");
    if (!submittedDuringVoiceCall || voiceCallActive) speak(reply);
  } catch (error) {
    const reply = error instanceof Error ? error.message : "The AI could not answer right now.";
    addChatMessage(reply, "assistant");
    $("#voice-status").textContent = "AI error — see the message above";
    if (voiceCallActive) resumeVoiceCallListening();
  } finally {
    replyPending = false;
    if (sendButton) sendButton.disabled = false;
    $("#mic-button").classList.remove("thinking");
  }
}

$("#chat-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage($("#chat-input").value);
});
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    $("#chat-input").value = button.dataset.prompt;
    $("#chat-input").focus();
  });
});
$("#delete-selected-messages")?.addEventListener("click", () => {
  deleteChatMessages(new Set(selectedMessageIds));
});
$("#clear-conversation")?.addEventListener("click", () => {
  deleteChatMessages(new Set(chatMessages.map((message) => message.id)));
});

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("#voice-status").textContent = "Live transcription is unavailable in this browser. Groq will transcribe after you pause.";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = voiceLanguageSelect.value;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    recognitionActive = true;
    if (!voiceCallActive) {
      recognition.stop();
      return;
    }
    $("#voice-status").textContent = "Listening...";
    $("#mic-button").classList.add("listening");
    clearTimeout(nativeSpeechTimeout);
    nativeSpeechTimeout = setTimeout(() => {
      if (!recognitionActive || voiceTurnPending) return;
      if (recorderState?.recorder) {
        recorderState.fallbackPending = true;
      } else {
        recorderState = { fallbackPending: true };
      }
      $("#voice-status").textContent = "Speech service is slow — switching to voice recording...";
      recognition.stop();
    }, voiceCallActive ? 15000 : 5000);
  };
  recognition.onresult = (event) => {
    if (recorderState?.manualStop || voiceTurnPending) return;
    clearTimeout(nativeSpeechTimeout);
    nativeSpeechTimeout = null;
    const words = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join(" ")
      .trim();
    if (!words) return;

    // Interim results update the input as words are recognized; final results replace them.
    $("#chat-input").value = words;
    $("#voice-status").textContent = "Speech detected — sending in 2 seconds...";
    clearTimeout(speechSendTimeout);
    speechSendTimeout = setTimeout(() => {
      speechSendTimeout = null;
      voiceTurnPending = voiceCallActive;
      sendMessage($("#chat-input").value);
    }, 2000);
  };
  recognition.onerror = (event) => {
    clearTimeout(nativeSpeechTimeout);
    nativeSpeechTimeout = null;
    if (event.error === "aborted" && !voiceCallActive) return;
    const errors = {
      "not-allowed": "Microphone access was denied. Allow microphone access in your browser's site settings, then reload the page.",
      "service-not-allowed": "Your browser blocked its speech recognition service. Try Chrome or Edge and check your browser's privacy settings.",
      "audio-capture": "No microphone was found. Check that a microphone is connected and selected.",
      "network": "Switching to Groq voice transcription...",
      "no-speech": "Switching to Groq voice transcription...",
      "language-not-supported": "Speech recognition for this language is unavailable. Choose the other voice language.",
      "aborted": "Listening was cancelled.",
    };
    if (event.error === "network" || event.error === "no-speech" || event.error === "service-not-allowed") {
      if (recorderState?.recorder) {
        recorderState.fallbackPending = true;
      } else {
        recorderState = { fallbackPending: true };
      }
      $("#voice-status").textContent = errors[event.error] || "Switching to Groq voice transcription...";
      return;
    }
    if (recorderState?.recorder?.state === "recording") {
      recorderState.discard = true;
      recorderState.recorder.stop();
    }
    const message = errors[event.error] || `Microphone error: ${event.error}. Check your browser permissions and try again.`;
    if (voiceCallActive && !["network", "no-speech", "service-not-allowed"].includes(event.error)) {
      stopVoiceCall(message);
      return;
    }
    $("#voice-status").textContent = message;
  };
  recognition.onend = () => {
    recognitionActive = false;
    if (recorderState?.fallbackPending) {
      if (recorderState.recorder) {
        recorderState.fallbackPending = false;
        recorderState.monitorOnly = false;
        $("#voice-status").textContent = "Listening... Speak now. It sends after a 2-second pause.";
      } else {
        recorderState = null;
        window.setTimeout(() => {
          if (!recorderState) startRecordedSpeech(false);
        }, 200);
      }
      return;
    }
    if (voiceCallActive && !voiceTurnPending && !replyPending && !recorderState) {
      resumeVoiceCallListening();
      return;
    }
    if (!recorderState && !speechSendTimeout) {
      $("#mic-button").classList.remove("listening");
      if ($("#voice-status").textContent === "Listening...") $("#voice-status").textContent = "Ready";
    }
  };
}

function audioBufferToWav(audioBuffer) {
  const sampleRate = 16000;
  const ratio = audioBuffer.sampleRate / sampleRate;
  const length = Math.floor(audioBuffer.length / ratio);
  const samples = new Float32Array(length);
  const channelCount = audioBuffer.numberOfChannels;

  for (let i = 0; i < length; i += 1) {
    const sourceIndex = Math.floor(i * ratio);
    let sample = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      sample += audioBuffer.getChannelData(channel)[sourceIndex] || 0;
    }
    samples[i] = sample / channelCount;
  }

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function transcribeRecording(blob) {
  const decodeContext = new AudioContext();
  try {
    const audioBuffer = await decodeContext.decodeAudioData(await blob.arrayBuffer());
    const wavBlob = audioBufferToWav(audioBuffer);
    const bytes = new Uint8Array(await wavBlob.arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    }
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: btoa(binary), language: getSelectedLanguage() }),
    });
    const responseText = await response.text();
    let result;
    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new Error("The voice transcription service returned an invalid response.");
    }
    if (!response.ok) throw new Error(result.error || `Transcription failed (HTTP ${response.status}).`);
    if (!result.text) throw new Error("No words were recognized. Please try speaking again.");
    $("#chat-input").value = result.text;
    $("#voice-status").textContent = "Transcription ready — sending...";
    await sendMessage(result.text);
  } finally {
    await decodeContext.close();
  }
}

async function startRecordedSpeech(monitorOnly = false) {
  if (recorderState) return false;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.AudioContext) {
    $("#voice-status").textContent = "Voice recording is not supported here. Use Chrome or Edge on localhost or HTTPS.";
    $("#mic-button").classList.remove("listening");
    return false;
  }

  let stream;
  let audioContext;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    await audioContext.resume();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const supportedType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = supportedType ? new MediaRecorder(stream, { mimeType: supportedType }) : new MediaRecorder(stream);
    const state = {
      stream,
      audioContext,
      analyser,
      recorder,
      chunks: [],
      startedAt: Date.now(),
      lastVoiceAt: 0,
      heardVoice: false,
      monitorOnly,
      discard: false,
      fallbackPending: false,
      manualStop: false,
      frame: 0,
    };
    recorderState = state;
    recorder.ondataavailable = (event) => {
      if (event.data.size) state.chunks.push(event.data);
    };
    recorder.onstop = async () => {
      cancelAnimationFrame(state.frame);
      state.stream.getTracks().forEach((track) => track.stop());
      await state.audioContext.close();
      if (recorderState === state) recorderState = null;
      $("#mic-button").classList.remove("listening");
      if (state.discard) return;
      const recording = new Blob(state.chunks, { type: recorder.mimeType });
      if (!state.heardVoice || recording.size === 0) {
        $("#voice-status").textContent = voiceCallActive
          ? "No speech detected. Listening again..."
          : "No speech detected. Click the orb and try again.";
        if (voiceCallActive) resumeVoiceCallListening();
        return;
      }
      $("#voice-status").textContent = "Transcribing your voice...";
      try {
        await transcribeRecording(recording);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not transcribe your voice.";
        $("#voice-status").textContent = message;
        addChatMessage(message, "assistant");
        if (voiceCallActive) resumeVoiceCallListening();
      }
    };
    recorder.start(250);
    $("#mic-button").classList.add("listening");
    $("#voice-status").textContent = "Listening... Start speaking.";

    const samples = new Uint8Array(analyser.fftSize);
    const listen = () => {
      if (recorderState !== state) return;
      analyser.getByteTimeDomainData(samples);
      let total = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        total += centered * centered;
      }
      const volume = Math.sqrt(total / samples.length);
      const now = Date.now();
      if (volume > 0.012) {
        state.heardVoice = true;
        state.lastVoiceAt = now;
      }
      if (state.heardVoice && !state.monitorOnly && now - state.lastVoiceAt >= 2000) {
        $("#voice-status").textContent = "Speech paused — sending...";
        recorder.stop();
        return;
      }
      if (now - state.startedAt >= 30000) {
        if (state.monitorOnly) {
          state.discard = true;
          recorder.stop();
          return;
        }
        $("#voice-status").textContent = "Maximum recording time reached — sending...";
        recorder.stop();
        return;
      }
      state.frame = requestAnimationFrame(listen);
    };
    state.frame = requestAnimationFrame(listen);
    return true;
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (audioContext && audioContext.state !== "closed") await audioContext.close();
    const message = error instanceof DOMException && error.name === "NotAllowedError"
      ? "Microphone access was denied. Allow microphone access in your browser's site settings."
      : error instanceof DOMException && error.name === "NotFoundError"
        ? "No microphone was found. Connect or select a microphone, then try again."
        : error instanceof Error
          ? error.message
          : "Could not start microphone recording.";
    $("#voice-status").textContent = message;
    $("#mic-button").classList.remove("listening");
    return false;
  }
}

$("#mic-button").addEventListener("click", () => {
  if (voiceCallActive) {
    stopVoiceCall();
    return;
  }
  startVoiceCall();
});
initSpeechRecognition();

$("#note-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#note-input");
  if (!input.value.trim()) return;
  notes.unshift({ id: Date.now(), content: input.value.trim(), createdAt: new Date().toLocaleDateString("en-US") });
  input.value = "";
  saveLists();
  renderNotes();
});

function renderNotes() {
  const list = $("#notes-list");
  if (!list) return;
  list.replaceChildren();
  if (!notes.length) {
    list.textContent = "No notes yet.";
    return;
  }
  notes.forEach((note, index) => {
    const item = document.createElement("article");
    item.className = "item";
    const content = document.createElement("div");
    content.className = "item-content";
    content.innerHTML = `<span class="item-meta">Note ${index + 1} · ${note.createdAt}</span>`;
    const text = document.createElement("span");
    text.textContent = note.content;
    content.append(text);
    const remove = document.createElement("button");
    remove.className = "delete-button";
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg><span>Delete</span>';
    remove.addEventListener("click", () => {
      notes = notes.filter((entry) => entry.id !== note.id);
      saveLists();
      renderNotes();
    });
    item.append(content, remove);
    list.append(item);
  });
}

if ($("#task-date")) $("#task-date").value = todayString();
$("#task-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = $("#task-title").value.trim();
  if (!title) return;
  tasks.push({ id: Date.now(), title, date: $("#task-date").value, time: $("#task-time").value || "09:00", completed: false });
  $("#task-title").value = "";
  saveLists();
  renderTasks();
});

function renderTasks() {
  if (!$("#tasks-list")) return;
  const list = $("#tasks-list");
  list.replaceChildren();
  if (!tasks.length) {
    list.textContent = "No tasks yet. Add one above or ask the assistant.";
    return;
  }
  const sortedTasks = [...tasks].sort((a, b) =>
    `${a.date || ""} ${a.time || ""}`.localeCompare(`${b.date || ""} ${b.time || ""}`),
  );
  const tasksByDate = new Map();
  sortedTasks.forEach((task) => {
    const date = task.date || "undated";
    if (!tasksByDate.has(date)) tasksByDate.set(date, []);
    tasksByDate.get(date).push(task);
  });

  tasksByDate.forEach((dayTasks, date) => {
    const day = document.createElement("section");
    day.className = "agenda-day";
    const heading = document.createElement("h2");
    heading.className = "agenda-date";
    if (date === "undated") {
      heading.textContent = "Date not set";
    } else {
      const dateValue = new Date(`${date}T00:00:00`);
      const relative = date === todayString() ? "Today" : date === tomorrowString() ? "Tomorrow" : "";
      heading.textContent = `${relative ? `${relative} · ` : ""}${Number.isNaN(dateValue.getTime()) ? date : dateValue.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`;
    }
    day.append(heading);

    dayTasks.forEach((task) => {
      const item = document.createElement("article");
      item.className = "item";
      const label = document.createElement("label");
      label.className = "item-content task-name";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "task-check";
      checkbox.checked = task.completed;
      const title = document.createElement("span");
      title.textContent = task.title;
      if (task.completed) title.className = "completed";
      checkbox.addEventListener("change", () => {
        task.completed = checkbox.checked;
        saveLists();
        renderTasks();
      });
      label.append(checkbox, title);
      const meta = document.createElement("span");
      meta.className = "item-meta";
      meta.textContent = task.time || "09:00";
      label.append(meta);
      const remove = document.createElement("button");
      remove.className = "delete-button";
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg><span>Delete</span>';
      remove.addEventListener("click", () => {
        tasks = tasks.filter((entry) => entry.id !== task.id);
        saveLists();
        renderTasks();
      });
      item.append(label, remove);
      day.append(item);
    });
    list.append(day);
  });
}

if ($("#digital-clock")) {
  const updateClock = () => {
    $("#digital-clock").textContent = new Date().toLocaleTimeString("en-US");
  };
  updateClock();
  setInterval(updateClock, 1000);
}

document.querySelectorAll(".clock-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const showTimer = tab.dataset.clock === "timer";
    document.querySelectorAll(".clock-tab").forEach((button) => button.classList.toggle("active", button === tab));
    $("#timer-panel").classList.toggle("hidden", !showTimer);
    $("#stopwatch-panel").classList.toggle("hidden", showTimer);
  });
});

function stopwatchTime() {
  const milliseconds = stopwatchElapsed + (stopwatchStarted ? Date.now() - stopwatchStarted : 0);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  const hundredths = Math.floor((milliseconds % 1000) / 10);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

function startStopwatch() {
  if (stopwatchStarted) return;
  stopwatchStarted = Date.now();
  saveClockState();
  stopwatchInterval = setInterval(() => { $("#stopwatch-display").textContent = stopwatchTime(); }, 40);
}

function pauseStopwatch() {
  if (!stopwatchStarted) return;
  stopwatchElapsed += Date.now() - stopwatchStarted;
  stopwatchStarted = 0;
  clearInterval(stopwatchInterval);
  $("#stopwatch-display").textContent = stopwatchTime();
  saveClockState();
}

function resetStopwatch() {
  clearInterval(stopwatchInterval);
  stopwatchStarted = 0;
  stopwatchElapsed = 0;
  laps = [];
  $("#stopwatch-display").textContent = "00:00:00.00";
  $("#laps-list").replaceChildren();
  saveClockState();
}

$("#stopwatch-start")?.addEventListener("click", startStopwatch);
$("#stopwatch-pause")?.addEventListener("click", pauseStopwatch);
$("#stopwatch-reset")?.addEventListener("click", resetStopwatch);
$("#stopwatch-lap")?.addEventListener("click", () => {
  if (!stopwatchStarted) return;
  laps.push(stopwatchTime());
  saveClockState();
  const lap = document.createElement("li");
  lap.textContent = `Lap ${laps.length}: ${laps[laps.length - 1]}`;
  $("#laps-list").prepend(lap);
});

function updateTimerDisplay(seconds) {
  const remaining = Math.max(0, Math.ceil(seconds));
  $("#timer-display").textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
}

function startTimer(seconds, resume = false) {
  if ((!seconds || seconds < 1) && !(resume && timerRemaining > 0)) return;
  document.querySelector('[data-clock="timer"]')?.click();
  stopAlarm();
  clearInterval(timerInterval);
  if (!resume || timerRemaining <= 0) timerRemaining = seconds;
  timerEnd = Date.now() + timerRemaining * 1000;
  updateTimerDisplay(timerRemaining);
  saveClockState();
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!alarmAudio && AudioContext) alarmAudio = new AudioContext();
  if (alarmAudio?.state === "suspended") alarmAudio.resume();
  timerInterval = setInterval(() => {
    timerRemaining = Math.max(0, (timerEnd - Date.now()) / 1000);
    updateTimerDisplay(timerRemaining);
    if (timerRemaining <= 0) {
      clearInterval(timerInterval);
      timerRemaining = 0;
      timerEnd = 0;
      saveClockState();
      startAlarm();
      speak(timerLanguage === "fr" ? "Le minuteur est terminé !" : "Timer finished!", timerLanguage);
    }
  }, 200);
}

function pauseTimer() {
  clearInterval(timerInterval);
  if (timerEnd) timerRemaining = Math.max(0, (timerEnd - Date.now()) / 1000);
  timerEnd = 0;
  updateTimerDisplay(timerRemaining);
  saveClockState();
}

function resetTimer() {
  clearInterval(timerInterval);
  timerEnd = 0;
  timerRemaining = 0;
  updateTimerDisplay(0);
  stopAlarm();
  saveClockState();
}

function startAlarm() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  document.querySelector('[data-clock="timer"]')?.click();
  alarmActive = true;
  saveClockState();
  if (!alarmAudio) alarmAudio = new AudioContext();
  alarmAudio.resume();
  $("#alarm-stop").classList.remove("hidden");
  clearInterval(alarmInterval);
  const beep = () => {
    const oscillator = alarmAudio.createOscillator();
    const volume = alarmAudio.createGain();
    oscillator.frequency.value = 880;
    volume.gain.value = 0.15;
    oscillator.connect(volume);
    volume.connect(alarmAudio.destination);
    oscillator.start();
    oscillator.stop(alarmAudio.currentTime + 0.3);
  };
  beep();
  alarmInterval = setInterval(beep, 650);
}

function stopAlarm() {
  clearInterval(alarmInterval);
  alarmActive = false;
  $("#alarm-stop").classList.add("hidden");
  saveClockState();
}

$("#timer-start")?.addEventListener("click", () => {
  if (timerRemaining > 0 && timerEnd === 0) {
    startTimer(timerRemaining, true);
    return;
  }
  const minutes = Math.max(0, Number($("#timer-minutes").value) || 0);
  const seconds = Math.min(59, Math.max(0, Number($("#timer-seconds").value) || 0));
  timerLanguage = getSelectedLanguage();
  startTimer(minutes * 60 + seconds);
});
$("#timer-pause")?.addEventListener("click", pauseTimer);
$("#timer-reset")?.addEventListener("click", resetTimer);
$("#alarm-stop")?.addEventListener("click", stopAlarm);

if (currentPage === "clock") {
  $("#stopwatch-display").textContent = stopwatchTime();
  laps.forEach((time, index) => {
    const lap = document.createElement("li");
    lap.textContent = `Lap ${index + 1}: ${time}`;
    $("#laps-list").append(lap);
  });
  if (stopwatchStarted) {
    stopwatchInterval = setInterval(() => { $("#stopwatch-display").textContent = stopwatchTime(); }, 40);
  }
  if (timerEnd) {
    timerRemaining = Math.max(0, (timerEnd - Date.now()) / 1000);
    if (timerRemaining > 0) {
      startTimer(timerRemaining, true);
    } else {
      timerEnd = 0;
      startAlarm();
      speak(timerLanguage === "fr" ? "Le minuteur est terminé !" : "Timer finished!", timerLanguage);
    }
  } else {
    updateTimerDisplay(timerRemaining);
    if (timerRemaining > 0) document.querySelector('[data-clock="timer"]')?.click();
    if (alarmActive && timerRemaining === 0) startAlarm();
  }
}

renderNotes();
renderTasks();
renderChatMessages();

const pendingMessage = sessionStorage.getItem("greespeak-pending-message");
const pendingMessageData = pendingMessage ? JSON.parse(pendingMessage) : null;
if (pendingMessageData) {
  sessionStorage.removeItem("greespeak-pending-message");
  const { message, sender, speak: shouldSpeak, language } = pendingMessageData;
  addChatMessage(message, sender);
  if (shouldSpeak) speak(message, language);
}

const pendingCommand = sessionStorage.getItem("greespeak-pending-command");
if (pendingCommand) {
  sessionStorage.removeItem("greespeak-pending-command");
  sendMessage(pendingCommand, false);
}

if (voiceCallActive && !pendingCommand && !pendingMessageData?.speak) {
  resumeVoiceCallListening();
}
