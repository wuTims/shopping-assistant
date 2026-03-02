# MVP Implementation Design

**Date:** 2026-03-02
**Goal:** Implement the full Shopping Source Discovery Agent MVP — product detection, search pipeline, results UI, text chat, and voice via Gemini Live API.
**Approach:** Backend-first with curl-testable endpoints, then wire up the extension.

---

## Summary

The project scaffolding is complete (all three packages build, types defined, build tooling works). Zero core logic exists — every feature is a stub. This design covers implementing all 10 TODOs across the codebase to produce a working demo targeting Amazon and eBay.

**Decisions made:**
- Full MVP scope: detection + search + chat + voice
- Backend-first implementation order (curl-test before building UI)
- Multimodal Live API for voice (not STT+TTS workaround)
- Target Amazon + eBay for product detection
- Both Gemini and Brave API keys need provisioning

---

## Section 1: Foundation — API Clients

### Gemini Client (`packages/backend/src/services/gemini.ts`)

Install `@google/genai` SDK. Three functions:

1. **`identifyProduct(imageUrl, title)`** — Sends product image to Gemini Flash. Returns `ProductIdentification` with category, description, brand, attributes, and 2-3 search queries. Uses structured JSON output via response schema.

2. **`groundedSearch(queries)`** — Calls Gemini Flash with `google_search` tool enabled, targeting marketplace queries. Returns raw grounding chunks (URLs + titles + synthesized text). Prompt requests structured JSON for each product found.

3. **`rankResults(originalImageUrl, results)`** — Sends original product image + result images to Gemini Flash for visual comparison. Returns confidence scores (0-1) and comparison notes per result.

Environment variable: `GEMINI_API_KEY`

### Brave Client (`packages/backend/src/services/brave.ts`)

Plain `fetch` calls to Brave Web Search API. Sends 2-3 search queries derived from ProductIdentification. Parses web results — extracts product data from `extra_snippets` and structured fields (JSON-LD Product schema when available).

Environment variable: `BRAVE_API_KEY`

### Ranking Service (`packages/backend/src/services/ranking.ts`)

- URL-based deduplication (normalize URLs, strip tracking params)
- Title similarity dedup (simple string distance)
- Map Gemini ranking scores → `RankedResult` objects
- Calculate price deltas and savings percentages against original price
- Filter below confidence threshold, sort by confidence desc then savings desc

---

## Section 2: Search Pipeline

### POST /search (`packages/backend/src/routes/search.ts`)

Three-step pipeline:

1. **Identify:** `identifyProduct(imageUrl, title)` → `ProductIdentification`
2. **Parallel search:** `Promise.allSettled([groundedSearch(queries), braveSearch(queries)])` with 10s per-source timeout
3. **Normalize + rank:** Convert both formats → `SearchResult[]` → dedup → `rankResults()` → `RankedResult[]`

Returns `SearchResponse` with metadata (counts, durations, source statuses).

**Graceful degradation:** If one source times out, return results from the other. `sourceStatus` field tells the extension what happened.

### POST /chat (`packages/backend/src/routes/chat.ts`)

- System prompt with product context + search results injected
- `history` sent as conversation turns
- Returns `{ reply: string }`

---

## Section 3: Content Script — Product Detection

### Detection Heuristics (priority order)

1. **JSON-LD / schema.org:** Parse `<script type="application/ld+json">` for `@type: "Product"`
2. **Open Graph tags:** `og:title`, `og:image`, `og:price:amount`
3. **Amazon-specific selectors:** `#productTitle`, `.a-price .a-offscreen`, `#landingImage`
4. **eBay-specific selectors:** `.x-item-title`, `.x-price-primary`, `.ux-image-carousel img`
5. **Generic price pattern:** `<img>` near text matching `$XX.XX` / `€XX,XX`

### Overlay Injection

- 28x28px icon at top-right of detected product images
- Click → `chrome.runtime.sendMessage` with `DetectedProduct`
- Max 20 overlays per page
- MutationObserver for SPA navigation (re-detect on URL change)

---

## Section 4: Service Worker — Message Routing + Cache

- Receive messages from content script
- Open side panel on product click
- Cache check in `chrome.storage.local` (1-hour TTL, 50-entry LRU)
- On cache miss: POST to backend `/search`
- Forward results to side panel
- Cache cleanup on service worker activation

---

## Section 5: Side Panel UI

### Views

1. **Empty state:** "Click a product overlay to search"
2. **Loading state:** 4-phase progressive feedback
3. **Results view:** Original product, price context bar, product cards, "Chat Now"
4. **Chat view:** Message thread, text input, mic button, back arrow

### Implementation

- React useState/useReducer for state management
- `chrome.runtime.onMessage` for incoming results
- `chrome.runtime.sendMessage` for outgoing chat requests
- CSS per frontend-ux-spec (360px fixed width, system font stack, defined palette)

---

## Section 6: WebSocket Voice Proxy

### Backend (`packages/backend/src/ws/live.ts`)

- On client connect: receive `config` message with product context
- Open upstream WebSocket to Gemini Live API endpoint
- Forward audio frames bidirectionally (client ↔ Gemini)
- Handle session lifecycle: setup with system instructions + context, streaming, turn completion

### Extension Side Panel

- Web Audio API: capture mic at 16kHz PCM via AudioWorklet
- WebSocket to backend `/live`
- Playback response audio at 24kHz
- Barge-in: new audio input cancels current playback
- Transcript display in chat thread

---

## Implementation Order

1. API key setup (Gemini + Brave)
2. Gemini client (identify, grounded search, rank)
3. Brave client
4. Ranking service (dedup + scoring)
5. Search pipeline (wire the route)
6. Chat endpoint
7. Content script (detection + overlays)
8. Service worker (routing + cache)
9. Side panel UI (results + chat views)
10. WebSocket voice proxy (backend + extension)
