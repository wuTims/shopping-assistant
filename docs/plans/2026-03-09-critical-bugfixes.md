# Critical Bugfixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the three critical issues — broken overlay UX, 33s search latency, and wrong search results/prices — to make the extension functional for real-world use.

**Architecture:** The fixes restructure data flow to eliminate redundant Gemini calls, add server-side image cropping, remove dead-weight grounding, replace expensive AI ranking with a fast heuristic, and fix the overlay hover mechanics. The search endpoint gains an optional `identification` field so `/identify` results pass through without re-processing.

**Tech Stack:** TypeScript, Hono, Gemini API (`@google/genai`), Brave Search API, Chrome Extension MV3

**RCA Reference:** `docs/plans/2026-03-09-critical-bugfixes-rca.md`

---

## Task 1: Add Server-Side Image Cropping in `/identify`

The root cause of wrong search results: `imageRegion` is hardcoded to `null` (identify.ts:35). The screenshot is a full viewport PNG and we have bounding boxes from Gemini. We need to crop the product region server-side and return it as base64.

**Files:**
- Modify: `packages/backend/src/routes/identify.ts`
- Modify: `packages/backend/package.json` (add `sharp` dependency)

**Step 1: Install sharp for image cropping**

```bash
cd packages/backend && pnpm add sharp && pnpm add -D @types/sharp
```

**Step 2: Implement cropping in identify.ts**

Replace the response mapping (lines 29-37) with cropping logic:

```typescript
import sharp from "sharp";

// Inside the try block, after `const result = await Promise.race([...])`:

const screenshotBuffer = Buffer.from(base64Data, "base64");
const metadata = await sharp(screenshotBuffer).metadata();
const imgWidth = metadata.width ?? 1;
const imgHeight = metadata.height ?? 1;

const response: IdentifyResponse = {
  products: await Promise.all(
    result.products.map(async (p) => {
      let imageRegion: string | null = null;

      if (p.boundingBox) {
        try {
          // Clamp bounding box to image dimensions
          const x = Math.max(0, Math.round(p.boundingBox.x));
          const y = Math.max(0, Math.round(p.boundingBox.y));
          const w = Math.min(Math.round(p.boundingBox.width), imgWidth - x);
          const h = Math.min(Math.round(p.boundingBox.height), imgHeight - y);

          if (w > 10 && h > 10) {
            const cropped = await sharp(screenshotBuffer)
              .extract({ left: x, top: y, width: w, height: h })
              .png()
              .toBuffer();
            imageRegion = cropped.toString("base64");
          }
        } catch (err) {
          console.warn(`[identify] Cropping failed for "${p.name}":`, err);
        }
      }

      return {
        name: p.name,
        price: p.price,
        currency: p.currency,
        boundingBox: p.boundingBox,
        imageRegion,
      };
    }),
  ),
  pageType: result.pageType,
};
```

**Step 3: Verify build**

```bash
cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && cd packages/backend && pnpm tsc --noEmit
```

**Step 4: Commit**

```bash
git add packages/backend/src/routes/identify.ts packages/backend/package.json packages/backend/pnpm-lock.yaml
git commit -m "fix(backend): implement server-side image cropping in /identify

imageRegion was hardcoded to null ('cropping deferred to client'), but the
client never implemented cropping. This caused the full viewport screenshot
to be sent to /search, leading to wrong product identification."
```

---

## Task 2: Pass Identification Through to `/search` — Eliminate Double Gemini Call

The `/search` endpoint always calls `identifyProduct()` even though `/identify` already identified the product. Add an optional `identification` field to `SearchRequest` so the service worker can forward the result.

**Files:**
- Modify: `packages/shared/src/types.ts` — add `identification` to `SearchRequest`
- Modify: `packages/backend/src/routes/search.ts` — skip `identifyProduct()` when identification provided
- Modify: `packages/extension/src/background/index.ts` — forward identification in search request

**Step 1: Extend SearchRequest type**

In `packages/shared/src/types.ts`, add to `SearchRequest` (after line 59):

```typescript
export interface SearchRequest {
  imageUrl: string | null;
  imageBase64: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  sourceUrl: string;
  /** Pre-computed identification from /identify — skips redundant Gemini call in /search */
  identification?: ProductIdentification | null;
}
```

**Step 2: Update search.ts to use provided identification**

In `packages/backend/src/routes/search.ts`, replace Phase 1 identification (lines 60-83) to check for pre-provided identification:

