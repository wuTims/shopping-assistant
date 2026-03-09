import type {
  IdentifyResponse,
  IdentifiedProduct,
  SearchRequest,
  SearchResponse,
  ProductDisplayInfo,
  ChatRequest,
} from "@shopping-assistant/shared";
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES } from "@shopping-assistant/shared";

const BACKEND_URL = "http://localhost:8080";

console.log("[Shopping Assistant] Service worker started");

// State tracking for GET_STATE
let lastSidePanelMessage: Record<string, unknown> | null = null;
let activeTabId: number | null = null;

// Open side panel and trigger screenshot on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  activeTabId = tab.id;

  await chrome.sidePanel.open({ tabId: tab.id });

  try {
    notifySidePanel(tab.id, { type: "identifying" });

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });

    const identifyRes = await fetch(`${BACKEND_URL}/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        screenshot: screenshotDataUrl,
        pageUrl: tab.url ?? "",
      }),
    });

    if (!identifyRes.ok) {
      notifySidePanel(tab.id, {
        type: "error",
        product: null,
        message: "Failed to identify products on this page.",
      });
      return;
    }

    const identified: IdentifyResponse = await identifyRes.json();

    if (identified.products.length === 0) {
      notifySidePanel(tab.id, {
        type: "error",
        product: null,
        message: "No products found on this page.",
      });
      return;
    }

    if (identified.products.length === 1 || identified.pageType === "product_detail") {
      const product = identified.products[0];
      const displayProduct = identifiedToDisplay(product);
      notifySidePanel(tab.id, { type: "searching", product: displayProduct });
      await searchForProduct(tab.id, displayProduct, screenshotDataUrl, tab.url ?? "");
    } else {
      notifySidePanel(tab.id, {
        type: "product_selection",
        products: identified.products,
        screenshotDataUrl,
        pageUrl: tab.url ?? "",
        tabId: tab.id,
      });
    }
  } catch (err) {
    console.error("[Shopping Assistant] Screenshot flow failed:", err);
    if (tab.id) {
      notifySidePanel(tab.id, {
        type: "error",
        product: null,
        message: "Something went wrong. Please try again.",
      });
    }
  }
});

// Listen for messages from side panel and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    sendResponse(lastSidePanelMessage);
    return false;
  }

  if (message.type === "select_product") {
    const { product, screenshotDataUrl, pageUrl } = message;
    const effectiveTabId = message.tabId ?? sender.tab?.id;
    if (!effectiveTabId) return false;
    activeTabId = effectiveTabId;
    const displayProduct = identifiedToDisplay(product);
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

    const { imageUrl, titleHint, pageUrl } = message;

    (async () => {
      await chrome.sidePanel.open({ tabId });

      const product: ProductDisplayInfo = {
        name: titleHint || "Product",
        price: null,
        currency: null,
        imageUrl,
      };

      notifySidePanel(tabId, { type: "searching", product });
      await searchForProduct(tabId, product, "", pageUrl, imageUrl);
      sendResponse({ status: "ok" });
    })();

    return true;
  }

  if (message.type === "CHAT_REQUEST") {
    const { request } = message as { request: ChatRequest };
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!res.ok) throw new Error("Chat request failed");
        const data = await res.json();
        if (activeTabId) {
          notifySidePanel(activeTabId, { type: "chat_response", reply: data.reply });
        }
      } catch {
        if (activeTabId) {
          notifySidePanel(activeTabId, { type: "chat_error", error: "Chat failed" });
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
    imageUrl: product.imageRegion
      ? `data:image/png;base64,${product.imageRegion}`
      : undefined,
  };
}

async function searchForProduct(
  tabId: number,
  product: ProductDisplayInfo,
  screenshotDataUrl: string,
  pageUrl: string,
  imageUrl?: string,
): Promise<void> {
  const cacheKey = `search:${product.name}:${pageUrl}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    const enriched = enrichProduct(product, cached);
    notifySidePanel(tabId, { type: "results", product: enriched, response: cached });
    return;
  }

  try {
    const searchReq: SearchRequest = {
      imageUrl: imageUrl ?? product.imageUrl ?? null,
      imageBase64: !imageUrl && screenshotDataUrl
        ? (screenshotDataUrl.includes(",")
          ? screenshotDataUrl.split(",")[1]
          : screenshotDataUrl)
        : null,
      title: product.name !== "Product" ? product.name : null,
      price: product.price,
      currency: product.currency,
      sourceUrl: pageUrl,
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
  return {
    ...product,
    name: response.originalProduct.title ?? product.name,
    imageUrl: product.imageUrl || response.originalProduct.imageUrl || undefined,
  };
}

function notifySidePanel(tabId: number, message: Record<string, unknown>): void {
  const full = { target: "sidepanel", tabId, ...message };
  lastSidePanelMessage = full;
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
