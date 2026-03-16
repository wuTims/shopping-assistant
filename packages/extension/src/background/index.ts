import type {
  IdentifyResponse,
  IdentifiedProduct,
  SearchRequest,
  SearchResponse,
  ProductDisplayInfo,
  ProductIdentification,
  ChatRequest,
} from "@shopping-assistant/shared";
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES } from "@shopping-assistant/shared";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080";

console.log("[Shopping Assistant] Service worker started");

// Per-tab state snapshots for GET_STATE (only view-level messages, not transient chat events)
const tabState = new Map<number, Record<string, unknown>>();
let activeTabId: number | null = null;

/** Message types that represent a view state worth restoring on panel reopen */
const VIEW_STATE_TYPES = new Set([
  "empty",
  "identifying",
  "product_selection",
  "searching",
  "results",
  "error",
]);

async function ensureContentScript(tabId: number): Promise<void> {
  const scriptFiles = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (scriptFiles.length === 0) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: scriptFiles,
  });
}

// Open side panel and put the current tab into selection mode on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  activeTabId = tab.id;

  try {
    await ensureContentScript(tab.id);
    await chrome.sidePanel.open({ tabId: tab.id });
    notifySidePanel(tab.id, { type: "empty" });
  } catch (err) {
    console.error("[Shopping Assistant] Failed to open side panel:", err);
  }
});

// Listen for messages from side panel and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    const tabId = message.tabId ?? activeTabId;
    sendResponse(tabId ? tabState.get(tabId) ?? null : null);
    return false;
  }

  if (message.type === "select_product") {
    const { product, screenshotDataUrl, pageUrl } = message;
    const effectiveTabId = message.tabId ?? sender.tab?.id;
    if (!effectiveTabId) return false;
    activeTabId = effectiveTabId;
    const displayProduct = {
      ...identifiedToDisplay(product),
      productUrl: pageUrl,
    };
    notifySidePanel(effectiveTabId, { type: "searching", product: displayProduct });
    searchForProduct(effectiveTabId, displayProduct, screenshotDataUrl, pageUrl).then(() =>
      sendResponse({ status: "ok" }),
    );
    return true;
  }

  if (message.type === "IMAGE_CLICKED") {
    const tabId = sender.tab?.id;
    if (!tabId) return false;
    activeTabId = tabId;

    const { imageUrl, imageBase64, titleHint, pageUrl, productLink, price, currency } = message;

    (async () => {
      await chrome.sidePanel.open({ tabId });

      // Use titleHint if available; otherwise fall back to a price label so
      // the UI never shows a generic "Product" placeholder.
      let fallbackName = "";
      if (!titleHint && typeof price === "number") {
        const sym = currency === "GBP" ? "£" : currency === "EUR" ? "€" : "$";
        fallbackName = `${sym}${price % 1 === 0 ? price : price.toFixed(2)}`;
      }

      const product: ProductDisplayInfo = {
        name: titleHint || fallbackName,
        price: typeof price === "number" ? price : null,
        currency: typeof currency === "string" ? currency : null,
        imageUrl,
        productUrl: productLink ?? pageUrl,
        // Store base64 as display image for UI
        displayImageDataUrl: imageBase64 ? `data:image/png;base64,${imageBase64}` : undefined,
      };

      notifySidePanel(tabId, { type: "searching", product });
      await searchForProduct(tabId, product, "", pageUrl, imageUrl, undefined, productLink);
      sendResponse({ status: "ok" });
    })();

    return true;
  }

  if (message.type === "CHAT_REQUEST") {
    const { request, tabId: chatTabId } = message as { request: ChatRequest; tabId?: number };
    const replyTabId = chatTabId ?? sender.tab?.id ?? activeTabId;
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          if (data && typeof data.reply === "string" && data.reply) {
            if (replyTabId) {
              notifySidePanel(replyTabId, { type: "chat_response", reply: data.reply });
            }
            sendResponse({ status: "ok" });
            return;
          }
          throw new Error(`Chat request failed (${res.status})`);
        }
        if (replyTabId) {
          notifySidePanel(replyTabId, { type: "chat_response", reply: data.reply });
        }
      } catch {
        if (replyTabId) {
          notifySidePanel(replyTabId, { type: "chat_error", error: "Chat failed" });
        }
      }
      sendResponse({ status: "ok" });
    })();
    return true;
  }

  return false;
});