```typescript
// ── Phase 1: identify product + brave(title queries) in parallel ──────────

const imageSource = body.imageUrl
  ? body.imageUrl
  : { data: body.imageBase64!, mimeType: "image/png" } as FetchedImage;

const titleQueries = buildTitleQueries(body.title, body.sourceUrl);

let identification: ProductIdentification;
let originalImage: FetchedImage;

if (body.identification) {
  // Use pre-computed identification from /identify — skip redundant Gemini call
  identification = body.identification;
  originalImage = typeof imageSource === "string"
    ? await fetchImage(imageSource)
    : imageSource;
  console.log(`[search:${requestId}] Using provided identification: ${identification.category} — ${identification.description}`);
} else {
  // No identification provided — identify from scratch (overlay click path)
  const [identifyResult, titleBraveResult_] = await Promise.allSettled([
    identifyProduct(imageSource, body.title),
    titleQueries.length > 0
      ? withTimeout(searchProducts(titleQueries), Math.max(remaining() - 1000, 5000))
      : Promise.resolve(emptyProviderOutcome()),
  ]);

  if (identifyResult.status === "rejected") {
    console.error(`[search:${requestId}] Product identification failed:`, identifyResult.reason);
    const message = identifyResult.reason instanceof Error ? identifyResult.reason.message : "Unknown error";
    return c.json({ error: "product_identification_failed", message, requestId }, 422);
  }

  identification = identifyResult.value.identification;
  originalImage = identifyResult.value.originalImage;
  console.log(`[search:${requestId}] Identified: ${identification.category} — ${identification.description}`);
}
```

Note: when identification is provided, the title Brave search should still run. Adjust accordingly so it's always kicked off in parallel with whatever identification path is taken.

**Step 3: Update service worker to forward identification**

In `packages/extension/src/background/index.ts`, update `identifiedToDisplay` to carry identification, and forward it in `searchForProduct`.

Add identification to the `ProductDisplayInfo` flow. The cleanest approach: store identification on the product object and include it in the search request.

In the icon click handler (around line 72-75), pass identification through:

```typescript
// After identifying, store identification for search
const product = identified.products[0];
const displayProduct = identifiedToDisplay(product);
```

Update `searchForProduct` signature and body (around line 191-224) to accept and forward identification:

```typescript
async function searchForProduct(
  tabId: number,
  product: ProductDisplayInfo,
  screenshotDataUrl: string,
  pageUrl: string,
  imageUrl?: string,
  identification?: ProductIdentification | null,
): Promise<void> {
  // ... cache check unchanged ...

  const searchReq: SearchRequest = {
    imageUrl: imageUrl ?? product.imageUrl ?? null,
    imageBase64: !imageUrl
      ? (croppedBase64 ?? (screenshotDataUrl
        ? (screenshotDataUrl.includes(",")
          ? screenshotDataUrl.split(",")[1]
          : screenshotDataUrl)
        : null))
      : null,
    title: product.name !== "Product" ? product.name : null,
    price: product.price,
    currency: product.currency,
    sourceUrl: pageUrl,
    identification: identification ?? null,
  };
```

Also update all call sites of `searchForProduct` to pass identification when available.

**Step 4: Build and typecheck**

```bash
pnpm build:shared && pnpm typecheck
```

**Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/backend/src/routes/search.ts packages/extension/src/background/index.ts
git commit -m "fix(search): eliminate double Gemini identification call

SearchRequest now accepts optional pre-computed identification from /identify.
When provided, /search skips its own identifyProduct() call, saving 3-8 seconds
and one Gemini API call per request."
```

---

## Task 3: Remove Gemini Grounding — 100% Timeout, 0 Value

E2E test confirmed grounding times out on every query and returns 0 results. Remove it.

**Files:**
- Modify: `packages/backend/src/routes/search.ts` — remove grounding from Phase 2
- Modify: `packages/shared/src/types.ts` — remove grounding from SearchResponse meta (optional, can keep for compat)

**Step 1: Remove grounding from search.ts Phase 2**

In `packages/backend/src/routes/search.ts`, replace the Phase 2 `Promise.allSettled` (lines 103-112):

```typescript
// ── Phase 2: parallel search — brave(AI) + brave(marketplace) ────────────

const aiQueries = identification.searchQueries;
const marketplaceQueries = generateMarketplaceQueries(
  identification.description || body.title || "",
);
const phase2Deadline = Math.max(remaining() - 4000, 3000);

