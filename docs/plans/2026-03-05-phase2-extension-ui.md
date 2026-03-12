# Phase 2: Extension UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a working Chrome extension with content script product detection, overlay injection, background service worker with cache, and a fully styled side panel (empty/loading/results/chat/error states) connected to the Phase 1 backend via REST.

**Architecture:** Content script detects products via DOM heuristics and injects overlay icons. Clicks route through the background service worker, which manages cache (chrome.storage.local with TTL/LRU) and backend API calls. The side panel React app receives state updates via chrome.runtime messaging and renders all UI states. Text chat uses REST POST /chat. Voice is Phase 3 — mic button is a visual placeholder only.

**Tech Stack:** React 19, Tailwind CSS v3, Vite + CRXJS, Chrome MV3 APIs (sidePanel, storage, runtime messaging), TypeScript strict mode, vitest for testable utilities.

**Visual Language:** Orange primary `#d95a00`, warm cream bg `#fdfaf5`, Inter font, Material Icons, "Personal Shopper" branding, `rounded-2xl` cards with `shadow-soft`. See `ui-drafts/main.html` for reference.

**Out of Scope:** Voice recording, WebSocket /live, AudioWorklet, audio playback, dark mode, bookmarks/favorites. Mic button shows tooltip "Voice coming soon" on press.

---

## Task 1: Tailwind CSS + Design System Setup

**Files:**
- Create: `packages/extension/tailwind.config.ts`
- Create: `packages/extension/postcss.config.js`
- Modify: `packages/extension/src/sidepanel/index.css` (rename from App.css)
- Modify: `packages/extension/src/sidepanel/index.html`
- Modify: `packages/extension/src/sidepanel/index.tsx`
- Modify: `packages/extension/package.json`

**Step 1: Install Tailwind + dependencies**

```bash
cd packages/extension
pnpm add -D tailwindcss@3 postcss autoprefixer
```

**Step 2: Create PostCSS config**

Create `packages/extension/postcss.config.js`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

**Step 3: Create Tailwind config with design tokens**

Create `packages/extension/tailwind.config.ts`:

```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        primary: "#d95a00",
        "primary-dark": "#b34800",
        background: "#fdfaf5",
        surface: "#ffffff",
        "text-main": "#1a202c",
        "text-muted": "#4a5568",
        "accent-green": "#10b981",
        "accent-red": "#ef4444",
        "accent-yellow": "#f59e0b",
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
      boxShadow: {
        soft: "0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)",
      },
    },
  },
  plugins: [],
} satisfies Config;
```

**Step 4: Create Tailwind entry CSS**

Rename `packages/extension/src/sidepanel/App.css` → `packages/extension/src/sidepanel/index.css` and replace contents:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: "Inter", sans-serif;
  width: 360px;
  background: #fdfaf5;
  color: #1a202c;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
```

**Step 5: Update index.html with font + icons**

Modify `packages/extension/src/sidepanel/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Personal Shopper</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./index.tsx"></script>
  </body>
</html>
```

**Step 6: Update index.tsx import**

Modify `packages/extension/src/sidepanel/index.tsx` — change `import "./App.css"` to `import "./index.css"`.

**Step 7: Verify build**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck
```

Expected: no errors.

**Step 8: Commit**

```bash
git add packages/extension/
git commit -m "feat(ext): add Tailwind CSS with design system tokens"
```

---

## Task 2: Extension Message Types

**Files:**
- Modify: `packages/shared/src/types.ts`

**Step 1: Add extension message types**

Append to `packages/shared/src/types.ts`:

```ts
// === Extension Internal Messages ===

/** Content Script → Service Worker */
export type ContentToBackgroundMessage =
  | { type: "PRODUCT_CLICKED"; product: DetectedProduct }
  | { type: "PRODUCTS_DETECTED"; products: DetectedProduct[] };

/** Service Worker → Side Panel */
export type BackgroundToSidePanelMessage =
  | { type: "SEARCH_STARTED"; product: DetectedProduct }
  | { type: "SEARCH_COMPLETE"; product: DetectedProduct; response: SearchResponse }
  | { type: "SEARCH_ERROR"; product: DetectedProduct; error: string }
  | { type: "CHAT_RESPONSE"; reply: string }
  | { type: "CHAT_ERROR"; error: string };

/** Side Panel → Service Worker */
export type SidePanelToBackgroundMessage =
  | { type: "GET_STATE" }
  | { type: "CHAT_REQUEST"; request: ChatRequest }
  | { type: "GET_BACKEND_URL" };

/** Service Worker → Side Panel: response to GET_STATE */
export interface PanelState {
  view: "empty" | "loading" | "results" | "error";
  product: DetectedProduct | null;
  response: SearchResponse | null;
  error: string | null;
  loadingPhase: 1 | 2 | 3 | null;
}

/** Union of all extension messages (for runtime type narrowing) */
export type ExtensionMessage =
  | ContentToBackgroundMessage
  | BackgroundToSidePanelMessage
  | SidePanelToBackgroundMessage;
```

**Step 2: Build shared**

```bash
pnpm build:shared
```

Expected: builds without errors.

