# Root Cause Analysis: Critical Extension Issues

**Date:** 2026-03-09
**Status:** Confirmed via e2e testing against live backend

---

## Issue 1: Overlay Only Shows on Main Product Image + Flickering

### Symptoms
- Overlay icon only appears on the hero/main product image, not thumbnails or secondary images
- When hovering near the image edge, the overlay flickers rapidly (shows/hides in a loop)

### Root Causes

**1a. Size threshold too aggressive — `MIN_IMAGE_SIZE_PX = 100`**
- File: `packages/shared/src/constants.ts:26`
- Product thumbnails on listing pages are typically 60–90px
- Only the main product image (400px+) passes the 100px threshold
- Both `width >= 100 AND height >= 100` must pass — `overlay.ts:147`

**1b. Flickering: spatial gap + short debounce**
- File: `packages/extension/src/content/overlay.ts:83-84,111-117`
- Overlay is positioned 8px from the image corner within the parent element
- When mouse exits the image boundary heading toward the overlay, there's a DOM gap
- `mouseleave` fires on the image → `scheduleHide()` starts 80ms countdown
- If mouse doesn't reach the overlay within 80ms, overlay disappears
- Mouse then re-enters the image → overlay reappears → flicker loop
- The `relatedTarget` check (line 136) only helps when mouse goes directly to the overlay element, not when it passes through intermediate DOM nodes (parent padding, borders)

**1c. Overlay is destroyed and recreated each time**
- `hideOverlay()` calls `el.remove()` (line 125), then `showOverlay()` creates a brand new element
- This means every flicker cycle creates/destroys DOM nodes
- Also re-adds event listeners each time (lines 107-108)

---

## Issue 2: Search Pipeline Takes 33+ Seconds (Budget: 20s)

### Symptoms
- Full search takes 30-35 seconds end-to-end
- UI feels unresponsive, user waits a long time

### Root Causes

