import type {
  DetectedProduct,
  SearchRequest,
  SearchResponse,
  ChatRequest,
  ChatResponse,
  PanelState,
  ContentToBackgroundMessage,
  SidePanelToBackgroundMessage,
} from "@shopping-assistant/shared";
import { SEARCH_TIMEOUT_MS, CHAT_TIMEOUT_MS } from "@shopping-assistant/shared";
import { getCached, setCached, cleanupStaleEntries } from "./cache";

console.log("[Personal Shopper] Service worker started");

const BACKEND_URL = "http://localhost:8080";

// ── Current state (in-memory, survives while SW is alive) ──
let currentState: PanelState = {
  view: "empty",
  product: null,
  response: null,
  error: null,
  loadingPhase: null,
};

// ── Lifecycle ──

chrome.runtime.onInstalled.addListener(() => {
  cleanupStaleEntries();
});

chrome.runtime.onStartup.addListener(() => {
  cleanupStaleEntries();
});

// Open side panel on extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// ── Message handling ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const msg = message as ContentToBackgroundMessage | SidePanelToBackgroundMessage;

  switch (msg.type) {
    case "PRODUCT_CLICKED":
      handleProductClicked(msg.product, sender.tab?.id);
      sendResponse({ status: "ok" });
      break;

    case "PRODUCTS_DETECTED":
      // Could update badge count, but not needed for MVP
      sendResponse({ status: "ok" });
      break;

    case "GET_STATE":
      sendResponse(currentState);
      break;

    case "CHAT_REQUEST":
      handleChatRequest(msg.request);
      sendResponse({ status: "ok" });
      break;

    case "GET_BACKEND_URL":
      sendResponse({ url: BACKEND_URL });
      break;

    default:
      sendResponse({ status: "unknown_message" });
  }

  return true; // keep channel open for async
});

// ── Search flow ──

async function handleProductClicked(product: DetectedProduct, tabId?: number): Promise<void> {
  // Open side panel
  if (tabId) {
    chrome.sidePanel.open({ tabId });
  }

  // Check cache first
  const cached = await getCached(product.id);
  if (cached) {
    currentState = { view: "results", product, response: cached, error: null, loadingPhase: null };
    broadcast({ type: "SEARCH_COMPLETE", product, response: cached });
    return;
  }

  // Cache miss — start search
  currentState = { view: "loading", product, response: null, error: null, loadingPhase: 1 };
  broadcast({ type: "SEARCH_STARTED", product });

  try {
    const request: SearchRequest = {
      imageUrl: product.imageUrl,
      imageBase64: null,
      title: product.title,
      price: product.price,
      currency: product.currency,
      sourceUrl: product.pageUrl,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    const res = await fetch(`${BACKEND_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error((errBody as { message?: string }).message ?? `Backend returned ${res.status}`);
    }

    const response: SearchResponse = await res.json();
    await setCached(product.id, response);

    currentState = { view: "results", product, response, error: null, loadingPhase: null };
    broadcast({ type: "SEARCH_COMPLETE", product, response });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Search failed";
    currentState = { view: "error", product, response: null, error: errorMsg, loadingPhase: null };
    broadcast({ type: "SEARCH_ERROR", product, error: errorMsg });
  }
}

// ── Chat flow ──

async function handleChatRequest(request: ChatRequest): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

    const res = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Chat failed with status ${res.status}`);
    }

    const data: ChatResponse = await res.json();
    broadcast({ type: "CHAT_RESPONSE", reply: data.reply });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Chat failed";
    broadcast({ type: "CHAT_ERROR", error: errorMsg });
  }
}

// ── Broadcast to side panel ──

function broadcast(message: Record<string, unknown>): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open — safe to ignore
  });
}