**Step 3: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): add extension internal message types"
```

---

## Task 3: Manifest + Permissions

**Files:**
- Modify: `packages/extension/src/manifest.json`

**Step 1: Update manifest**

Replace `packages/extension/src/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Shopping Source Discovery",
  "version": "0.1.0",
  "description": "Find cheaper alternatives for any product you see online.",
  "permissions": ["sidePanel", "storage", "activeTab"],
  "host_permissions": ["http://localhost:8080/*"],
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/index.ts"],
      "run_at": "document_idle"
    }
  ],
  "side_panel": {
    "default_path": "src/sidepanel/index.html"
  },
  "action": {
    "default_title": "Personal Shopper"
  },
  "icons": {}
}
```

**Step 2: Commit**

```bash
git add packages/extension/src/manifest.json
git commit -m "feat(ext): add host_permissions for backend dev server"
```

---

## Task 4: Content Script — Product Detection

**Files:**
- Create: `packages/extension/src/content/detection.ts`
- Modify: `packages/extension/src/content/index.ts`

**Step 1: Create the detection module**

Create `packages/extension/src/content/detection.ts`:

```ts
import type { DetectedProduct, SerializableRect } from "@shopping-assistant/shared";
import { MIN_IMAGE_SIZE_PX, MAX_OVERLAYS_PER_PAGE } from "@shopping-assistant/shared";

/** Simple string hash (djb2). */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function makeProductId(imageUrl: string, pageUrl: string): string {
  return hashString(imageUrl + "|" + pageUrl);
}

function toSerializableRect(el: Element): SerializableRect {
  const r = el.getBoundingClientRect();
  return {
    x: r.x, y: r.y, width: r.width, height: r.height,
    top: r.top, right: r.right, bottom: r.bottom, left: r.left,
  };
}

function parsePrice(text: string): { price: number; currency: string } | null {
  const match = text.match(/([£$€¥₹])\s*([\d,]+(?:\.\d{1,2})?)/);
  if (match) {
    const currencyMap: Record<string, string> = { "$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR" };
    return { price: parseFloat(match[2].replace(/,/g, "")), currency: currencyMap[match[1]] ?? "USD" };
  }
  const match2 = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)/i);
  if (match2) {
    return { price: parseFloat(match2[1].replace(/,/g, "")), currency: match2[2].toUpperCase() };
  }
  return null;
}

function getMarketplace(url: string): string | null {
  const host = new URL(url).hostname.replace("www.", "");
  const map: Record<string, string> = {
    "amazon.com": "Amazon", "amazon.co.uk": "Amazon", "amazon.de": "Amazon",
    "amazon.ca": "Amazon", "amazon.co.jp": "Amazon",
    "ebay.com": "eBay", "ebay.co.uk": "eBay",
    "walmart.com": "Walmart", "target.com": "Target",
    "aliexpress.com": "AliExpress", "temu.com": "Temu",
    "etsy.com": "Etsy", "bestbuy.com": "Best Buy",
  };
  for (const [domain, name] of Object.entries(map)) {
    if (host.includes(domain)) return name;
  }
  return host;
}

// ── Detection Strategies ──

interface RawDetection {
  imageUrl: string;
  imageEl: Element;
  title: string | null;
  price: number | null;
  currency: string | null;
}

function detectJsonLd(): RawDetection[] {
  const results: RawDetection[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const item of items) {
        if (item["@type"] !== "Product") continue;
        const imageUrl = Array.isArray(item.image) ? item.image[0] : item.image;
        if (!imageUrl || typeof imageUrl !== "string") continue;
        const imgEl = document.querySelector(`img[src="${imageUrl}"], img[src*="${imageUrl.split("/").pop()}"]`);
        if (!imgEl) continue;
        const rect = imgEl.getBoundingClientRect();
        if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) continue;

        let price: number | null = null;
        let currency: string | null = null;
        const offers = item.offers ?? item.offer;
        if (offers) {
          const offer = Array.isArray(offers) ? offers[0] : offers;
          if (offer.price) price = parseFloat(offer.price);
          if (offer.priceCurrency) currency = offer.priceCurrency;
        }

        results.push({
          imageUrl, imageEl: imgEl,
          title: item.name ?? null, price, currency,
        });
      }
    } catch { /* skip malformed JSON-LD */ }
  }
  return results;
}

function detectOpenGraph(): RawDetection[] {
  const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute("content");
  if (!ogType || !ogType.includes("product")) return [];

  const imageUrl = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;
  const priceStr = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]')?.getAttribute("content");
  const currency = document.querySelector('meta[property="product:price:currency"], meta[property="og:price:currency"]')?.getAttribute("content") ?? null;

  if (!imageUrl) return [];
  const imgEl = document.querySelector(`img[src="${imageUrl}"], img[src*="${imageUrl.split("/").pop()}"]`);
  if (!imgEl) return [];
  const rect = imgEl.getBoundingClientRect();
  if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) return [];

  return [{
    imageUrl, imageEl: imgEl, title,
    price: priceStr ? parseFloat(priceStr) : null, currency,
  }];
}

function detectAmazon(): RawDetection[] {
  if (!location.hostname.includes("amazon")) return [];
  const imgEl = document.querySelector("#imgTagWrapperId img, #landingImage, #main-image");
  if (!imgEl) return [];
  const imageUrl = imgEl.getAttribute("src");
  if (!imageUrl) return [];
  const rect = imgEl.getBoundingClientRect();
  if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) return [];

  const title = document.querySelector("#productTitle")?.textContent?.trim() ?? null;
  const priceWhole = document.querySelector(".a-price .a-price-whole")?.textContent?.replace(/[^0-9]/g, "") ?? "";
  const priceFrac = document.querySelector(".a-price .a-price-fraction")?.textContent?.replace(/[^0-9]/g, "") ?? "00";
  const price = priceWhole ? parseFloat(`${priceWhole}.${priceFrac}`) : null;

  return [{ imageUrl, imageEl: imgEl, title, price, currency: "USD" }];
}

