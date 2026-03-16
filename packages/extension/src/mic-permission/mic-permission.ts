(() => {
  const btn = document.getElementById("grant-btn") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLDivElement;

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Requesting…";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop tracks immediately — we just needed the permission grant
      stream.getTracks().forEach((t) => t.stop());

      statusEl.textContent = "Microphone access granted!";
      statusEl.className = "status granted";

      // Notify the opener (side panel) that permission was granted
      chrome.runtime.sendMessage({ type: "MIC_PERMISSION_GRANTED" });

      // Auto-close after a brief moment so the user sees confirmation
      setTimeout(() => window.close(), 600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      statusEl.textContent = `Denied: ${msg}`;
      statusEl.className = "status denied";
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  });
})();
