# Phase 2: Extension Implementation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the Chrome extension — product detection on Amazon/eBay, service worker message routing with cache, and the full side panel React UI with results and text chat.

**Architecture:** Content script detects products via DOM heuristics → injects overlay icons → user clicks → service worker checks cache and calls backend → side panel displays results and chat.

**Tech Stack:** TypeScript, React 19, Vite 6 + CRXJS, Chrome Extension MV3 APIs (sidePanel, storage, runtime messaging)

**Prerequisites:** Phase 1 complete — backend running with working `/search` and `/chat` endpoints.

**Validation gate:** Phase is complete when you can load the extension in Chrome, visit an Amazon product page, click the overlay, see search results in the side panel, and chat about them.

---

### Task 1: Implement Content Script — Product Detection

**Files:**
- Rewrite: `packages/extension/src/content/index.ts`

**Step 1: Implement DOM heuristics for product detection**

Replace the entire contents of `packages/extension/src/content/index.ts` with:

```typescript
import type { DetectedProduct } from "@shopping-assistant/shared";
import {
  MAX_OVERLAYS_PER_PAGE,
  MIN_IMAGE_SIZE_PX,
  OVERLAY_ICON_SIZE_PX,
  OVERLAY_ICON_HOVER_SIZE_PX,
} from "@shopping-assistant/shared";

console.log("[Shopping Assistant] Content script loaded");

// ===== Detection Heuristics =====

function detectProducts(): DetectedProduct[] {
  const products: DetectedProduct[] = [];

  // Strategy 1: JSON-LD / schema.org Product markup
  const jsonLdProducts = detectFromJsonLd();
  products.push(...jsonLdProducts);

  // Strategy 2: Open Graph product tags
  if (products.length === 0) {
    const ogProducts = detectFromOpenGraph();
    products.push(...ogProducts);
  }

  // Strategy 3: Amazon-specific selectors
  if (products.length === 0 && isAmazon()) {
    const amazonProducts = detectFromAmazon();
    products.push(...amazonProducts);
  }

  // Strategy 4: eBay-specific selectors
  if (products.length === 0 && isEbay()) {
    const ebayProducts = detectFromEbay();
    products.push(...ebayProducts);
  }

  return products.slice(0, MAX_OVERLAYS_PER_PAGE);
}

function detectFromJsonLd(): DetectedProduct[] {
  const products: DetectedProduct[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (item["@type"] === "Product" || item["@type"]?.includes?.("Product")) {
          const imageUrl = extractImageUrl(item.image);
          if (!imageUrl) continue;

          const imageEl = findImageElement(imageUrl);
          if (!imageEl) continue;

          const price = extractSchemaPrice(item);

          products.push({
            id: hashString(imageUrl + window.location.href),
            imageUrl,
            title: item.name ?? null,
            price: price?.value ?? null,
            currency: price?.currency ?? null,
            pageUrl: window.location.href,
            marketplace: window.location.hostname.replace("www.", ""),
            schemaData: item,
            boundingRect: imageEl.getBoundingClientRect(),
            detectedAt: Date.now(),
          });
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  return products;
}

function detectFromOpenGraph(): DetectedProduct[] {
  const ogImage = getMeta("og:image");
  const ogTitle = getMeta("og:title");
  const ogPrice = getMeta("og:price:amount") ?? getMeta("product:price:amount");
  const ogCurrency = getMeta("og:price:currency") ?? getMeta("product:price:currency");

  if (!ogImage) return [];

  const imageEl = findImageElement(ogImage);
  if (!imageEl) return [];

  return [{
    id: hashString(ogImage + window.location.href),
    imageUrl: ogImage,
    title: ogTitle,
    price: ogPrice ? parseFloat(ogPrice) : null,
    currency: ogCurrency,
    pageUrl: window.location.href,
    marketplace: window.location.hostname.replace("www.", ""),
    schemaData: null,
    boundingRect: imageEl.getBoundingClientRect(),
    detectedAt: Date.now(),
  }];
}

function detectFromAmazon(): DetectedProduct[] {
  const titleEl = document.getElementById("productTitle");
  const title = titleEl?.textContent?.trim() ?? null;

  const priceEl =
    document.querySelector(".a-price .a-offscreen") ??
    document.getElementById("priceblock_ourprice") ??
    document.querySelector("#corePrice_feature_div .a-offscreen");
  const priceText = priceEl?.textContent?.trim();
  const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, "")) : null;

  const imageEl =
    (document.getElementById("landingImage") as HTMLImageElement) ??
    (document.getElementById("imgBlkFront") as HTMLImageElement) ??
    (document.querySelector("#imageBlock img") as HTMLImageElement);

  if (!imageEl?.src) return [];

  return [{
    id: hashString(imageEl.src + window.location.href),
    imageUrl: imageEl.src,
    title,
    price: price && !isNaN(price) ? price : null,
    currency: price !== null ? "USD" : null,
    pageUrl: window.location.href,
    marketplace: "amazon.com",
    schemaData: null,
    boundingRect: imageEl.getBoundingClientRect(),
    detectedAt: Date.now(),
  }];
}

function detectFromEbay(): DetectedProduct[] {
  const titleEl = document.querySelector(".x-item-title__mainTitle span");
  const title = titleEl?.textContent?.trim() ?? null;

  const priceEl = document.querySelector(".x-price-primary span");
  const priceText = priceEl?.textContent?.trim();
  const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, "")) : null;

  const imageEl = document.querySelector(
    ".ux-image-carousel-item img, .image-treatment img",
  ) as HTMLImageElement | null;

  if (!imageEl?.src) return [];

  return [{
    id: hashString(imageEl.src + window.location.href),
    imageUrl: imageEl.src,
    title,
    price: price && !isNaN(price) ? price : null,
    currency: price !== null ? "USD" : null,
    pageUrl: window.location.href,
    marketplace: "ebay.com",
    schemaData: null,
    boundingRect: imageEl.getBoundingClientRect(),
    detectedAt: Date.now(),
  }];
}

// ===== Overlay Injection =====

function injectOverlays(products: DetectedProduct[]): void {
  for (const product of products) {
    const imageEl = findImageElement(product.imageUrl);
    if (!imageEl) continue;

    if (imageEl.dataset.shoppingAssistant) continue;
    imageEl.dataset.shoppingAssistant = "true";

    const container = imageEl.parentElement;
    if (!container) continue;

    const containerStyle = getComputedStyle(container);
    if (containerStyle.position === "static") {
      container.style.position = "relative";
    }

    const overlay = document.createElement("button");
    overlay.className = "shopping-assistant-overlay";
    overlay.setAttribute("aria-label", "Find cheaper alternatives");
    overlay.title = "Find cheaper alternatives";
    overlay.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;

    Object.assign(overlay.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      width: `${OVERLAY_ICON_SIZE_PX}px`,
      height: `${OVERLAY_ICON_SIZE_PX}px`,
      borderRadius: "50%",
      border: "1px solid #e5e7eb",
      background: "rgba(255, 255, 255, 0.9)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "999999",
      padding: "0",
      color: "#1f2937",
      boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
      transition: "all 0.15s ease",
    });

    overlay.addEventListener("mouseenter", () => {
      overlay.style.width = `${OVERLAY_ICON_HOVER_SIZE_PX}px`;
      overlay.style.height = `${OVERLAY_ICON_HOVER_SIZE_PX}px`;
      overlay.style.background = "rgba(255, 255, 255, 1)";
      overlay.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    });

    overlay.addEventListener("mouseleave", () => {
      overlay.style.width = `${OVERLAY_ICON_SIZE_PX}px`;
      overlay.style.height = `${OVERLAY_ICON_SIZE_PX}px`;
      overlay.style.background = "rgba(255, 255, 255, 0.9)";
      overlay.style.boxShadow = "0 1px 3px rgba(0,0,0,0.12)";
    });

    overlay.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "PRODUCT_CLICKED", product });
    });

    container.appendChild(overlay);
  }
}

// ===== Helpers =====

function isAmazon(): boolean { return window.location.hostname.includes("amazon."); }
function isEbay(): boolean { return window.location.hostname.includes("ebay."); }

function getMeta(property: string): string | null {
  const el = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
  return el?.getAttribute("content") ?? null;
}

function extractImageUrl(image: unknown): string | null {
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return extractImageUrl(image[0]);
  if (typeof image === "object" && image !== null && "url" in image) {
    return (image as { url: string }).url;
  }
  return null;
}

function extractSchemaPrice(item: Record<string, unknown>): { value: number; currency: string } | null {
  const offers = item.offers as Record<string, unknown> | undefined;
  if (!offers) return null;
  const offerList = Array.isArray(offers) ? offers : [offers];
  for (const offer of offerList) {
    const price = parseFloat(String(offer.price ?? offer.lowPrice ?? ""));
    const currency = String(offer.priceCurrency ?? "USD");
    if (!isNaN(price)) return { value: price, currency };
  }
  return null;
}

function findImageElement(imageUrl: string): HTMLImageElement | null {
  const images = document.querySelectorAll("img");
  for (const img of images) {
    if (img.src === imageUrl || img.currentSrc === imageUrl || img.dataset.src === imageUrl) {
      const rect = img.getBoundingClientRect();
      if (rect.width >= MIN_IMAGE_SIZE_PX && rect.height >= MIN_IMAGE_SIZE_PX) {
        return img;
      }
    }
  }
  return null;
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `product-${Math.abs(hash).toString(36)}`;
}

// ===== Init =====

function init(): void {
  const products = detectProducts();
  if (products.length > 0) {
    console.log(`[Shopping Assistant] Detected ${products.length} product(s)`);
    injectOverlays(products);
    chrome.runtime.sendMessage({
      type: "PRODUCTS_DETECTED",
      count: products.length,
      products,
    });
  }
}

init();

// Re-detect on SPA navigation
let lastUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    document.querySelectorAll(".shopping-assistant-overlay").forEach((el) => el.remove());
    document.querySelectorAll("[data-shopping-assistant]").forEach((el) => {
      delete (el as HTMLElement).dataset.shoppingAssistant;
    });
    setTimeout(init, 1000);
  }
});
observer.observe(document.body, { childList: true, subtree: true });
```