function detectEbay(): RawDetection[] {
  if (!location.hostname.includes("ebay")) return [];
  const imgEl = document.querySelector(".ux-image-carousel-item img, #icImg");
  if (!imgEl) return [];
  const imageUrl = imgEl.getAttribute("src");
  if (!imageUrl) return [];
  const rect = imgEl.getBoundingClientRect();
  if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) return [];

  const title = document.querySelector(".x-item-title__mainTitle span, #itemTitle")?.textContent?.trim() ?? null;
  const priceEl = document.querySelector(".x-price-primary span, #prcIsum");
  const parsed = priceEl?.textContent ? parsePrice(priceEl.textContent) : null;

  return [{
    imageUrl, imageEl: imgEl, title,
    price: parsed?.price ?? null, currency: parsed?.currency ?? "USD",
  }];
}

function detectGenericFallback(): RawDetection[] {
  const results: RawDetection[] = [];
  const images = document.querySelectorAll("img");
  for (const img of images) {
    const rect = img.getBoundingClientRect();
    if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) continue;
    const imageUrl = img.src;
    if (!imageUrl || imageUrl.startsWith("data:")) continue;

    // Walk up to find a container with price text
    let container = img.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      const text = container.textContent ?? "";
      const parsed = parsePrice(text);
      if (parsed) {
        // Try to find a title nearby
        const heading = container.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']");
        results.push({
          imageUrl, imageEl: img,
          title: heading?.textContent?.trim() ?? null,
          price: parsed.price, currency: parsed.currency,
        });
        break;
      }
      container = container.parentElement;
    }
  }
  return results;
}

// ── Public API ──

export function detectProducts(): DetectedProduct[] {
  const pageUrl = location.href;
  const marketplace = getMarketplace(pageUrl);
  const seen = new Set<string>();
  const products: DetectedProduct[] = [];

  const strategies = [detectJsonLd, detectOpenGraph, detectAmazon, detectEbay, detectGenericFallback];

  for (const strategy of strategies) {
    for (const raw of strategy()) {
      const id = makeProductId(raw.imageUrl, pageUrl);
      if (seen.has(id)) continue;
      seen.add(id);

      products.push({
        id, imageUrl: raw.imageUrl,
        title: raw.title, price: raw.price, currency: raw.currency,
        pageUrl, marketplace,
        schemaData: null,
        boundingRect: toSerializableRect(raw.imageEl),
        detectedAt: Date.now(),
      });

      if (products.length >= MAX_OVERLAYS_PER_PAGE) return products;
    }
  }

  return products;
}

export { makeProductId };
```

**Step 2: Verify shared builds (types used above)**

```bash
pnpm build:shared
```

**Step 3: Commit**

```bash
git add packages/extension/src/content/detection.ts
git commit -m "feat(ext): implement product detection heuristics (JSON-LD, OG, Amazon, eBay, generic)"
```

---

## Task 5: Content Script — Overlay Injection + SPA Observer

**Files:**
- Create: `packages/extension/src/content/overlay.ts`
- Modify: `packages/extension/src/content/index.ts`

**Step 1: Create the overlay module**

Create `packages/extension/src/content/overlay.ts`:

```ts
import type { DetectedProduct } from "@shopping-assistant/shared";
import { OVERLAY_ICON_SIZE_PX, OVERLAY_ICON_HOVER_SIZE_PX, CACHE_TTL_MS } from "@shopping-assistant/shared";

const OVERLAY_ATTR = "data-shopping-assistant-overlay";
const Z_INDEX = 999999;

function createOverlayIcon(product: DetectedProduct): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute(OVERLAY_ATTR, product.id);

  Object.assign(el.style, {
    position: "absolute",
    width: `${OVERLAY_ICON_SIZE_PX}px`,
    height: `${OVERLAY_ICON_SIZE_PX}px`,
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.92)",
    border: "1px solid #e5e7eb",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    cursor: "pointer",
    zIndex: String(Z_INDEX),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    pointerEvents: "auto",
  } as CSSStyleDeclaration);

  // Inner icon (magnifier)
  const icon = document.createElement("span");
  icon.textContent = "🔍";
  icon.style.fontSize = "14px";
  icon.style.lineHeight = "1";
  el.appendChild(icon);

  // Green dot (cached indicator, hidden by default)
  const dot = document.createElement("span");
  dot.className = "shopping-assistant-cached-dot";
  Object.assign(dot.style, {
    position: "absolute",
    top: "-2px",
    right: "-2px",
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#10b981",
    border: "1.5px solid white",
    display: "none",
  } as CSSStyleDeclaration);
  el.appendChild(dot);

  // Hover effects
  el.addEventListener("mouseenter", () => {
    el.style.transform = "scale(1.14)";
    el.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
    el.title = "Find cheaper alternatives";
  });
  el.addEventListener("mouseleave", () => {
    el.style.transform = "scale(1)";
    el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
  });

  // Click → send message to service worker
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "PRODUCT_CLICKED", product });
  });

  return el;
}

function positionOverlay(overlay: HTMLElement, imageEl: Element): void {
  const parent = imageEl.parentElement;
  if (!parent) return;

  // Ensure parent is positioned for absolute placement
  const parentPos = getComputedStyle(parent).position;
  if (parentPos === "static") {
    parent.style.position = "relative";
  }

  const parentRect = parent.getBoundingClientRect();
  const imgRect = imageEl.getBoundingClientRect();

  overlay.style.top = `${imgRect.top - parentRect.top + 8}px`;
  overlay.style.right = `${parentRect.right - imgRect.right + 8}px`;
  overlay.style.left = "auto";
}

