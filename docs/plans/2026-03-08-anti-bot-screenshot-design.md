# Anti-Bot & Screenshot-Based Detection Design

**Date:** 2026-03-08
**Status:** Approved

## Problem Statement

Three issues with the current architecture:

1. **Bot detection:** The content script injects overlays and queries DOM selectors on Amazon/eBay/Walmart product pages. These sites detect the extension via browser fingerprinting, DOM mutation analysis, and behavioral patterns. Amazon flags the session in cookies and server-side state — prices disappear ("Currently unavailable"), and the issue persists even after removing the extension until cookies are cleared.

2. **N/A prices:** Search results frequently show no price. Brave API metadata lacks structured pricing for many results. Gemini Grounding returns URLs without prices. There is no fallback mechanism.

3. **Insufficient Chinese marketplace coverage:** Only AliExpress is recognized in the marketplace list. Search queries are generic English and don't target Chinese platforms like DHgate, Temu, or 1688.

## Solution Overview

| Problem | Solution |
|---------|----------|
| Bot detection | Screenshot via `captureVisibleTab()`, no content script, Gemini identifies product from screenshot |
| N/A prices | Brave first, then Gemini Vision screenshot fallback (headless Playwright) for top ~5 results still missing prices. Filter N/A from displayed results, keep in response for debugging |
| Chinese marketplaces | Targeted `site:` queries for AliExpress, DHgate, Temu, 1688 via Brave |

## Section 1: Screenshot-Based Product Detection

Replaces the content script + overlay approach entirely.

### Trigger

User clicks the extension icon or presses a keyboard shortcut while on any product page.

### Flow

1. Service worker calls `chrome.tabs.captureVisibleTab()` → base64 PNG of visible viewport
2. Sends screenshot to new backend endpoint: `POST /identify`
3. Gemini Flash analyzes screenshot: "Identify all products visible. For each: product name, price, currency, approximate bounding box."
4. **One product** found (detail page) → auto-select, immediately start search pipeline
5. **Multiple products** found (listing page) → side panel shows selection grid with thumbnails, names, and prices; user picks one
6. Selected product's info feeds into the existing `POST /search` pipeline

### Changes

- **Remove:** Content script entirely (`packages/extension/src/content/`), `content_scripts` from manifest, `<all_urls>` match pattern
- **Add:** `POST /identify` backend endpoint
- **Modify:** Service worker — icon click → screenshot → identify → search flow
- **Modify:** Side panel — product selection grid for multi-product pages
- **Permissions:** Only `activeTab` (granted on user click), `sidePanel`, `storage`. No host permissions.

### Why This Solves Bot Detection

`chrome.tabs.captureVisibleTab()` runs entirely in the service worker. Nothing is injected into the page. Amazon's JavaScript has zero awareness the extension exists. No content script means no DOM mutations, no DOM queries, no extension fingerprint on the page.

## Section 2: Price Extraction — Brave + Gemini Vision Fallback

### Problem

Brave API returns structured prices inconsistently. Gemini Grounding returns URLs without prices. Many results display N/A.

### Flow

1. Existing Brave + Gemini Grounding pipeline runs as-is → merged results
2. After merge/dedup, partition results into `withPrice` and `withoutPrice`
3. For the top ~5 `withoutPrice` results (sorted by heuristic pre-score), backend fetches each URL server-side using headless Playwright, takes a screenshot
4. Each screenshot → Gemini Flash: "Extract the product price and currency from this page screenshot."
5. Results with successfully extracted prices get updated; remaining stay N/A
6. **Display filtering:** Side panel only renders results with a price. N/A results stay in `SearchResponse.results` with `priceAvailable: false` for debugging

### Changes

- **Add:** Playwright dependency on backend (headless Chromium for server-side screenshots)
- **Add:** `screenshotAndExtractPrice()` function in Gemini service
- **Modify:** Search pipeline in `routes/search.ts` — add price fallback phase between merge/dedup and ranking
- **Modify:** `RankedResult` type — add `priceAvailable` boolean field
- **Modify:** Side panel — filter display to `priceAvailable === true` only