function identifiedToDisplay(product: IdentifiedProduct): ProductDisplayInfo {
  return {
    name: product.name,
    price: product.price,
    currency: product.currency,
    // imageRegion is raw base64 — store as displayImageDataUrl for UI only.
    // Do NOT put it in imageUrl, which the backend expects to be HTTP/S.
    displayImageDataUrl: product.imageRegion
      ? `data:image/png;base64,${product.imageRegion}`
      : undefined,
  };
}

async function computeImageHash(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function searchForProduct(
  tabId: number,
  product: ProductDisplayInfo,
  screenshotDataUrl: string,
  pageUrl: string,
  imageUrl?: string,
  identification?: ProductIdentification | null,
  productLink?: string | null,
): Promise<void> {
  const imageInput = imageUrl || screenshotDataUrl;
  const imageHash = imageInput ? await computeImageHash(imageInput) : "";
  const cacheKey = `search:${product.name}:${pageUrl}:${imageHash}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    const enriched = enrichProduct(product, cached);
    notifySidePanel(tabId, { type: "results", product: enriched, response: cached });
    return;
  }

  try {
    // Prefer cropped product image (displayImageDataUrl) over full screenshot for imageBase64.
    // ALWAYS send base64 when available — backend server-side fetch of imageUrl often fails
    // (CORS, CDN anti-hotlinking, data: URLs, etc.)
    const croppedBase64 = product.displayImageDataUrl?.split(",")[1];
    const fallbackBase64 = screenshotDataUrl
      ? (screenshotDataUrl.includes(",") ? screenshotDataUrl.split(",")[1] : screenshotDataUrl)
      : null;
    const searchReq: SearchRequest = {
      imageUrl: imageUrl ?? product.imageUrl ?? null,
      imageBase64: croppedBase64 ?? fallbackBase64 ?? null,
      title: product.name || null,
      price: product.price,
      currency: product.currency,
      sourceUrl: pageUrl,
      productLink: productLink ?? null,
      identification: identification ?? null,
    };

    const searchRes = await fetch(`${BACKEND_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchReq),
    });

    if (!searchRes.ok) {
      notifySidePanel(tabId, {
        type: "error",
        product,
        message: "Search failed. Please try again.",
      });
      return;
    }

    const response: SearchResponse = await searchRes.json();
    await setCache(cacheKey, response);
    const enriched = enrichProduct(product, response);
    notifySidePanel(tabId, { type: "results", product: enriched, response });
  } catch (err) {
    console.error("[Shopping Assistant] Search failed:", err);
    notifySidePanel(tabId, {
      type: "error",
      product,
      message: "Search failed. Please try again.",
    });
  }
}

function enrichProduct(product: ProductDisplayInfo, response: SearchResponse): ProductDisplayInfo {
  // Prefer the title the extension extracted; fall back to the AI-identified
  // description so the UI never stays on a bare price or empty string.
  let name = response.originalProduct.title;
  if (!name) {
    const desc = response.originalProduct.identification?.description;
    if (desc) {
      name = desc.length > 60 ? `${desc.slice(0, 57)}…` : desc;
    }
  }
  return {
    ...product,
    name: name ?? product.name,
    imageUrl: product.imageUrl || response.originalProduct.imageUrl || undefined,
    productUrl: product.productUrl,
  };
}

function notifySidePanel(tabId: number, message: Record<string, unknown>): void {
  const full = { target: "sidepanel", tabId, ...message };
  // Only persist view-level state, not transient chat events
  if (VIEW_STATE_TYPES.has(message.type as string)) {
    tabState.set(tabId, full);
  }
  chrome.runtime.sendMessage(full).catch(() => {
    // Side panel may not be ready yet
  });
}

async function getCached(key: string): Promise<SearchResponse | null> {
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return null;
  const entry = data[key] as { response: SearchResponse; cachedAt: number };
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.response;
}

async function setCache(key: string, response: SearchResponse): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const searchKeys = Object.keys(all).filter((k) => k.startsWith("search:"));
  if (searchKeys.length >= CACHE_MAX_ENTRIES) {
    const oldest = searchKeys
      .map((k) => ({ key: k, cachedAt: (all[k] as { cachedAt: number }).cachedAt }))
      .sort((a, b) => a.cachedAt - b.cachedAt);
    const toRemove = oldest.slice(0, searchKeys.length - CACHE_MAX_ENTRIES + 1).map((e) => e.key);
    await chrome.storage.local.remove(toRemove);
  }
  await chrome.storage.local.set({ [key]: { response, cachedAt: Date.now() } });
}