export function injectOverlays(products: DetectedProduct[]): void {
  // Remove old overlays
  removeOverlays();

  for (const product of products) {
    const imgEl = document.querySelector(
      `img[src="${product.imageUrl}"]`
    ) ?? document.querySelector(
      `img[src*="${product.imageUrl.split("/").pop()}"]`
    );
    if (!imgEl) continue;

    const overlay = createOverlayIcon(product);
    positionOverlay(overlay, imgEl);
    imgEl.parentElement!.appendChild(overlay);

    // Check cache for green dot
    checkCachedStatus(product.id, overlay);
  }
}

async function checkCachedStatus(productId: string, overlay: HTMLElement): Promise<void> {
  try {
    const key = `search_${productId}`;
    const data = await chrome.storage.local.get(key);
    if (data[key]) {
      const cached = data[key];
      if (Date.now() - cached.cachedAt < (cached.ttl ?? CACHE_TTL_MS)) {
        const dot = overlay.querySelector(".shopping-assistant-cached-dot") as HTMLElement;
        if (dot) dot.style.display = "block";
      }
    }
  } catch { /* storage access may fail in some contexts */ }
}

export function removeOverlays(): void {
  document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((el) => el.remove());
}
```

**Step 2: Rewrite content script entry**

Replace `packages/extension/src/content/index.ts`:

```ts
import type { DetectedProduct } from "@shopping-assistant/shared";
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
```

**Step 3: Typecheck**

```bash
pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck
```

**Step 4: Commit**

```bash
git add packages/extension/src/content/
git commit -m "feat(ext): content script with overlay injection and SPA navigation support"
```

---

## Task 6: Background Service Worker — Cache Layer

**Files:**
- Create: `packages/extension/src/background/cache.ts`

**Step 1: Implement cache module**

Create `packages/extension/src/background/cache.ts`:

```ts
import type { CachedSearch, SearchResponse } from "@shopping-assistant/shared";
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES, CACHE_SESSION_THRESHOLD_MS } from "@shopping-assistant/shared";

function cacheKey(productId: string): string {
  return `search_${productId}`;
}

export async function getCached(productId: string): Promise<SearchResponse | null> {
  const key = cacheKey(productId);
  const data = await chrome.storage.local.get(key);
  const entry: CachedSearch | undefined = data[key];
  if (!entry) return null;

  if (Date.now() - entry.cachedAt > (entry.ttl ?? CACHE_TTL_MS)) {
    await chrome.storage.local.remove(key);
    return null;
  }

  return entry.response;
}

export async function setCached(productId: string, response: SearchResponse): Promise<void> {
  const entry: CachedSearch = {
    productId,
    response,
    cachedAt: Date.now(),
    ttl: CACHE_TTL_MS,
  };

  await chrome.storage.local.set({ [cacheKey(productId)]: entry });
  await evictIfNeeded();
}

async function evictIfNeeded(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const entries: Array<{ key: string; cachedAt: number }> = [];

  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("search_") && value?.cachedAt) {
      entries.push({ key, cachedAt: value.cachedAt });
    }
  }

  if (entries.length <= CACHE_MAX_ENTRIES) return;

  // LRU: remove oldest entries
  entries.sort((a, b) => a.cachedAt - b.cachedAt);
  const toRemove = entries.slice(0, entries.length - CACHE_MAX_ENTRIES).map((e) => e.key);
  await chrome.storage.local.remove(toRemove);
}

export async function cleanupStaleEntries(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const toRemove: string[] = [];

  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith("search_") && value?.cachedAt) {
      if (now - value.cachedAt > CACHE_SESSION_THRESHOLD_MS) {
        toRemove.push(key);
      }
    }
  }

  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove);
    console.log(`[Personal Shopper] Cleaned up ${toRemove.length} stale cache entries`);
  }
}
```

**Step 2: Commit**

```bash
git add packages/extension/src/background/cache.ts
git commit -m "feat(ext): cache layer with TTL/LRU for chrome.storage.local"
```

---

## Task 7: Background Service Worker — Message Routing + API Calls

**Files:**
- Modify: `packages/extension/src/background/index.ts`

**Step 1: Implement the full service worker**

Replace `packages/extension/src/background/index.ts`:

```ts
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
      throw new Error(errBody.message ?? `Backend returned ${res.status}`);
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
```

**Step 2: Typecheck**

```bash
pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck
```

**Step 3: Commit**

```bash
git add packages/extension/src/background/
git commit -m "feat(ext): service worker with message routing, cache, and backend API calls"
```

---

## Task 8: Side Panel — Header Component

**Files:**
- Create: `packages/extension/src/sidepanel/components/Header.tsx`

**Step 1: Build the header**

Create `packages/extension/src/sidepanel/components/Header.tsx`:

```tsx
export function Header() {
  return (
    <header className="flex items-center justify-between px-5 py-3.5 bg-background border-b border-gray-200 sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <span className="material-icons text-primary text-xl">shopping_bag</span>
        <h1 className="text-lg font-semibold text-text-main">Personal Shopper</h1>
      </div>
      <button
        className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-gray-200 transition-colors"
        aria-label="Settings"
      >
        <span className="material-icons text-xl">settings</span>
      </button>
    </header>
  );
}
```

**Step 2: Commit**

```bash
git add packages/extension/src/sidepanel/components/
git commit -m "feat(ext): header component with Personal Shopper branding"
```

---

## Task 9: Side Panel — ProductSection Component

**Files:**
- Create: `packages/extension/src/sidepanel/components/ProductSection.tsx`

**Step 1: Build the original product display**

Create `packages/extension/src/sidepanel/components/ProductSection.tsx`:

```tsx
import type { DetectedProduct } from "@shopping-assistant/shared";