const skipAiBrave = !hasNewQueries(aiQueries, titleQueries);

const [aiBraveResult, marketplaceBraveResult] =
  await Promise.allSettled([
    skipAiBrave
      ? Promise.resolve(emptyProviderOutcome())
      : withTimeout(searchProducts(aiQueries), phase2Deadline),
    marketplaceQueries.length > 0
      ? withTimeout(searchProducts(marketplaceQueries), phase2Deadline)
      : Promise.resolve(emptyProviderOutcome()),
  ]);
```

Update result merging to remove grounding references:

```typescript
const allResults = [...braveOutcome.results];
```

Keep grounding fields in the response as `{ status: "ok", totalQueries: 0, ... }` for backward compatibility with the side panel.

**Step 2: Remove grounding import (cleanup)**

Remove the `groundedSearch` import from search.ts since it's no longer called.

**Step 3: Typecheck**

```bash
pnpm build:shared && pnpm typecheck
```

**Step 4: Commit**

```bash
git add packages/backend/src/routes/search.ts
git commit -m "perf(search): remove Gemini Grounding from search pipeline

E2E testing confirmed 100% timeout rate with 0 results returned.
Grounding results also lacked price and image data. Removing it
saves 3-8 seconds of wasted time budget per request."
```

---

## Task 4: Replace Expensive AI Ranking with Fast Heuristic

AI ranking takes 17+ seconds — over half the total pipeline. Replace with the existing `buildFallbackScores` heuristic as the primary ranking, making the pipeline ~15 seconds faster. The heuristic already considers title overlap, brand match, price proximity, and marketplace reputation.

**Files:**
- Modify: `packages/backend/src/routes/search.ts` — use heuristic ranking by default, remove AI ranking call

**Step 1: Replace Phase 4 in search.ts**

Replace Phase 4 (lines 190-217) with:

```typescript
// ── Phase 4: ranking ─────────────────────────────────────────────────────

const rankStart = Date.now();
const scores = buildFallbackScores(capped, identification);
const rankingDurationMs = Date.now() - rankStart;
const rankingStatus: "ok" | "fallback" = "ok";
const rankingFailureReason: string | null = null;

const ranked = applyRanking(capped, scores, body.price);
```

Remove unused imports: `rankResults`, `RankingOutputValidationError`, `FetchedImage` (for ranking), and `MAX_IMAGES_FOR_RANKING`, `RANKING_IMAGE_TIMEOUT_MS`.

Also remove the image fetching block (lines 172-186) since it was only needed for AI ranking. This removes another 3-second delay.

**Step 2: Typecheck**

```bash
pnpm build:shared && pnpm typecheck
```

**Step 3: Commit**

```bash
git add packages/backend/src/routes/search.ts
git commit -m "perf(search): replace AI ranking with fast heuristic scoring

AI ranking took 17+ seconds (single Gemini call for 15 results with images).
The heuristic scorer uses title overlap, brand match, price proximity, and
marketplace reputation — runs in <1ms. Also removes image fetching phase
that was only needed for AI ranking."
```

---

## Task 5: Add Hard Request-Level Timeout

The `SEARCH_TIMEOUT_MS` budget wasn't enforced at the request level. Add an `AbortController` to cut off runaway requests.

**Files:**
- Modify: `packages/backend/src/routes/search.ts`

**Step 1: Add AbortController at request entry**

At the top of the POST handler (after line 53), add:

```typescript
const abortController = new AbortController();
const requestTimer = setTimeout(() => abortController.abort(), SEARCH_TIMEOUT_MS);

try {
  // ... existing pipeline ...
} finally {
  clearTimeout(requestTimer);
}
```

This is a safety net. With Tasks 2-4 applied, the pipeline should complete well within 20 seconds, but this prevents any future regression from causing unbounded latency.

**Step 2: Typecheck**

```bash
pnpm typecheck
```

**Step 3: Commit**

```bash
git add packages/backend/src/routes/search.ts
git commit -m "fix(search): add hard request-level timeout with AbortController