### Timeout Budget

This phase gets up to 5 seconds within the existing 15s search timeout. If it can't finish, results stay N/A and get filtered from display.

## Section 3: Chinese Marketplace Coverage

### Problem

Only AliExpress is in the recognized marketplace list. Generic English queries rarely surface results from DHgate, Temu, 1688.

### Flow

1. After Gemini identifies the product and generates search queries, backend generates additional targeted queries: `"[product name] site:aliexpress.com"`, `"[product name] site:dhgate.com"`, `"[product name] site:temu.com"`, `"[product name] site:1688.com"`
2. These run as parallel Brave API calls alongside existing Brave + Grounding searches (Phase 2 of the pipeline)
3. Results merge into the same dedup/ranking pipeline

### Changes

- **Add:** DHgate, Temu, 1688 to recognized marketplace list in `utils/marketplace.ts`
- **Add:** `generateMarketplaceQueries()` utility — takes product name → returns `site:` queries for target marketplaces
- **Modify:** Search pipeline Phase 2 in `routes/search.ts` — fire marketplace-targeted Brave queries in parallel with existing searches
- **Modify:** Price regex in `brave.ts` — add ¥ (CNY/JPY) pattern support
- **Consider:** Brave API rate limits — adds ~4 extra API calls per search. May need to limit to 2-3 highest-priority marketplaces

### No Changes To

Gemini Grounding, ranking, or dedup logic. All new results flow through the same pipeline.

## Data Model Changes

### New Type: `IdentifyRequest`

```typescript
interface IdentifyRequest {
  screenshot: string; // base64 PNG from captureVisibleTab
  pageUrl: string;    // current tab URL for context
}
```

### New Type: `IdentifiedProduct`

```typescript
interface IdentifiedProduct {
  name: string;
  price: number | null;
  currency: string | null;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  imageRegion: string | null; // base64 cropped image of the product
}
```

### New Type: `IdentifyResponse`

```typescript
interface IdentifyResponse {
  products: IdentifiedProduct[];
  pageType: 'product_detail' | 'product_listing' | 'unknown';
}
```

### Modified Type: `RankedResult`

```typescript
// Add field:
priceAvailable: boolean; // false when price is N/A after all extraction attempts
```

## API Changes

### New Endpoint: `POST /identify`

- **Input:** `IdentifyRequest`
- **Output:** `IdentifyResponse`
- **Purpose:** Accepts a page screenshot, returns identified products with prices extracted visually

### Modified Endpoint: `POST /search`

- Accepts `imageBase64` from the cropped product region (instead of requiring a product page image URL)
- Pipeline gains a new phase between merge/dedup and ranking: price fallback via Playwright screenshots + Gemini Vision

## Architecture Diagram

```
User clicks extension icon
        │
        ▼
Service Worker: captureVisibleTab()
        │
        ▼
POST /identify (screenshot → Gemini Flash)
        │
        ├─ 1 product → auto-select
        └─ N products → side panel selection grid
                │
                ▼
        User selects product
                │
                ▼
POST /search (product info + image region)
        │
        ▼
Phase 1: Gemini identifies product, generates queries
        │
        ▼
Phase 2: Parallel searches
        ├─ Gemini Grounding (existing)
        ├─ Brave Search (existing queries)
        └─ Brave Search (site: queries for AliExpress, DHgate, Temu, 1688)  ← NEW
        │
        ▼
Phase 3: Merge, dedup, pre-sort
        │
        ▼
Phase 3.5: Price fallback  ← NEW
        ├─ Partition: withPrice / withoutPrice
        ├─ Top 5 withoutPrice → Playwright screenshot → Gemini Vision → extract price
        └─ Tag remaining N/A results with priceAvailable: false
        │
        ▼
Phase 4: AI ranking (existing)
        │
        ▼
Response (all results; side panel filters priceAvailable === true)
```