**Step 2: Commit**

```bash
git add packages/extension/src/content/index.ts
git commit -m "feat: implement product detection with Amazon/eBay heuristics and overlay injection"
```

---

### Task 2: Implement Service Worker — Message Routing and Cache

**Files:**
- Rewrite: `packages/extension/src/background/index.ts`

**Step 1: Implement service worker**

Replace the entire contents of `packages/extension/src/background/index.ts` with:

```typescript
import type {
  DetectedProduct,
  SearchRequest,
  SearchResponse,
  CachedSearch,
} from "@shopping-assistant/shared";
import {
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  CACHE_SESSION_THRESHOLD_MS,
} from "@shopping-assistant/shared";

console.log("[Shopping Assistant] Service worker started");

const BACKEND_URL = "http://localhost:8080";

// ===== Extension Icon Click =====

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// ===== Message Handling =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRODUCT_CLICKED") {
    handleProductClick(message.product, sender.tab?.id);
    sendResponse({ status: "ok" });
  } else if (message.type === "PRODUCTS_DETECTED") {
    console.log(`[SW] Detected ${message.count} products on tab ${sender.tab?.id}`);
    if (sender.tab?.id) {
      chrome.action.setBadgeText({ text: String(message.count), tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({ color: "#6366f1", tabId: sender.tab.id });
    }
    sendResponse({ status: "ok" });
  } else if (message.type === "CHAT_REQUEST") {
    handleChatRequest(message.payload).then(sendResponse);
    return true; // Keep channel open for async
  } else if (message.type === "GET_BACKEND_URL") {
    sendResponse({ url: BACKEND_URL });
    return false;
  }
  return true;
});

// ===== Product Click Handler =====

async function handleProductClick(product: DetectedProduct, tabId?: number): Promise<void> {
  if (tabId) {
    chrome.sidePanel.open({ tabId });
  }

  broadcastToSidePanel({ type: "SEARCH_STARTED", product });

  // Check cache
  const cached = await getCachedSearch(product.id);
  if (cached) {
    console.log("[SW] Cache hit for product:", product.id);
    broadcastToSidePanel({ type: "SEARCH_COMPLETE", product, response: cached.response, fromCache: true });
    return;
  }

  console.log("[SW] Cache miss, searching for:", product.title ?? product.imageUrl);

  const searchRequest: SearchRequest = {
    imageUrl: product.imageUrl,
    imageBase64: null,
    title: product.title,
    price: product.price,
    currency: product.currency,
    sourceUrl: product.pageUrl,
  };

  try {
    const response = await fetch(`${BACKEND_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchRequest),
    });

    if (!response.ok) throw new Error(`Search failed: ${response.status}`);

    const searchResponse = (await response.json()) as SearchResponse;
    await cacheSearch(product.id, searchResponse);
    broadcastToSidePanel({ type: "SEARCH_COMPLETE", product, response: searchResponse, fromCache: false });
  } catch (err) {
    console.error("[SW] Search error:", err);
    broadcastToSidePanel({ type: "SEARCH_ERROR", product, error: String(err) });
  }
}