Prevents unbounded response times when sub-tasks overrun their budgets.
The remaining() function only calculated phase budgets but nothing
enforced the overall SEARCH_TIMEOUT_MS at the request level."
```

---

## Task 6: Fix Overlay Flickering and Hover Mechanics

Two problems: 80ms debounce is too short, and there's a spatial gap between image edge and overlay icon.

**Files:**
- Modify: `packages/extension/src/content/overlay.ts`
- Modify: `packages/shared/src/constants.ts`

**Step 1: Increase hide debounce and add invisible hit area**

In `packages/shared/src/constants.ts`, add:

```typescript
export const OVERLAY_HIDE_DELAY_MS = 200;
```

In `packages/extension/src/content/overlay.ts`:

1. Import the new constant:

```typescript
import {
  OVERLAY_ICON_SIZE_PX,
  OVERLAY_ICON_HOVER_SIZE_PX,
  MIN_IMAGE_SIZE_PX,
  OVERLAY_TITLE_HINT_MAX_LENGTH,
  OVERLAY_HIDE_DELAY_MS,
} from "@shopping-assistant/shared";
```

2. Replace the overlay creation function to add an invisible 12px padding (hit area) around the icon. Add to the overlay element styles:

```typescript
// In createOverlayIcon, add padding to the overlay element to extend its hover area:
Object.assign(el.style, {
  position: "absolute",
  width: `${OVERLAY_ICON_SIZE_PX}px`,
  height: `${OVERLAY_ICON_SIZE_PX}px`,
  borderRadius: "50%",
  background: "rgba(255, 255, 255, 0.92)",
  border: "1px solid #e5e7eb",
  boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
  cursor: "pointer",
  zIndex: "999999",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "transform 0.15s ease, box-shadow 0.15s ease",
  pointerEvents: "auto",
  // Invisible hit area: extend hover zone 12px in all directions
  padding: "12px",
  margin: "-12px",
  boxSizing: "content-box",
});
```

3. Replace `scheduleHide()` to use the new constant:

```typescript
function scheduleHide(): void {
  if (hideTimeout) clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    if (!activeOverlay) return;
    hideOverlay();
  }, OVERLAY_HIDE_DELAY_MS);
}
```

4. Fix the `mouseleave` on image to also check if mouse is over the parent container (which holds the overlay):

```typescript
img.addEventListener("mouseleave", (e) => {
  const related = e.relatedTarget as Node | null;
  if (activeOverlay && related) {
    // Don't hide if mouse moved to overlay or its parent container
    if (activeOverlay.el.contains(related) || activeOverlay.el === related) return;
  }
  scheduleHide();
});
```

**Step 2: Build extension**

```bash
pnpm build:shared && cd packages/extension && pnpm tsc --noEmit
```

**Step 3: Commit**

```bash
git add packages/shared/src/constants.ts packages/extension/src/content/overlay.ts
git commit -m "fix(overlay): eliminate hover flickering with larger hit area and debounce

Increased hide delay from 80ms to 200ms and added 12px invisible padding
around the overlay icon. This bridges the spatial gap between image edge
and overlay, preventing the rapid show/hide loop when hovering near edges."
```

---

## Task 7: Improve Search Query Quality and Price Parsing

The search queries aren't shopping-specific enough (returning review articles), and price parsing grabs prices from non-shopping content.

**Files:**
- Modify: `packages/backend/src/services/gemini.ts` — update identification prompt for shopping-specific queries
- Modify: `packages/backend/src/services/brave.ts` — filter non-shopping results, improve price parsing

**Step 1: Update identification prompt**

In `packages/backend/src/services/gemini.ts`, update the prompt in `identifyProduct()` (lines 32-37):

```typescript
const prompt = [
  "You are a product identification expert for a shopping comparison tool.",
  "Analyze the product image and any provided title.",
  "Identify the product category, brand, key attributes, and generate 2-3 SHOPPING search queries.",
  "Search queries MUST include shopping intent words like 'buy', 'price', 'shop', or 'for sale'.",
  "Queries should find this exact product or very similar alternatives on shopping sites like Amazon, eBay, Walmart, AliExpress.",
  "Example good queries: 'buy Nike Air Max 90 white men', 'Nike Air Max 90 price comparison'",
  title ? `Product title from the page: "${title}"` : "No product title available — rely on the image.",
].join("\n");
```

**Step 2: Filter non-shopping web results in brave.ts**

In `packages/backend/src/services/brave.ts`, add a filter after extracting web results. Only add web results as products if they look like shopping pages (have product_cluster OR their URL is from a known marketplace):

```typescript
// After the product_cluster extraction loop (line 75), only add the web
// result itself if it has a product_cluster or is from a known shopping domain:
const isShoppingSite = isKnownMarketplace(item.url);
if (item.product_cluster?.length || isShoppingSite) {
  const parsed = parsePriceFromSnippets(item);
  queryResults.push({
    // ... existing web result ...
  });
}
```

Add a helper:

```typescript
const SHOPPING_DOMAINS = new Set([
  "amazon.com", "amazon.co.uk", "amazon.de", "amazon.co.jp",
  "ebay.com", "ebay.co.uk",
  "walmart.com", "target.com", "bestbuy.com", "newegg.com",
  "aliexpress.com", "dhgate.com", "temu.com", "1688.com",
  "etsy.com", "costco.com", "bhphotovideo.com",
  "homedepot.com", "lowes.com", "wayfair.com",
  "zappos.com", "nordstrom.com", "macys.com",
]);

