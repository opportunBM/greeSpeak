const page = document.body.dataset.page;
const allowedPages = new Set(["home", "notes", "calendar", "clock"]);

async function initializePage() {
  if (!sessionStorage.getItem("greespeak-user")) {
    window.location.replace("/");
    return;
  }
  if (!allowedPages.has(page)) {
    window.location.replace("/home.html");
    return;
  }

  const [shellResponse, pageResponse] = await Promise.all([
    fetch("/pages/app-shell.html"),
    fetch(`/pages/${page}.html`),
  ]);
  if (!shellResponse.ok || !pageResponse.ok) {
    throw new Error(`Could not load the ${page} page.`);
  }
  const [shell, content] = await Promise.all([shellResponse.text(), pageResponse.text()]);
  document.querySelector("#app-root").innerHTML = shell.replace("<!-- page content -->", content);
  document.title = `${page[0].toUpperCase()}${page.slice(1)} | greeSpeak`;
  await import("./main.js");
}

initializePage().catch((error) => {
  const root = document.querySelector("#app-root");
  root.textContent = error instanceof Error ? error.message : "The page could not be loaded.";
});
