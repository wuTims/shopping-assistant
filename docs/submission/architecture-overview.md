# Shopping Source Discovery Agent - Architecture Overview

> Chrome Extension (MV3) that finds cheaper product alternatives across marketplaces, powered by Gemini and Brave Search. Deployed on GCP Cloud Run.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Package Structure](#package-structure)
4. [Extension Components](#extension-components)
5. [Backend Components](#backend-components)
6. [Search Pipeline](#search-pipeline)
7. [Voice Agent - Gemini Live API](#voice-agent--gemini-live-api)
8. [External Integrations](#external-integrations)
9. [GCP Deployment](#gcp-deployment)
10. [Data Flows](#data-flows)
11. [Configuration Reference](#configuration-reference)

---

## System Overview

| Layer | Technology | Responsibility |
|-------|-----------|----------------|
| **Chrome Extension** | MV3 + React 19 + Vite | Product detection, UI, caching, audio capture |
| **Cloud Run Backend** | Hono + Node.js + TypeScript | Search orchestration, AI calls, voice proxy |
| **External APIs** | Gemini, Brave, AliExpress | Product identification, search, ranking, voice |

**Design principles:** stateless backend (no database), credentials server-side only, on-demand search (never prefetch), progressive UI feedback with phase-based loading.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CHROME EXTENSION (MV3)                          │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│  │Content Script │   │Service Worker│   │     Side Panel          │  │
│  │              │   │              │   │  (React 19 + Tailwind)  │  │
│  │ DOM scanning  │──▶│ Msg routing  │──▶│  Results display       │  │
│  │ Overlay icons │   │ Cache (LRU) │   │  Price comparison      │  │
│  │ Image capture │   │ API calls   │   │  Chat (text + voice)   │  │
│  └──────────────┘   └──────┬───────┘   └──────────┬─────────────┘  │
│                            │  chrome.storage.local │               │
│                            │  ┌──────────────┐     │               │
│                            └──│ Cached Search │     │               │
│                               │ TTL: 1hr     │     │               │
│                               │ Max: 50 LRU  │     │               │
│                               └──────────────┘     │               │
└────────────────────────────────┬────────────────────┤───────────────┘
                                 │ HTTPS              │ WSS
                                 ▼                    ▼
┌────────────────────────────────────────────────────────────────────┐
│               GCP CLOUD RUN (Hono + Node.js)                       │
│                                                                    │
│  ┌──────────────────────────────┐  ┌─────────────────────────┐    │
│  │        REST API              │  │   WebSocket /live        │    │
│  │  POST /search  (pipeline)    │  │   Gemini Live API proxy  │    │
│  │  POST /chat    (text chat)   │  │   Bidirectional audio    │    │
│  │  POST /identify (screenshot) │  │   Session management     │    │
│  └──────────┬───────────────────┘  └────────────┬────────────┘    │
│             ▼                                    ▼                 │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │  gemini.ts    brave.ts    aliexpress.ts    embedding.ts   │     │
│  │  ranking.ts   price-extractor.ts   secret-store.ts        │     │
│  └──────────────────────────────────────────────────────────┘     │
└──────────┬──────────────────┬──────────────────┬──────────────────┘
           ▼                  ▼                  ▼
    ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
    │ Gemini API  │  │  Brave API   │  │ AliExpress API   │
    │ 2.5 Flash   │  │ Web Search   │  │ Text Search      │
    │ Embedding   │  │ Image Search │  │ Image Search     │
    │ Live API    │  │              │  │ OAuth 2.0        │
    └─────────────┘  └──────────────┘  └──────────────────┘
```

---

## Package Structure

```
shopping-assistant/                 pnpm monorepo
├── packages/
│   ├── shared/                     ESM types + constants (the contract)
│   │   └── src/
│   │       ├── types.ts            SearchRequest, SearchResponse, WsMessages, etc.
│   │       └── constants.ts        Timeouts, thresholds, visual config
│   ├── extension/                  Chrome Extension (Vite + CRXJS + React 19)
│   │   └── src/
│   │       ├── content/            DOM detection + overlay injection
│   │       ├── background/         Service worker: cache, routing, backend calls
│   │       ├── sidepanel/          React app: results, chat, voice UI
│   │       └── manifest.json
│   └── backend/                    Cloud Run API (Hono + Node.js)
│       └── src/
│           ├── index.ts            Server entry (CORS, rate limiting, WebSocket upgrade)
│           ├── routes/             HTTP handlers (search, chat, identify, auth)
│           ├── services/           Business logic (gemini, brave, aliexpress, ranking, etc.)
│           ├── ws/                 WebSocket handlers (live.ts)
│           └── middleware/         Rate limiting
└── docs/                           Specifications and architecture docs
```

All packages use TypeScript strict mode, ESM only. Shared types are the single source of truth for data flowing between extension and backend.

---

## Extension Components

### Content Script (`content/`)

Detects products via DOM heuristics. Scans `<img>` tags and CSS `background-image` elements for images >=60px. Injects interactive overlay icons using event delegation on `document.body` (single listener, not per-element). Uses `MutationObserver` for lazy-loaded content.

On click: `canvas.drawImage()` captures the product image as PNG base64, extracts title from alt text/structured data/DOM hierarchy, extracts price from data attributes/price classes/JSON-LD. Sends `IMAGE_CLICKED` message to service worker.

### Service Worker (`background/`)

Central message hub. Handles:
- `IMAGE_CLICKED`: search trigger (cache check then backend call)
- `chrome.action.onClicked`: screenshot capture, POST `/identify` for multi-product detection, then search or product selection
- `select_product`: user picks a product from multi-product results
- `CHAT_REQUEST`: forwards to POST `/chat`
- `GET_STATE`: side panel state recovery on reopen

**Cache:** SHA-256 hash of `productName + pageUrl + imageHash` stored in `chrome.storage.local`. 1-hour TTL, 50-entry LRU eviction.

### Side Panel (`sidepanel/`)

React 19 app with three routes (MemoryRouter):
- **Home**: product section, price bar (gradient LOW/FAIR/HIGH visualization), ranked result cards, chat input
- **Chat**: text and voice conversation with Gemini about products and results
- **Settings**: theme selector (multiple gradient backgrounds), saved bookmarks

State machine: `empty → identifying → product_selection → loading → results | error`

Loading phases provide progressive feedback: "Identifying product..." → "Searching across marketplaces..." → "Comparing results..."

---

## Backend Components

### Routes

| Endpoint | Method | Purpose | Timeout |
|----------|--------|---------|---------|
| `/search` | POST | Full search pipeline | 20s |
| `/chat` | POST | Text chat with product context | 10s |
| `/identify` | POST | Multi-product detection from screenshot | 30s |
| `/live` | GET→WSS | Gemini Live API voice proxy | 15 min session |
| `/auth/aliexpress/*` | Various | AliExpress OAuth flow | - |
| `/health` | GET | Health check | - |

Rate limiting: 60 requests/minute per IP on `/search/*`, `/identify/*`, `/chat/*`.

### Services

| Service | Responsibility |
|---------|---------------|
| `ai-client.ts` | Shared `GoogleGenAI` instance, model constants |
| `gemini.ts` | `identifyProduct()` (image → structured product analysis), `identifyFromScreenshot()` (page → product list with bounding boxes), `fetchImage()` (SSRF-safe with private IP blocking) |
| `brave.ts` | `searchProducts()` (web + product clusters), `searchImages()` (reverse image, filtered to shopping domains) |
| `aliexpress.ts` | `textSearch()` / `imageSearch()` (HMAC-SHA256 signed TOP API), OAuth token management with auto-refresh |
| `embedding.ts` | `computeVisualSimilarityScores()` using `gemini-embedding-2-preview` (256-dim), cosine similarity |
| `ranking.ts` | mergeAndDedup → heuristicPreSort → diversityCap → buildFallbackScores → blendScores → applyRanking |
| `price-extractor.ts` | HTTP GET with structured data extraction (JSON-LD, Open Graph, Microdata), stale link detection |
| `secret-store.ts` | GCP Secret Manager write-back for refreshed AliExpress tokens; falls back to `.env` locally |

---

## Search Pipeline

The `/search` endpoint runs a 5-phase pipeline within a 20-second timeout:

```
                    SearchRequest (image + metadata)
                              │
                              ▼
     ┌────────────────────────────────────────────┐
     │  PHASE 1: Identify + Title Search (parallel)│
     │                                              │
     │  ┌──────────────────┐  ┌─────────────────┐  │
     │  │ Gemini 2.5 Flash │  │ Brave Web Search │  │
     │  │ identifyProduct()│  │ (title queries)  │  │
     │  │ → category,      │  │ → early results  │  │
     │  │   searchQueries, │  │                  │  │
     │  │   attributes     │  │                  │  │
     │  └──────────────────┘  └─────────────────┘  │
     └────────────────────────┬───────────────────┘
                              ▼
     ┌────────────────────────────────────────────┐
     │  PHASE 2: Parallel Multi-Source Search      │
     │                                              │
     │  ┌──────────┐ ┌──────────┐ ┌──────────────┐│
     │  │ Brave    │ │Brave     │ │  AliExpress  ││
     │  │ Web      │ │Image     │ │  Text+Image  ││
     │  │ (AI +    │ │Search    │ │  (TOP API)   ││
     │  │ site:)   │ │          │ │              ││
     │  └──────────┘ └──────────┘ └──────────────┘│
     └────────────────────────┬───────────────────┘
                              ▼
     ┌────────────────────────────────────────────┐
     │  PHASE 3: Merge + Dedup + Pre-sort + Cap    │
     │  URL dedup, title similarity (>85%),        │
     │  heuristic pre-sort, diversity cap → 15     │
     └────────────────────────┬───────────────────┘
                    ┌─────────┴─────────┐
                    ▼                   ▼
     ┌─────────────────────┐ ┌─────────────────────┐
     │ 3.5: Price Extract  │ │ 3.5: Visual Embed    │
     │ HTTP → JSON-LD/meta │ │ Original + 8 cands   │
     │ Stale link detect   │ │ 256-dim cosine sim   │
     │ 2s per URL          │ │ 6s budget            │
     └──────────┬──────────┘ └──────────┬──────────┘
                └─────────┬─────────────┘
                          ▼
     ┌────────────────────────────────────────────┐
     │  PHASE 4: Ranking                           │
     │  Text heuristic: title overlap, brand,      │
     │    price proximity, category, richness      │
     │  Blend: 60% text + 40% visual               │
     │  Filter ≥ 0.25, backfill to 10, sort        │
     │  Source marketplace penalty: 0.15            │
     └────────────────────────┬───────────────────┘
                              ▼
                       SearchResponse
```

**Graceful degradation:** Any provider timeout or failure does not block the pipeline. Each parallel search has an independent 8-second timeout. If visual embedding times out, ranking falls back to text-only scores.

---

## Voice Agent - Gemini Live API

### Why a WebSocket Proxy?

MV3 service workers are event-driven and terminate after ~30 seconds of inactivity. They cannot hold persistent WebSocket connections. The side panel (which stays alive while open) connects via WSS to Cloud Run, which maintains the upstream Gemini Live API session. API credentials stay server-side.

### Connection Architecture

```
┌──────────────────────┐        ┌──────────────────────────┐        ┌─────────────────┐
│   SIDE PANEL         │  WSS   │     CLOUD RUN            │  WSS   │  GEMINI LIVE    │
│   (Browser)          │◀──────▶│     /live endpoint        │◀──────▶│  API            │
│                      │        │                          │        │                 │
│ AudioWorklet ────────┼───────▶│ Session Manager ─────────┼───────▶│ Audio-in        │
│ (PCM16 @ 16kHz)      │ audio  │  • Create session        │ audio  │ (PCM16, 16kHz)  │
│                      │        │  • Inject product context │        │                 │
│ Web Audio API ◀──────┼────────│  • Forward audio         │◀───────│ Audio-out       │
│ (PCM16 @ 24kHz)      │ audio  │  • Relay transcripts     │        │ (PCM16, 24kHz)  │
│                      │        │  • Handle barge-in       │        │                 │
│ Transcript UI ◀──────┼────────│                          │◀───────│ Transcript      │
│ (chat bubbles)       │  text  │ Context Injector         │        │ Turn events     │
│                      │        │  Product + results →     │        │                 │
│ Barge-in control     │        │  system instruction      │        │                 │
└──────────────────────┘        └──────────────────────────┘        └─────────────────┘
```

### Message Protocol (`packages/shared/src/types.ts`)

**Client → Server (`WsClientMessage`):**

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `config` | `context: Record<string, unknown>` | Session init with product + results |
| `audio` | `encoding: "pcm_s16le"`, `sampleRateHz: 16000`, `data` (base64) | Mic audio chunks |
| `text` | `content: string` | Text-mode fallback |
| `audioStreamEnd` | - | Signals end of user speech |

**Server → Client (`WsServerMessage`):**

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `ready` | - | Session established |
| `audio` | `encoding: "pcm_s16le"`, `sampleRateHz: 24000`, `data` (base64) | Voice response |
| `input_transcript` | `content: string` | What the user said |
| `output_transcript` | `content: string` | What Gemini said |
| `turn_complete` | - | End of assistant turn |
| `interrupted` | - | Barge-in detected |
| `go_away` | `reason: string` | Session ending (timeout warning) |
| `error` | `message: string` | Error details |

### Session Lifecycle

1. User completes a product search, taps the mic button
2. Side panel opens WSS to Cloud Run `/live`
3. Sends `config` with product context and ranked results
4. Cloud Run creates upstream Gemini Live session (`gemini-2.5-flash-native-audio-preview`) with system instruction and shopping context
5. User speaks → PCM16 @ 16kHz captured via AudioWorklet (640-sample/40ms chunks) → Cloud Run → Gemini Live API
6. Gemini responds with audio (24kHz) + transcript + `turn_complete`, relayed back to side panel
7. Side panel plays audio via Web Audio API, shows transcript; barge-in stops playback and starts new turn
8. Session persists until side panel closes or 15-minute Gemini limit; client warned 30 seconds before expiry

---

## External Integrations

### Gemini API (Google AI)

| Model | Method | Usage |
|-------|--------|-------|
| `gemini-2.5-flash` | `generateContent` | Product identification, search query generation, chat, screenshot analysis |
| `gemini-embedding-2-preview` | `embedContent` | 256-dimensional image embeddings for visual similarity ranking |
| `gemini-2.5-flash-native-audio-preview` | Live API (WebSocket) | Bidirectional voice, proxied through Cloud Run `/live` |

**Client:** `@google/genai` (`GoogleGenAI`), authenticated via `GEMINI_API_KEY` env var.

### Brave Search API

| Endpoint | Usage |
|----------|-------|
| `/res/v1/web/search` | Product discovery, structured pricing from product clusters + shopping domains. 10 results/query. |
| `/res/v1/images/search` | Visual similarity search filtered to shopping domains. 20 results/query. |

Auth: `X-Subscription-Token` header with `BRAVE_API_KEY`.

### AliExpress TOP API

| Method | Usage |
|--------|-------|
| `aliexpress.ds.text.search` | Text-based product search |
| `aliexpress.ds.product.search.image` | Visual product search from base64 image |

Auth: HMAC-SHA256 signed requests + OAuth 2.0 token (24h expiry, auto-refresh with Secret Manager write-back).

---

## GCP Deployment

```
┌──────────────────────────────────────────────────────────────┐
│                    GOOGLE CLOUD PLATFORM                      │
│                                                               │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────────┐ │
│  │ Cloud Run    │  │ Artifact Registry │  │ Secret Manager │ │
│  │              │  │                  │  │                │ │
│  │ Backend      │  │ Docker images    │  │ API keys       │ │
│  │ container    │◀─│ (SHA-tagged)     │  │ OAuth tokens   │ │
│  │              │  │                  │  │ (read + write) │ │
│  │ Endpoints:   │  └──────────────────┘  └───────┬────────┘ │
│  │  /search     │                                │          │
│  │  /chat       │◀───────────────────────────────┘          │
│  │  /identify   │    secrets injected as env vars           │
│  │  /live (WSS) │                                           │
│  │  /health     │  ┌──────────────────────────────────────┐ │
│  └──────────────┘  │ Workload Identity Federation         │ │
│                    │ OIDC token exchange for GitHub Actions│ │
│                    │ No long-lived service account keys    │ │
│                    └──────────────────────────────────────┘ │
│                                                               │
│  CI/CD: GitHub Actions → typecheck → build → push → deploy   │
│         Canary tag → health check → route traffic / rollback  │
└──────────────────────────────────────────────────────────────┘
         ▲ HTTPS              ▲ WSS
┌────────┴────────────────────┴──────┐
│  CHROME EXTENSION (User's Browser) │
│  Service Worker → REST calls       │
│  Side Panel    → WSS voice         │
└────────────────────────────────────┘
```

| Concern | Approach |
|---------|----------|
| **WebSockets** | Cloud Run natively supports WSS. 1-hour hard timeout per connection. Session affinity routes reconnecting clients to the same instance. |
| **Cold starts** | ~200ms (Node.js + Hono). `min-instances: 1` keeps a warm instance for demos. |
| **Secrets** | Secret Manager with runtime read. AliExpress tokens use write-back (`secretVersionAdder` role) for auto-refresh persistence. |
| **Scaling** | Auto 1-5 instances, 20 concurrent requests per instance. |
| **Security** | Workload Identity Federation for CI/CD. Rate limiting (60 req/min per IP). SSRF protection on image fetches. |

---

## Data Flows

### Flow 1: Product Detection → Search → Results

```
Content script (DOM heuristics) ──▶ overlay click ──▶ canvas → base64
        │
        ▼  IMAGE_CLICKED
Service worker ──▶ SHA-256 cache check
        │
        ├── HIT → cached results → side panel
        └── MISS → POST /search → pipeline → cache + side panel
```

### Flow 2: Text Chat

```
Side panel input → CHAT_REQUEST → service worker → POST /chat
→ Gemini 2.5 Flash (system instruction + product context + top 10 results)
→ ChatResponse → side panel ChatThread
```

### Flow 3: Voice Chat

```
Side panel mic → AudioWorklet (16kHz PCM) → WSS /live → Cloud Run
→ Gemini Live API (2.5 Flash Native Audio)
→ Audio (24kHz PCM) + transcript + turn events relayed back
→ Web Audio API playback + transcript display
```

---

## Configuration Reference

### Timeouts

| Constant | Value | Scope |
|----------|-------|-------|
| `SEARCH_TIMEOUT_MS` | 20s | Entire search pipeline |
| `IDENTIFY_TIMEOUT_MS` | 30s | Screenshot multi-product detection |
| `CHAT_TIMEOUT_MS` | 10s | Single chat message |
| `EMBEDDING_TIMEOUT_MS` | 6s | Visual similarity scoring |
| `PRICE_HTTP_TIMEOUT_MS` | 2s | HTTP structured data fetch |
| Per-query (Brave/AliExpress) | 8s | Individual search query |
| `VOICE_SESSION_MAX_MS` | 15 min | Gemini Live API session limit |

### Search & Ranking

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_RESULTS_FOR_RANKING` | 15 | Cap before ranking |
| `MIN_DISPLAY_RESULTS` | 10 | Backfill target |
| `MIN_CONFIDENCE_SCORE` | 0.25 | Filter threshold |
| `CONFIDENCE_THRESHOLDS` | high: 0.7, medium: 0.4 | Display labels |
| `TEXT_SCORE_WEIGHT` / `VISUAL_SCORE_WEIGHT` | 0.6 / 0.4 | Score blend ratio |
| `MAX_IMAGES_FOR_EMBEDDING` | 8 | Max candidates for visual scoring |
| `SOURCE_MARKETPLACE_PENALTY` | 0.15 | Penalty for results from the same marketplace |
| `MAX_SOURCE_MARKETPLACE_RESULTS` | 2 | Cap on same-marketplace results |
| `MAX_PRICE_FALLBACK_RESULTS` | 5 | Max priceless results to enrich |

### Extension

| Constant | Value | Purpose |
|----------|-------|---------|
| `CACHE_TTL_MS` | 1 hr | Search result TTL |
| `CACHE_MAX_ENTRIES` | 50 | LRU eviction threshold |
| `MAX_CHAT_HISTORY` | 20 | Messages sent to /chat |
| `MIN_IMAGE_SIZE_PX` | 60 | Minimum image for overlay |
| `SIDE_PANEL_WIDTH_PX` | 360 | Side panel width |
| `VOICE_INPUT_SAMPLE_RATE` | 16 kHz | Mic capture sample rate |
| `VOICE_OUTPUT_SAMPLE_RATE` | 24 kHz | Playback sample rate |
| `VOICE_WORKLET_BUFFER_SIZE` | 640 | 40ms chunks at 16kHz |
