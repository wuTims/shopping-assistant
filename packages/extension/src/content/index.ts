import { detectProducts } from "./detection";
import { injectOverlays, removeOverlays } from "./overlay";

console.log("[Personal Shopper] Content script loaded");

let lastUrl = location.href;

function run(): void {
  const products = detectProducts();
  if (products.length > 0) {
    console.log(`[Personal Shopper] Detected ${products.length} product(s)`);
    injectOverlays(products);
    chrome.runtime.sendMessage({ type: "PRODUCTS_DETECTED", products });
  }
}

// Initial detection
run();

// SPA navigation: intercept pushState/replaceState (popstate only fires on back/forward)
function handleNavigation(): void {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  removeOverlays();
  setTimeout(run, 500);
}

const origPushState = history.pushState.bind(history);
const origReplaceState = history.replaceState.bind(history);

history.pushState = function (...args: Parameters<typeof history.pushState>) {
  origPushState(...args);
  handleNavigation();
};
history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
  origReplaceState(...args);
  handleNavigation();
};

window.addEventListener("popstate", handleNavigation);

// Mutation observer as fallback for frameworks that update DOM without History API
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(handleNavigation, 300);
  }
});

observer.observe(document.body, { childList: true, subtree: true });