function isKnownMarketplace(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return SHOPPING_DOMAINS.has(hostname) ||
      [...SHOPPING_DOMAINS].some((d) => hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
```

**Step 3: Typecheck**

```bash
pnpm build:shared && pnpm typecheck
```

**Step 4: Commit**

```bash
git add packages/backend/src/services/gemini.ts packages/backend/src/services/brave.ts
git commit -m "fix(search): improve query quality and filter non-shopping results

Updated identification prompt to require shopping-intent keywords in queries.
Added shopping domain filter to Brave results so review articles, news posts,
and forum links are excluded. Only product_cluster results and known
marketplace pages are kept."
```

---

## Task 8: Lower Overlay Image Size Threshold

`MIN_IMAGE_SIZE_PX = 100` filters out many legitimate product thumbnails.

**Files:**
- Modify: `packages/shared/src/constants.ts`

**Step 1: Lower threshold**

```typescript
export const MIN_IMAGE_SIZE_PX = 60;
```

This captures thumbnails down to 60px while still filtering tiny icons and decorative images.

**Step 2: Build and typecheck**

```bash
pnpm build:shared && pnpm typecheck
```

**Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "fix(overlay): lower image size threshold from 100px to 60px

100px filtered out most product thumbnails on listing pages (typically
60-90px). Lowering to 60px ensures overlays appear on thumbnail grids."
```

---

## Task 9: E2E Verification

Run the same e2e test to confirm all fixes work together.

**Step 1: Start backend and run test**

Write a quick test script that:
- Sends a known product image URL to `POST /search` with identification pre-filled
- Verifies response time is under 15 seconds
- Verifies results contain shopping pages (not review articles)
- Verifies prices are from `product_cluster` data (not snippet-parsed review text)

**Step 2: Test overlay manually**

Load the extension in Chrome, navigate to a product listing page, verify:
- Overlays appear on thumbnail images (60px+)
- No flickering when hovering near image edges
- Clicking overlay triggers search with correct product

**Step 3: Commit test script (if kept)**

```bash
git add test-e2e.mjs
git commit -m "test: add e2e verification script for search pipeline"
```

---

## Expected Impact After All Fixes

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Path A total time | 35+ seconds | ~8-12 seconds | 3x faster |
| Path B total time | 33+ seconds | ~6-10 seconds | 3-5x faster |
| Gemini API calls per search | 3-4 (identify + search-identify + grounding + ranking) | 1 (identify only) | 75% reduction |
| Search result relevance | Mix of reviews/articles/shopping | Shopping pages only | Accurate |
| Price accuracy | Snippet-parsed from reviews | `product_cluster` data from Brave | Reliable |
| Overlay coverage | Main image only | All images 60px+ | Full coverage |
| Overlay flickering | Constant near edges | Eliminated | Fixed |

---

## Task Dependency Graph

```
Task 1 (image cropping) ──┐
                           ├── Task 2 (pass identification) ── Task 5 (request timeout)
Task 3 (remove grounding) ─┤
                           ├── Task 4 (heuristic ranking)
Task 7 (query quality) ────┘
                                                              ── Task 9 (e2e verification)
Task 6 (overlay flickering) ──────────────────────────────────┘
Task 8 (size threshold) ──────────────────────────────────────┘
```

Tasks 1, 3, 6, 7, 8 are independent and can be parallelized.
Task 2 depends on Task 1 (needs imageRegion to be populated).
Task 4 depends on Task 3 (removing grounding simplifies the pipeline).
Task 5 depends on Tasks 2+4 (timeout wraps the final pipeline shape).
Task 9 depends on all others.
