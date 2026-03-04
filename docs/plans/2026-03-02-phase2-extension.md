# Phase 2: Extension Implementation

**Date:** 2026-03-02
**Depends on:** Phase 1 backend complete
**Aligned with:** `docs/plans/2026-03-02-mvp-implementation.md`, `docs/plans/2026-03-02-mvp-implementation-design.md`

## Goal
Deliver a working Chrome extension flow:
- Detect product candidates on Amazon/eBay pages
- Inject clickable overlays
- Route search through background worker with cache
- Render side panel states (empty/loading/results/chat/error)

Phase complete when a user can click an overlay on a live product page and complete search + text chat in the side panel.

## Task 1: Contract and Manifest Readiness
**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/extension/src/manifest.json`

**Requirements:**
1. Ensure runtime message payloads are structured-clone safe.
   - Replace `DetectedProduct.boundingRect: DOMRect` with a plain serializable rect object shape (for example: `{ x, y, width, height, top, right, bottom, left }`).
   - Send only plain JSON objects through `chrome.runtime.sendMessage` (no browser class instances).
2. Add backend host access for dev:
   - `host_permissions` should include backend origin (for example `http://localhost:8080/*`).
3. Ensure extension pages may connect to backend HTTP/WS endpoints in dev (manifest CSP/connect-src if required by runtime behavior).

**Why this matters:**
Missing host permissions and non-serializable payloads are common causes of silent runtime failures in MV3.

## Task 2: Content Script Detection and Overlay Injection
**File:** `packages/extension/src/content/index.ts`

Implement detection heuristics in priority order:
1. JSON-LD Product schema
2. Open Graph product metadata
3. Amazon-specific DOM selectors
4. eBay-specific DOM selectors
5. Generic fallback: image near price-like text pattern

Then:
- Deduplicate candidate products
- Limit overlays with shared constants (`MAX_OVERLAYS_PER_PAGE`, `MIN_IMAGE_SIZE_PX`)
- Inject overlay button on valid images
- Show green dot indicator on overlay icon when cached results exist for that product (check `chrome.storage.local` for `search_{productId}` key with valid TTL)
- Send `PRODUCT_CLICKED` and `PRODUCTS_DETECTED` messages
- Re-run detection on SPA URL changes using `MutationObserver`

## Task 3: Background Service Worker Routing + Cache
**File:** `packages/extension/src/background/index.ts`

Implement message handling for:
- `PRODUCT_CLICKED`
- `PRODUCTS_DETECTED`
- `CHAT_REQUEST`
- `GET_BACKEND_URL`

Implement behavior:
- Open side panel for clicked product
- Cache lookup in `chrome.storage.local` keyed by product ID
- Cache TTL/LRU enforcement using shared constants
- Cache miss -> call backend `/search`
- Forward `SEARCH_STARTED`, `SEARCH_COMPLETE`, `SEARCH_ERROR` to side panel
- Chat passthrough to backend `/chat`
- Cleanup of stale cache entries on startup/install

## Task 4: Side Panel App (Self-Contained Requirements)
**Files:**
- `packages/extension/src/sidepanel/App.tsx`
- `packages/extension/src/sidepanel/App.css`

Implement these views and transitions:
1. Empty state
2. Loading state with 4 progressive phases
3. Results state with ranked cards and price context
4. Chat state with message thread + text input
5. Error state with retry affordance

Must include:
- Listener for service-worker messages (`SEARCH_STARTED`, `SEARCH_COMPLETE`, `SEARCH_ERROR`)
- `CHAT_REQUEST` message bridge to background worker
- Chat history constrained by shared constants where applicable
- Clear distinction between cache hit and fresh search

**Important correction:**
Do not depend on any missing external plan file for App source. This phase doc is complete by itself.

## Task 5: Build and Integration Validation
Run:
1. `pnpm build:shared`
2. `pnpm --filter @shopping-assistant/extension typecheck`
3. `pnpm build:ext`

Manual checks in Chrome (`chrome://extensions` + load unpacked dist):
1. Amazon product page: overlay appears and click opens panel.
2. Search starts, loading phases update, results render.
3. Chat request returns backend response.
4. Re-click same product: cache hit path is visibly faster.
5. After a successful search, revisiting the same page shows a green dot on the overlay icon for the cached product.

## Critical Corrections Applied vs Earlier Draft
- Removed references to missing monolithic Task 11 source.
- Added explicit generic-detection fallback requirement to match design.
- Added manifest/permission requirements for backend network calls.
- Added structured-clone safety requirement for message payloads.
- Added green dot cached-result indicator on overlay icons (from UX spec Flow D).

## Next
Proceed to `docs/plans/2026-03-02-phase3-voice.md`.
