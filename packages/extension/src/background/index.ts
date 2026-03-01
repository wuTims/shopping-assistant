console.log("[Shopping Assistant] Service worker started");

// Open side panel on extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Shopping Assistant] Message received:", message);
  // TODO: Route messages to side panel, handle search orchestration
  sendResponse({ status: "ok" });
  return true;
});
