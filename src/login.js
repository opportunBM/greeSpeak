const form = document.querySelector("#login-form");
const submitButton = form.querySelector('button[type="submit"]');
const errorMessage = document.querySelector("#login-error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  errorMessage.textContent = "";

  try {
    const response = await fetch("/users.json");
    if (!response.ok) throw new Error("The user account could not be loaded.");
    const users = await response.json();
    if (!Array.isArray(users)) throw new Error("The user account data is invalid.");

    const email = document.querySelector("#login-email").value.trim().toLowerCase();
    const password = document.querySelector("#login-password").value;
    const user = users.find((item) => item.email?.toLowerCase() === email && item.password === password);

    if (!user) {
      errorMessage.textContent = "Incorrect email or password.";
      document.querySelector("#login-password").value = "";
      document.querySelector("#login-password").focus();
      return;
    }

    sessionStorage.setItem("greespeak-user", user.username);
    sessionStorage.setItem("greespeak-pending-message", JSON.stringify({
      message: `Hello ${user.username}, how can i help you today??`,
      sender: "assistant",
      speak: true,
      language: "en",
    }));
    window.location.assign("/home.html");
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : "Sign-in failed. Please try again.";
  } finally {
    submitButton.disabled = false;
  }
});