**2a. Double Gemini identification (Path A: extension icon click)**
- Files: `packages/backend/src/routes/identify.ts`, `packages/backend/src/routes/search.ts:68-69`
- Path A flow: `POST /identify` → Gemini `identifyFromScreenshot()` (call #1, ~2-5s)
  → then `POST /search` → Gemini `identifyProduct()` (call #2, ~3-8s)
- Two sequential Gemini calls identify the same product
- The `/search` endpoint always re-identifies, ignoring what `/identify` already found
- Cost: ~5-13 seconds of redundant AI processing

**2b. Gemini Grounding always times out — 0 results**
- File: `packages/backend/src/services/gemini.ts:168-238`
- E2E test: all 3 grounding queries timed out, 0 results returned
- Grounding uses `googleSearch` tool which is slow and unreliable
- Results lack price and imageUrl (hardcoded to `null` on lines 197-198)
- Even when successful, grounding results are low-quality compared to Brave
- Cost: consumes time budget in Phase 2 with no value

**2c. AI Ranking is the dominant bottleneck — 17.4 seconds**
- File: `packages/backend/src/services/gemini.ts:249-317`
- Single Gemini call to rank all 15 capped results with images
- Sends original image + up to 5 result images + text descriptions for all 15
- Gemini 2.5 Flash "thinking" model is slow for this multi-image comparison task
- Must wait for all image fetching to complete before starting
- Cost: 17+ seconds, more than half the total pipeline time

**2d. No hard request-level timeout**
- File: `packages/backend/src/routes/search.ts:56`
- `remaining()` calculates time budgets for phases but nothing aborts the overall request
- If sub-tasks overrun their budgets, total time balloons beyond 20 seconds
- No `AbortController` wrapping the request handler

**2e. Price fallback via Playwright is expensive**
- File: `packages/backend/src/services/price-fallback.ts`
- Launches headless Chromium, navigates each URL, screenshots, then Gemini Vision extraction
- Each URL: ~2-5s (nav timeout + 500ms wait + screenshot + Gemini call)
- Up to 5 URLs → 10-25 seconds if done serially (they're parallel but still heavy)

---

## Issue 3: Wrong Screenshot, Bad Search Results, Wrong Prices

### Symptoms
- Product identification doesn't match the product the user intended
- Search results return the product's own website at higher prices
- Prices shown are clearly wrong (review article mentions, shipping costs, "was" prices)

### Root Causes

**3a. `imageRegion: null` — cropping never happens (THE SMOKING GUN)**
- File: `packages/backend/src/routes/identify.ts:35`
- ```typescript
  imageRegion: null, // Cropping deferred to client
  ```
- But the client (service worker) never implements cropping
- `identifiedToDisplay()` in `background/index.ts:178` creates `displayImageDataUrl` from `product.imageRegion` — which is always null
- So `croppedBase64` at `background/index.ts:210` is always `undefined`
- Falls back to full viewport screenshot (lines 214-218)
- The `/search` endpoint receives the entire browser viewport, not the product image
- Gemini must re-identify from a cluttered full-page screenshot → unreliable

**3b. Search queries are generic, not shopping-specific**
- The `identifyProduct` prompt (gemini.ts:33-37) asks for "marketplace search queries"
- But Gemini generates generic queries like "Apple MacBook Air Space Gray" without shopping intent
- These return review articles, news pages, and forum posts — not shopping results
- Brave's `result_filter: "web"` (brave.ts:37) doesn't filter to shopping-only results

**3c. Price parsing grabs wrong prices from snippets**
- File: `packages/backend/src/services/brave.ts:128-161`
- `parsePriceFromSnippets()` grabs the FIRST `$XX.XX` pattern from description/snippets
- Review articles contain prices in text ("the $999 MacBook Air...") → parsed as product price
- Shipping costs, "was" prices, bundle prices, unrelated numbers all match the regex
- No validation that the price comes from a product listing vs. editorial content

**3d. Brave web results include non-shopping pages**
- File: `packages/backend/src/services/brave.ts:56-91`
- Every web result is added (line 77-91), even if it's a review, news article, or forum post
- Only `product_cluster` results (lines 57-75) are actual shopping results
- The dedup/ranking treats all results equally

**3e. Grounding results are priceless and imageless**
- File: `packages/backend/src/services/gemini.ts:192-204`
- `price: null, currency: null, imageUrl: null` hardcoded for all grounding results
- These low-quality results dilute the result pool and may displace better Brave results during capping

---

## E2E Test Evidence

### Path B Test (overlay click → /search with known image URL)
- **Total time:** 33,732ms (68% over 20s budget)
- **Gemini identification:** Correctly identified product from direct image URL
- **Grounding:** 3/3 queries timed out, 0 results
- **Brave:** 8/8 queries succeeded, 80 results → 76 after dedup → 15 capped
- **Ranking:** 17,406ms — single Gemini call, the dominant bottleneck
- **Price issues:** $300 (stale Amazon), $50 GBP (Good Housekeeping review text), $999 (Android Authority review text), $250 (Best Buy category page)
- **Result quality:** Mix of shopping pages and review articles ranked equally

### Path A Test (icon click → /identify → /search with base64 screenshot)
- **`/identify`:** 2,290ms — found 1 product, `imageRegion: NULL` confirmed
- **`/search`:** Hit Gemini rate limit (429) — confirms double-identification Gemini call overhead
- The rate limit itself is evidence of excessive Gemini API usage

---

## Impact Summary

| Issue | User Impact | Severity |
|-------|------------|----------|
| `imageRegion: null` | Wrong product identified, wrong search results | **Critical** |
| Double identification | ~5-13s wasted, extra API cost, rate limit risk | **Critical** |
| Grounding always times out | Wasted time budget, 0 value | **High** |
| AI Ranking 17+ seconds | Unacceptable wait time | **High** |
| No request-level timeout | Unbounded response time | **High** |
| Wrong price parsing | Misleading price comparisons | **High** |
| Overlay flickering | Poor UX, feels broken | **Medium** |
| Overlay size threshold | Missed product images on listing pages | **Medium** |