interface Props {
  product: DetectedProduct;
}

export function ProductSection({ product }: Props) {
  const priceStr = product.price !== null
    ? `${product.currency === "USD" || !product.currency ? "$" : product.currency}${product.price}`
    : null;

  return (
    <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img
            src={product.imageUrl}
            alt={product.title ?? "Product"}
            className="w-14 h-14 rounded-xl object-cover shadow-sm"
          />
          <div className="min-w-0">
            <p className="text-xs text-text-muted font-medium">Current Product</p>
            <p className="text-base font-bold text-text-main mt-0.5 truncate max-w-[180px]">
              {product.title ?? "Unknown Product"}
              {priceStr && <span className="text-primary ml-1.5">{priceStr}</span>}
            </p>
            {product.marketplace && (
              <p className="text-xs text-text-muted">on {product.marketplace}</p>
            )}
          </div>
        </div>
        <span className="bg-orange-100 text-primary text-xs font-semibold px-2.5 py-1 rounded-full shadow-sm whitespace-nowrap">
          You're Here
        </span>
      </div>
    </section>
  );
}
```

**Step 2: Commit**

```bash
git add packages/extension/src/sidepanel/components/ProductSection.tsx
git commit -m "feat(ext): ProductSection component with You're Here badge"
```

---

## Task 10: Side Panel — PriceBar Component

**Files:**
- Create: `packages/extension/src/sidepanel/components/PriceBar.tsx`

**Step 1: Build the price context bar**

Create `packages/extension/src/sidepanel/components/PriceBar.tsx`:

```tsx
import type { SearchResponse, DetectedProduct } from "@shopping-assistant/shared";

