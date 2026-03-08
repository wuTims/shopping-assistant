import type {
  IdentifyResponse,
  SearchRequest,
  SearchResponse,
} from "@shopping-assistant/shared";
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES } from "@shopping-assistant/shared";

const BACKEND_URL = "http://localhost:8080";

console.log("[Shopping Assistant] Service worker started");

// Open side panel and trigger screenshot on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // Open side panel first
  await chrome.sidePanel.open({ tabId: tab.id });

  try {
    notifySidePanel(tab.id, { type: "identifying" });

    // Capture visible tab screenshot
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });

    // Send to backend for product identification
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
        message: "Failed to identify products on this page.",
      });
      return;
    }

    const identified: IdentifyResponse = await identifyRes.json();

    if (identified.products.length === 0) {
      notifySidePanel(tab.id, {
        type: "error",
        message: "No products found on this page.",
      });
      return;
    }

    if (identified.products.length === 1 || identified.pageType === "product_detail") {
      // Auto-select the single/main product
      const product = identified.products[0];
      notifySidePanel(tab.id, { type: "searching", product });
      await searchForProduct(tab.id, product, screenshotDataUrl, tab.url ?? "");
    } else {
      // Multiple products — let user pick
      notifySidePanel(tab.id, {
        type: "product_selection",
        products: identified.products,
        screenshotDataUrl,
        pageUrl: tab.url ?? "",
      });
    }
  } catch (err) {
    console.error("[Shopping Assistant] Screenshot flow failed:", err);
    if (tab.id) {
      notifySidePanel(tab.id, {
        type: "error",
        message: "Something went wrong. Please try again.",
      });
    }
  }
});

// Listen for product selection from side panel AND image clicks from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "select_product") {
    const { product, screenshotDataUrl, pageUrl } = message;
    const effectiveTabId = message.tabId ?? sender.tab?.id;
    if (!effectiveTabId) return false;
    searchForProduct(effectiveTabId, product, screenshotDataUrl, pageUrl).then(() =>
      sendResponse({ status: "ok" }),
    );
    return true;
  }

  if (message.type === "IMAGE_CLICKED") {
    const tabId = sender.tab?.id;
    if (!tabId) return false;

    const { imageUrl, titleHint, pageUrl } = message;

    (async () => {
      await chrome.sidePanel.open({ tabId });

      const product = {
        name: titleHint || "Product",
        price: null as number | null,
        currency: null as string | null,
      };

      await searchForProduct(tabId, product, "", pageUrl, imageUrl);
      sendResponse({ status: "ok" });
    })();

    return true;
  }

  return false;
});

async function searchForProduct(
  tabId: number,
  product: { name: string; price: number | null; currency: string | null },
  screenshotDataUrl: string,
  pageUrl: string,
  imageUrl?: string,
): Promise<void> {
  // Check cache first
  const cacheKey = `search:${product.name}:${pageUrl}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    notifySidePanel(tabId, { type: "results", response: cached });
    return;
  }

  try {
    const searchReq: SearchRequest = {
      imageUrl: imageUrl || null,
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

    notifySidePanel(tabId, { type: "searching", product });

    const searchRes = await fetch(`${BACKEND_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchReq),
    });

    if (!searchRes.ok) {
      notifySidePanel(tabId, {
        type: "error",
        message: "Search failed. Please try again.",
      });
      return;
    }

    const response: SearchResponse = await searchRes.json();
    await setCache(cacheKey, response);
    notifySidePanel(tabId, { type: "results", response });
  } catch (err) {
    console.error("[Shopping Assistant] Search failed:", err);
    notifySidePanel(tabId, {
      type: "error",
      message: "Search failed. Please try again.",
    });
  }
}

function notifySidePanel(tabId: number, message: Record<string, unknown>): void {
  chrome.runtime.sendMessage({ target: "sidepanel", tabId, ...message }).catch(() => {
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
  // LRU eviction
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