// ===== Chat Handler =====

async function handleChatRequest(payload: unknown): Promise<unknown> {
  try {
    const response = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Chat failed: ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error("[SW] Chat error:", err);
    return { reply: "Sorry, something went wrong. Please try again." };
  }
}

// ===== Cache =====

async function getCachedSearch(productId: string): Promise<CachedSearch | null> {
  const key = `search_${productId}`;
  const result = await chrome.storage.local.get(key);
  const cached = result[key] as CachedSearch | undefined;
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > cached.ttl) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return cached;
}

async function cacheSearch(productId: string, response: SearchResponse): Promise<void> {
  const entry: CachedSearch = { productId, response, cachedAt: Date.now(), ttl: CACHE_TTL_MS };
  await chrome.storage.local.set({ [`search_${productId}`]: entry });
  await evictOldEntries();
}

async function evictOldEntries(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const entries: Array<[string, CachedSearch]> = Object.entries(all)
    .filter(([key]) => key.startsWith("search_"))
    .map(([key, value]) => [key, value as CachedSearch]);

  if (entries.length <= CACHE_MAX_ENTRIES) return;

  entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  const toRemove = entries.slice(0, entries.length - CACHE_MAX_ENTRIES);
  await chrome.storage.local.remove(toRemove.map(([key]) => key));
}