interface Props {
  product: DetectedProduct;
  response: SearchResponse;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function PriceBar({ product, response, collapsed, onToggle }: Props) {
  const prices = response.results
    .map((r) => r.result.price)
    .filter((p): p is number => p !== null);

  if (prices.length === 0 || product.price === null) return null;

  const allPrices = [...prices, product.price];
  const low = Math.min(...allPrices);
  const high = Math.max(...allPrices);
  const range = high - low;
  if (range === 0) return null;

  const position = ((product.price - low) / range) * 100;
  const bestPrice = Math.min(...prices);
  const bestResult = response.results.find((r) => r.result.price === bestPrice);
  const aboveAvg = prices.length > 0
    ? Math.round(((product.price - (prices.reduce((a, b) => a + b, 0) / prices.length)) / (prices.reduce((a, b) => a + b, 0) / prices.length)) * 100)
    : null;

  const label = position > 66 ? "HIGH" : position > 33 ? "FAIR" : "LOW";
  const labelColor = position > 66 ? "text-accent-red" : position > 33 ? "text-accent-yellow" : "text-accent-green";
  const dotBorder = position > 66 ? "border-accent-red" : position > 33 ? "border-accent-yellow" : "border-accent-green";

  if (collapsed) {
    return (
      <button onClick={onToggle} className="w-full bg-surface rounded-2xl px-4 py-2.5 shadow-soft border border-gray-100 flex items-center gap-2 text-left">
        <span className="material-icons text-sm text-accent-red">warning_amber</span>
        <span className="text-sm text-text-muted">Price is <span className={`font-bold ${labelColor}`}>{label}</span></span>
        <span className="material-icons text-xs text-text-muted ml-auto">expand_more</span>
      </button>
    );
  }

  return (
    <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
      {onToggle && (
        <button onClick={onToggle} className="w-full flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="material-icons text-sm text-accent-red">warning_amber</span>
            <span className="text-sm text-text-muted">This price is</span>
            <span className={`text-sm font-bold ${labelColor}`}>{label}</span>
          </div>
          <span className="material-icons text-xs text-text-muted">expand_less</span>
        </button>
      )}
      {!onToggle && (
        <div className="flex items-center gap-2 mb-3">
          <span className="material-icons text-sm text-accent-red">warning_amber</span>
          <span className="text-sm text-text-muted">This price is</span>
          <span className={`text-sm font-bold ${labelColor}`}>{label}</span>
        </div>
      )}

      {/* Gradient bar */}
      <div className="relative h-2 rounded-full w-full mb-2 bg-gradient-to-r from-accent-green via-accent-yellow to-accent-red">
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full border-4 ${dotBorder} shadow-sm z-10`}
          style={{ left: `${Math.min(Math.max(position, 5), 95)}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-text-muted mb-4">
        <span>${low}</span>
        <span>${high}</span>
      </div>

      {/* AI insight */}
      {aboveAvg !== null && bestResult && (
        <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 shadow-sm">
            <span className="material-icons text-sm">smart_toy</span>
          </div>
          <p className="text-sm text-text-main leading-snug">
            {aboveAvg > 0 ? (
              <>
                <span className="font-bold text-primary">{aboveAvg}%</span> above average.
                Best on {bestResult.result.marketplace}.
              </>
            ) : (
              <>This price is competitive.</>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
```

**Step 2: Commit**

```bash
git add packages/extension/src/sidepanel/components/PriceBar.tsx
git commit -m "feat(ext): PriceBar component with gradient indicator and AI insight"
```

---

## Task 11: Side Panel — ResultCard Component

**Files:**
- Create: `packages/extension/src/sidepanel/components/ResultCard.tsx`

**Step 1: Build result card with full and compact variants**

Create `packages/extension/src/sidepanel/components/ResultCard.tsx`:

```tsx
import type { RankedResult } from "@shopping-assistant/shared";

interface Props {
  ranked: RankedResult;
  compact?: boolean;
}

export function ResultCard({ ranked, compact }: Props) {
  const { result } = ranked;
  const priceStr = result.price !== null
    ? `$${result.price}`
    : "N/A";

  const savingsStr = ranked.savingsPercent !== null && ranked.savingsPercent > 0
    ? `${ranked.savingsPercent}% less`
    : null;

  const handleClick = () => {
    window.open(result.productUrl, "_blank", "noopener");
  };

  const confidenceIndicator =
    ranked.confidence === "medium" ? (
      <span className="text-xs text-accent-yellow font-medium">Similar</span>
    ) : ranked.confidence === "low" ? (
      <span className="text-xs text-text-muted font-medium">May differ</span>
    ) : null;

  if (compact) {
    return (
      <button
        onClick={handleClick}
        className="w-full flex items-center gap-2.5 py-2 px-1 hover:bg-gray-50 rounded-lg transition-colors text-left group"
      >
        {result.imageUrl && (
          <img
            src={result.imageUrl}
            alt={result.title}
            className="w-8 h-8 rounded-lg object-cover mix-blend-multiply opacity-90 group-hover:opacity-100 shrink-0"
          />
        )}
        <span className="text-xs text-text-muted font-medium shrink-0 w-20 truncate">{result.marketplace}</span>
        <span className="text-xs text-text-main truncate flex-1">{result.title}</span>
        <span className="text-sm font-bold text-text-main shrink-0">{priceStr}</span>
        {savingsStr && (
          <span className="text-xs text-accent-green font-medium shrink-0">-{ranked.savingsPercent}%</span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-center justify-between group py-1 text-left"
    >
      <div className="flex items-center gap-3 min-w-0">
        {result.imageUrl && (
          <img
            src={result.imageUrl}
            alt={result.title}
            className="w-12 h-12 rounded-xl object-cover mix-blend-multiply opacity-90 group-hover:opacity-100 transition-opacity shrink-0"
          />
        )}
        <div className="min-w-0">
          <h4 className="font-medium text-text-main text-sm truncate max-w-[160px]">{result.title}</h4>
          <p className="text-text-muted text-xs">{result.marketplace}</p>
          {confidenceIndicator}
        </div>
      </div>
      <div className="text-right shrink-0 ml-2">
        <p className="font-bold text-base text-text-main">{priceStr}</p>
        {savingsStr && (
          <p className="text-accent-green text-xs font-medium">{savingsStr}</p>
        )}
      </div>
    </button>
  );
}
```

**Step 2: Commit**

```bash
git add packages/extension/src/sidepanel/components/ResultCard.tsx
git commit -m "feat(ext): ResultCard with full and compact variants"
```

---

## Task 12: Side Panel — ChatThread Component

**Files:**
- Create: `packages/extension/src/sidepanel/components/ChatThread.tsx`

**Step 1: Build chat thread with input bar, nudge, and messages**

Create `packages/extension/src/sidepanel/components/ChatThread.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";
import type { ChatMessage, DetectedProduct, RankedResult, ChatRequest } from "@shopping-assistant/shared";

interface Props {
  product: DetectedProduct;
  results: RankedResult[];
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isLoading: boolean;
}

export function ChatThread({ product, results, messages, onSendMessage, isLoading }: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    onSendMessage(text);
    setInput("");
    inputRef.current?.focus();
  };

  const handleMicClick = () => {
    // Phase 3 placeholder — show tooltip
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed", bottom: "70px", right: "20px",
      background: "#1a202c", color: "white", padding: "6px 12px",
      borderRadius: "8px", fontSize: "12px", zIndex: "9999",
    } as CSSStyleDeclaration);
    el.textContent = "Voice coming soon";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar">
        {messages.length === 0 && (
          <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 flex items-center gap-3">
            <div className="w-7 h-7 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <p className="text-sm text-text-main">I can help you compare — hold mic or type below.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
                <span className="material-icons text-xs">smart_toy</span>
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-white rounded-br-md"
                  : "bg-white border border-gray-100 text-text-main rounded-bl-md shadow-sm"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="px-3 py-2.5 border-t border-gray-100 bg-background">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="Ask about these..."
            className="flex-1 bg-white border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-text-main placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            disabled={isLoading}
          />
          {input.trim() ? (
            <button
              onClick={handleSubmit}
              disabled={isLoading}
              className="w-10 h-10 flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary-dark transition-colors disabled:opacity-50"
            >
              <span className="material-icons text-lg">send</span>
            </button>
          ) : (
            <button
              onClick={handleMicClick}
              className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 text-text-muted hover:bg-gray-200 transition-colors"
            >
              <span className="material-icons text-lg">mic</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add packages/extension/src/sidepanel/components/ChatThread.tsx
git commit -m "feat(ext): ChatThread with input bar, mic placeholder, nudge, and message bubbles"
```

---

## Task 13: Side Panel — Main App with State Machine

**Files:**
- Modify: `packages/extension/src/sidepanel/App.tsx`

**Step 1: Implement the full App with all states**

Replace `packages/extension/src/sidepanel/App.tsx`:

```tsx
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  DetectedProduct,
  SearchResponse,
  RankedResult,
  ChatMessage,
  PanelState,
  BackgroundToSidePanelMessage,
  ChatRequest,
} from "@shopping-assistant/shared";
import { Header } from "./components/Header";
import { ProductSection } from "./components/ProductSection";
import { PriceBar } from "./components/PriceBar";
import { ResultCard } from "./components/ResultCard";
import { ChatThread } from "./components/ChatThread";

type ViewState =
  | { view: "empty" }
  | { view: "loading"; product: DetectedProduct; phase: 1 | 2 | 3 }
  | { view: "results"; product: DetectedProduct; response: SearchResponse }
  | { view: "error"; product: DetectedProduct; errorMessage: string };

export default function App() {
  const [state, setState] = useState<ViewState>({ view: "empty" });
  const [chatActive, setChatActive] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [priceBarCollapsed, setPriceBarCollapsed] = useState(false);
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // ── Request initial state from service worker ──
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response: PanelState) => {
      if (chrome.runtime.lastError || !response) return;
      switch (response.view) {
        case "loading":
          setState({ view: "loading", product: response.product!, phase: response.loadingPhase ?? 1 });
          startPhaseTimers();
          break;
        case "results":
          setState({ view: "results", product: response.product!, response: response.response! });
          break;
        case "error":
          setState({ view: "error", product: response.product!, errorMessage: response.error ?? "Search failed" });
          break;
        default:
          setState({ view: "empty" });
      }
    });
  }, []);

  // ── Listen for messages from service worker ──
  useEffect(() => {
    const listener = (message: BackgroundToSidePanelMessage) => {
      switch (message.type) {
        case "SEARCH_STARTED":
          setState({ view: "loading", product: message.product, phase: 1 });
          setChatActive(false);
          setChatMessages([]);
          setChatLoading(false);
          setPriceBarCollapsed(false);
          startPhaseTimers();
          break;
        case "SEARCH_COMPLETE":
          clearPhaseTimers();
          setState({ view: "results", product: message.product, response: message.response });
          break;
        case "SEARCH_ERROR":
          clearPhaseTimers();
          setState({ view: "error", product: message.product, errorMessage: message.error });
          break;
        case "CHAT_RESPONSE":
          setChatLoading(false);
          setChatMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: message.reply,
              inputMode: "text",
              timestamp: Date.now(),
              context: null,
            },
          ]);
          break;
        case "CHAT_ERROR":
          setChatLoading(false);
          setChatMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: "Sorry, I couldn't respond. Please try again.",
              inputMode: "text",
              timestamp: Date.now(),
              context: null,
            },
          ]);
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  function startPhaseTimers() {
    clearPhaseTimers();
    const t1 = setTimeout(() => setState((s) => s.view === "loading" ? { ...s, phase: 2 } : s), 2000);
    const t2 = setTimeout(() => setState((s) => s.view === "loading" ? { ...s, phase: 3 } : s), 5000);
    phaseTimerRef.current = t2; // store last one for cleanup
    // Store t1 in a closure — cleaned up via clearPhaseTimers if SEARCH_COMPLETE arrives
  }

  function clearPhaseTimers() {
    if (phaseTimerRef.current) clearTimeout(phaseTimerRef.current);
  }

  const handleSendMessage = useCallback((text: string) => {
    if (state.view !== "results") return;

    if (!chatActive) {
      setChatActive(true);
      setPriceBarCollapsed(true);
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      inputMode: "text",
      timestamp: Date.now(),
      context: chatMessages.length === 0 ? {
        currentProduct: state.product,
        searchResults: state.response.results,
      } : null,
    };

    const newMessages = [...chatMessages, userMessage];
    setChatMessages(newMessages);
    setChatLoading(true);

    const request: ChatRequest = {
      message: text,
      context: {
        product: state.product,
        results: state.response.results,
      },
      history: newMessages,
    };

    chrome.runtime.sendMessage({ type: "CHAT_REQUEST", request });
  }, [state, chatActive, chatMessages]);

  const handleRetry = () => {
    if (state.view === "error") {
      chrome.runtime.sendMessage({ type: "PRODUCT_CLICKED", product: state.product });
    }
  };

  // ── Loading phase text ──
  const phaseText = (phase: 1 | 2 | 3) => {
    switch (phase) {
      case 1: return "Identifying product...";
      case 2: return "Searching across marketplaces...";
      case 3: return "Comparing results...";
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background font-display">
      <Header />

      {state.view === "empty" && (
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <span className="material-icons text-5xl text-gray-300 mb-3 block">shopping_bag</span>
            <p className="text-text-muted text-sm">Click a product overlay to find better prices.</p>
          </div>
        </main>
      )}

      {state.view === "loading" && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-10 h-10 border-4 border-gray-200 border-t-primary rounded-full animate-spin mb-4" />
            <p className="text-sm text-text-muted animate-pulse">{phaseText(state.phase)}</p>
          </div>
        </main>
      )}

      {state.view === "error" && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="material-icons text-4xl text-gray-300 mb-3">error_outline</span>
            <p className="text-sm text-text-main mb-1">Couldn't find alternatives for this product.</p>
            <button
              onClick={handleRetry}
              className="mt-4 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors"
            >
              Try Again
            </button>
          </div>
        </main>
      )}

      {state.view === "results" && !chatActive && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 pb-40 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <PriceBar product={state.product} response={state.response} />

          {/* Results list */}
          <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
            <h3 className="font-semibold text-base mb-3 text-text-main">
              Top results ({state.response.results.length})
            </h3>
            <div className="space-y-3 divide-y divide-gray-100">
              {state.response.results.map((ranked) => (
                <div key={ranked.result.id} className="pt-3 first:pt-0">
                  <ResultCard ranked={ranked} />
                </div>
              ))}
            </div>
          </section>
        </main>
      )}

      {state.view === "results" && chatActive && (
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Compressed results (top ~40%) */}
          <div className="h-[40%] overflow-y-auto px-4 pt-3 pb-2 space-y-2 border-b border-gray-200 no-scrollbar">
            <ProductSection product={state.product} />
            <PriceBar
              product={state.product}
              response={state.response}
              collapsed={priceBarCollapsed}
              onToggle={() => setPriceBarCollapsed(!priceBarCollapsed)}
            />
            <div className="space-y-0.5">
              {state.response.results.map((ranked) => (
                <ResultCard key={ranked.result.id} ranked={ranked} compact />
              ))}
            </div>
          </div>

          {/* Chat area (bottom ~60%) */}
          <div className="h-[60%] flex flex-col">
            <ChatThread
              product={state.product}
              results={state.response.results}
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              isLoading={chatLoading}
            />
          </div>
        </main>
      )}

      {/* Input bar for results view (pre-split) */}
      {state.view === "results" && !chatActive && (
        <div className="sticky bottom-0 left-0 right-0 bg-background border-t border-gray-100">
          {/* Nudge */}
          <div className="px-4 pt-3 pb-1">
            <div className="bg-orange-50 border border-orange-100 rounded-xl p-2.5 flex items-center gap-2.5">
              <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0">
                <span className="material-icons text-xs">smart_toy</span>
              </div>
              <p className="text-xs text-text-main">I can help you compare — hold mic or type below.</p>
            </div>
          </div>

          {/* Input */}
          <div className="px-3 py-2.5">
            <ChatInputBar
              onSend={(text) => handleSendMessage(text)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ChatInputBar({ onSend }: { onSend: (text: string) => void }) {
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleMicClick = () => {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed", bottom: "70px", right: "20px",
      background: "#1a202c", color: "white", padding: "6px 12px",
      borderRadius: "8px", fontSize: "12px", zIndex: "9999",
    } as CSSStyleDeclaration);
    el.textContent = "Voice coming soon";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        placeholder="Ask about these..."
        className="flex-1 bg-white border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-text-main placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
      />
      {input.trim() ? (
        <button
          onClick={handleSubmit}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary-dark transition-colors"
        >
          <span className="material-icons text-lg">send</span>
        </button>
      ) : (
        <button
          onClick={handleMicClick}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 text-text-muted hover:bg-gray-200 transition-colors"
        >
          <span className="material-icons text-lg">mic</span>
        </button>
      )}
    </div>
  );
}
```

**Step 2: Typecheck the full extension**

```bash
pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck
```

Expected: no errors.

**Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/
git commit -m "feat(ext): side panel App with all states (empty, loading, results, chat, error)"
```

---

## Task 14: Build Verification + Final Fixes

**Files:** All extension files (fix any issues found)

**Step 1: Build shared**

```bash
pnpm build:shared
```

Expected: clean build.

**Step 2: Typecheck all packages**

```bash
pnpm typecheck
```

Expected: no type errors. If there are errors, fix them before proceeding.

**Step 3: Build extension**

```bash
pnpm build:ext
```

Expected: dist folder created with compiled extension.

**Step 4: Verify dist contents**

```bash
ls -la packages/extension/dist/
```

Expected: should contain `manifest.json`, compiled JS files, `sidepanel/index.html`.

**Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(ext): resolve build issues from Phase 2 integration"
```

**Step 6: Final commit for Phase 2**

```bash
git add -A
git commit -m "feat: complete Phase 2 extension UI implementation"
```

---

## Manual Testing Checklist (Post-Build)

Load the extension from `packages/extension/dist/` in `chrome://extensions` (Developer mode, Load unpacked).

1. **Empty state:** Open side panel via extension icon → shows "Personal Shopper" header + empty state message
2. **Product detection:** Navigate to an Amazon product page → overlay icon appears on product image within 200ms
3. **Overlay click:** Click overlay → side panel opens with loading state, phases cycle through
4. **Results display:** After backend responds → results render with price context bar, product cards, "You're Here" badge
5. **Cache hit:** Click same product overlay again → results appear instantly (no loading)
6. **Green dot:** Navigate away and return → overlay shows green dot for cached product
7. **Text chat:** Type in input bar → panel splits, results compress, chat response appears
8. **Mic placeholder:** Click mic button → tooltip "Voice coming soon" appears
9. **Error + retry:** Disconnect backend → click overlay → error state with "Try Again" button
10. **SPA navigation:** On a site with client-side routing → overlays update when URL changes

---

## File Summary

| Action | Path |
|--------|------|
| Create | `packages/extension/tailwind.config.ts` |
| Create | `packages/extension/postcss.config.js` |
| Create | `packages/extension/src/content/detection.ts` |
| Create | `packages/extension/src/content/overlay.ts` |
| Create | `packages/extension/src/background/cache.ts` |
| Create | `packages/extension/src/sidepanel/components/Header.tsx` |
| Create | `packages/extension/src/sidepanel/components/ProductSection.tsx` |
| Create | `packages/extension/src/sidepanel/components/PriceBar.tsx` |
| Create | `packages/extension/src/sidepanel/components/ResultCard.tsx` |
| Create | `packages/extension/src/sidepanel/components/ChatThread.tsx` |
| Modify | `packages/extension/src/sidepanel/App.tsx` |
| Modify | `packages/extension/src/sidepanel/index.css` (renamed from App.css) |
| Modify | `packages/extension/src/sidepanel/index.tsx` |
| Modify | `packages/extension/src/sidepanel/index.html` |
| Modify | `packages/extension/src/content/index.ts` |
| Modify | `packages/extension/src/background/index.ts` |
| Modify | `packages/extension/src/manifest.json` |
| Modify | `packages/extension/package.json` |
| Modify | `packages/shared/src/types.ts` |
