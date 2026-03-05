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

// SPA navigation observer: re-detect on URL changes
const observer = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    removeOverlays();
    // Small delay to let new page content render
    setTimeout(run, 500);
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// Also handle popstate for History API navigation
window.addEventListener("popstate", () => {
  removeOverlays();
  setTimeout(run, 500);
});