function broadcastToSidePanel(message: unknown): void {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// ===== Startup Cleanup =====

chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const keysToRemove: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("search_")) continue;
    const entry = value as CachedSearch;
    if (Date.now() - entry.cachedAt > CACHE_SESSION_THRESHOLD_MS) {
      keysToRemove.push(key);
    }
  }
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
    console.log(`[SW] Cleaned ${keysToRemove.length} expired cache entries`);
  }
});
```

**Step 2: Commit**

```bash
git add packages/extension/src/background/index.ts
git commit -m "feat: implement service worker with cache management and message routing"
```

---

### Task 3: Implement Side Panel UI — Results and Chat

**Files:**
- Rewrite: `packages/extension/src/sidepanel/App.tsx`
- Rewrite: `packages/extension/src/sidepanel/App.css`

**Step 1: Build the full side panel React app**

Replace the entire contents of `packages/extension/src/sidepanel/App.tsx`. This is a large file — see the full source in the monolithic plan at `docs/plans/2026-03-02-mvp-implementation.md`, Task 11, Step 1. The file contains:

- `App` component with state management for views: empty, loading, results, chat, error
- `chrome.runtime.onMessage` listener for SEARCH_STARTED, SEARCH_COMPLETE, SEARCH_ERROR
- Loading phases: identifying → searching → comparing → complete
- `EmptyState`, `LoadingState`, `ResultsView`, `ChatView`, `ErrorState` sub-components
- `ProductCard` with image, title, price, savings badge, marketplace, confidence
- `PriceBar` with gradient price range indicator
- `handleSendChat` that sends `ChatRequest` via `chrome.runtime.sendMessage`

The full component code is specified in `docs/plans/2026-03-02-mvp-implementation.md` Task 11.

**Step 2: Replace App.css**

Replace with the full CSS from `docs/plans/2026-03-02-mvp-implementation.md` Task 11, Step 2. Contains styles for:
- Panel layout (360px fixed width)
- Loading spinner animation
- Product cards with hover effects
- Price bar with gradient
- Chat bubbles (user right-aligned, assistant left-aligned)
- Savings badges, confidence labels
- Chat input area

**Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/App.tsx packages/extension/src/sidepanel/App.css
git commit -m "feat: implement side panel UI with results, loading states, and chat views"
```

---

### Task 4: Build and Verify Extension

**Step 1: Build shared package**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared`

**Step 2: Typecheck extension**

Run: `pnpm --filter @shopping-assistant/extension typecheck`
Expected: No type errors. Fix any that arise.

**Step 3: Build extension**

Run: `pnpm build:ext`
Expected: `packages/extension/dist/` contains compiled extension.

**Step 4: Fix issues and commit**

```bash
git add -A
git commit -m "chore: fix extension typecheck and build issues"
```

---

### Task 5: Manual Integration Test

**Step 1: Start backend**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm dev:backend`

**Step 2: Load extension in Chrome**

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `packages/extension/dist/`

**Step 3: Test on Amazon**

1. Navigate to any Amazon product page
2. Look for search overlay icon on the product image
3. Click it — side panel should open with loading phases
4. After ~5-10 seconds, results should appear
5. Click "Chat Now" and ask a question

**Step 4: Report issues for follow-up fixes**

Phase 2 is complete when the search flow works end-to-end in Chrome.

---

**Next phase:** `docs/plans/2026-03-02-phase3-voice.md` — WebSocket voice proxy and audio UI.
