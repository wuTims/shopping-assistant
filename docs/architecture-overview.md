# Shopping Source Discovery Agent — Architecture Overview

> Chrome Extension (MV3) that finds cheaper product alternatives across marketplaces, powered by Gemini and Brave Search. Deployed on GCP Cloud Run.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Package Structure](#package-structure)
4. [Extension Components](#extension-components)
5. [Backend Components](#backend-components)
6. [Search Pipeline](#search-pipeline)
7. [Voice Agent — Gemini Live API](#voice-agent--gemini-live-api)
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
│  │  POST /chat    (text chat)   │  │   Audio streaming        │    │
│  │  POST /identify (screenshot) │  │   Session management     │    │
│  └──────────┬───────────────────┘  └────────────┬────────────┘    │
│             ▼                                    ▼                 │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │  gemini.ts    brave.ts    aliexpress.ts    embedding.ts   │     │
│  │  ranking.ts   price-fallback.ts   price-extractor.ts      │     │
│  └──────────────────────────────────────────────────────────┘     │
└──────────┬──────────────────┬──────────────────┬──────────────────┘
           ▼                  ▼                  ▼
    ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
    │ Gemini API  │  │  Brave API   │  │ AliExpress API   │
    │ 2.5 Flash   │  │ Web Search   │  │ OP API (text)    │
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
│           ├── index.ts            Server entry (CORS, logger, WebSocket upgrade)
│           ├── routes/             HTTP handlers (search, chat, identify, auth)
│           ├── services/           Business logic (gemini, brave, ranking, etc.)
│           ├── ws/                 WebSocket handlers (live.ts)
│           └── utils/              Marketplace detection, query builders
└── docs/                           Specifications and architecture docs
```

All packages use TypeScript strict mode, ESM only. Shared types are the single source of truth for data flowing between extension and backend.

---

## Extension Components

### Content Script (`content/`)

Detects products via DOM heuristics, injects interactive overlays on images >=60px. Uses `MutationObserver` for lazy-loaded content. On click: `canvas.drawImage()` → PNG base64 + titleHint extraction → `IMAGE_CLICKED` message to service worker.

### Service Worker (`background/`)

Central message hub. Handles: `IMAGE_CLICKED` (search trigger), `chrome.action.onClicked` (screenshot → `/identify` → search or product selection), `select_product`, `CHAT_REQUEST` (forward to `/chat`), `GET_STATE` (side panel state recovery).

**Cache:** SHA-256 hash of `productName + pageUrl + imageHash` → `chrome.storage.local`, 1-hour TTL, 50-entry LRU.

### Side Panel (`sidepanel/`)

React 19 state machine: `empty → identifying → product_selection → loading → results | error`

Loading phases: (0s) "Identifying product..." → (2s) "Searching across marketplaces..." → (5s) "Comparing results..."

Results view: ProductSection + PriceBar (gradient visualization) + ResultCard list + ChatInputBar. Chat mode splits the view ~40% results / ~60% ChatThread.

---

## Backend Components

### Routes

| Endpoint | Method | Purpose | Timeout |
|----------|--------|---------|---------|
| `/search` | POST | Full search pipeline | 20s |
| `/chat` | POST | Text chat with product context | 10s |
| `/identify` | POST | Multi-product detection from screenshot | 30s |
| `/live` | GET→WSS | Gemini Live API voice proxy | persistent |
| `/auth/aliexpress/*` | Various | AliExpress OAuth flow | — |
| `/health` | GET | Health check | — |

### Services

| Service | Responsibility |
|---------|---------------|
| `ai-client.ts` | Shared `GoogleGenAI` instance, model constants |
| `gemini.ts` | `identifyProduct()` (vision → product analysis), `identifyFromScreenshot()` (page → product list), `fetchImage()` (SSRF-safe) |
| `brave.ts` | `searchProducts()` (web + product clusters), `searchImages()` (reverse image, shopping domains) |
| `aliexpress.ts` | `textSearch()` / `imageSearch()` (HMAC-SHA256 signed TOP API), OAuth token management |
| `embedding.ts` | `computeVisualSimilarityScores()` — `gemini-embedding-2-preview` (256-dim), cosine similarity |
| `ranking.ts` | mergeAndDedup → heuristicPreSort → diversityCap → buildFallbackScores → blendScores → applyRanking |
| `price-fallback.ts` | Two-tier: HTTP + structured data (JSON-LD, meta, regex), then Playwright + Gemini Vision |

---

## Search Pipeline

The `/search` endpoint runs a 4-phase pipeline (20s overall timeout):

```
                    SearchRequest (image + metadata)
                              │
                              ▼
     ┌────────────────────────────────────────────┐
     │  PHASE 1: Identify + Title Search (parallel)│  ~3s
     │                                              │
     │  ┌──────────────────┐  ┌─────────────────┐  │
     │  │ Gemini Flash     │  │ Brave Web Search │  │
     │  │ identifyProduct()│  │ (title queries)  │  │
     │  │ → category,      │  │ → early results  │  │
     │  │   searchQueries, │  │                  │  │
     │  │   attributes     │  │                  │  │
     │  └──────────────────┘  └─────────────────┘  │
     └────────────────────────┬───────────────────┘
                              ▼
     ┌────────────────────────────────────────────┐
     │  PHASE 2: Parallel Multi-Source Search      │  ~8s
     │                                              │
     │  ┌──────────┐ ┌──────────┐ ┌──────────────┐│
     │  │ AI Brave │ │Marketplace│ │  AliExpress  ││
     │  │ (Gemini  │ │  Brave   │ │  Native API  ││
     │  │ queries) │ │ (site:)  │ │ (text+image) ││
     │  └──────────┘ └──────────┘ └──────────────┘│
     │  ┌──────────────────────┐                   │
     │  │ Brave Image Search   │                   │
     │  └──────────────────────┘                   │
     └────────────────────────┬───────────────────┘
                              ▼
     ┌────────────────────────────────────────────┐
     │  PHASE 3: Merge + Dedup + Pre-sort + Cap    │  ~1s
     │  URL normalization, Jaccard dedup (>85%),   │
     │  heuristic pre-sort, diversity cap → 15     │
     └────────────────────────┬───────────────────┘
                    ┌─────────┴─────────┐
                    ▼                   ▼
     ┌─────────────────────┐ ┌─────────────────────┐
     │ 3.5: Price Fallback │ │ 3.75: Visual Embed   │
     │ Top 5 priceless     │ │ Original + 8 cands   │
     │ HTTP→JSON-LD→regex  │ │ 256-dim cosine sim   │
     │ or Playwright+Vision│ │ ~6s budget           │
     └──────────┬──────────┘ └──────────┬──────────┘
                └─────────┬─────────────┘
                          ▼
     ┌────────────────────────────────────────────┐
     │  PHASE 4: Ranking                           │  ~1s
     │  Text: 12% base + 55% overlap + 25% brand  │
     │        + 10% category + 4% richness         │
     │  Blend: 60% text + 40% visual               │
     │  Filter ≥ 0.25, backfill to 10, sort        │
     └────────────────────────┬───────────────────┘
                              ▼
                       SearchResponse
```

**Graceful degradation:** Any provider timeout/failure doesn't block the pipeline. Each parallel search has an independent 8s timeout.

---

## Voice Agent — Gemini Live API

### Why a WebSocket Proxy?

MV3 service workers **cannot hold persistent connections** (event-driven, ~30s idle timeout). The side panel connects via WSS to Cloud Run, which maintains the upstream Gemini Live API session. API credentials stay server-side.

### Connection Architecture

```
┌──────────────────────┐        ┌──────────────────────────┐        ┌─────────────────┐
│   SIDE PANEL         │  WSS   │     CLOUD RUN            │  WSS   │  GEMINI LIVE    │
│   (Browser)          │◀──────▶│     /live endpoint        │◀──────▶│  API            │
│                      │        │                          │        │                 │
│ MediaRecorder ───────┼───────▶│ Session Manager ─────────┼───────▶│ Audio-in        │
│ (PCM16 @ 16kHz)      │ audio  │  • Create session        │ audio  │ (PCM16, 16kHz)  │
│                      │        │  • Inject product context │        │                 │
│ AudioContext ◀───────┼────────│  • Forward audio         │◀───────│ Audio-out       │
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

**Server → Client (`WsServerMessage`):**

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `audio` | `encoding: "pcm_s16le"`, `sampleRateHz: 24000`, `data` (base64) | Voice response |
| `transcript` | `content: string` | Text transcript |
| `turn_complete` | — | End of assistant turn |

### Session Lifecycle

1. User completes product search, taps mic
2. Side panel opens WSS to Cloud Run `/live`
3. Sends `config` with product context + ranked results
4. Cloud Run creates upstream **Gemini 2.0 Flash** (multimodal live) session with system instruction + context
5. User speaks → PCM16 @ 16kHz → Cloud Run → Gemini Live API
6. Gemini responds: audio (24kHz) + transcript + `turn_complete` relayed back
7. Side panel plays audio, shows transcript; barge-in stops playback and starts new turn
8. Connection persists until side panel closes; Cloud Run tears down upstream session

### Implementation Status

| Component | Status |
|-----------|--------|
| WebSocket message types | Defined in `shared/types.ts` |
| Backend `/live` endpoint | Stub (echoes placeholder) |
| Upstream Gemini Live session | TODO |
| Side panel mic capture | Placeholder ("coming soon" toast) |
| Audio playback / barge-in | TODO |

---

## External Integrations

### Gemini API (Google AI)

| Model | Method | Usage |
|-------|--------|-------|
| `gemini-2.5-flash` | `generateContent` | Product identification, chat, screenshot analysis, price vision |
| `gemini-embedding-2-preview` | `embedContent` | Image embeddings (256-dim) for visual similarity ranking |
| `gemini-2.0-flash` (multimodal live) | WebSocket streaming | Real-time bidirectional voice, proxied through Cloud Run `/live` |

**Client:** `@google/genai` (`GoogleGenAI`), authenticated via `GEMINI_API_KEY` env var.

### Brave Search API

| Endpoint | Usage |
|----------|-------|
| `/res/v1/web/search` | Product discovery, structured pricing from product clusters + shopping domains |
| `/res/v1/images/search` | Reverse image search filtered to shopping domains (20 results/query) |

Auth: `X-Subscription-Token` header with `BRAVE_API_KEY`.

### AliExpress TOP API

| Method | Usage |
|--------|-------|
| `aliexpress.ds.text.search` | Text-based product search |
| `aliexpress.ds.image.search` | Image-based product search (multipart) |

Auth: HMAC-SHA256 signed requests + OAuth 2.0 token (24h expiry, auto-refresh).

---

## GCP Deployment

```
┌──────────────────────────────────────────────────────────────┐
│                    GOOGLE CLOUD PLATFORM                      │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  CLOUD RUN                                              │  │
│  │  Container: Node.js (Hono)   Scaling: 0→N (auto)       │  │
│  │  Port: 8080                  Concurrency: multi-request │  │
│  │                                                         │  │
│  │  Env: GEMINI_API_KEY, BRAVE_API_KEY,                    │  │
│  │       ALIEXPRESS_APP_KEY, ALIEXPRESS_SECRET             │  │
│  │                                                         │  │
│  │  ┌─────────────┐  ┌────────────┐  ┌──────────────┐     │  │
│  │  │ REST /search│  │ WSS /live  │  │ GET /health  │     │  │
│  │  │ /chat       │  │ persistent │  │              │     │  │
│  │  │ /identify   │  │ connection │  │              │     │  │
│  │  └──────┬──────┘  └─────┬──────┘  └──────────────┘     │  │
│  └─────────┼───────────────┼──────────────────────────────┘  │
│            ▼               ▼                                  │
│  ┌──────────────────────────────────────┐                    │
│  │  Gemini 2.5 Flash (generateContent)  │                    │
│  │  Gemini Embedding 2 (embedContent)   │                    │
│  │  Gemini Live API (WS streaming)      │                    │
│  └──────────────────────────────────────┘                    │
│                                                               │
│  Cloud Build (CI/CD)  ·  Secret Manager  ·  Cloud Logging    │
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
| **WebSockets** | Cloud Run natively supports WSS. Instance stays alive while connected (up to 60 min). |
| **Cold starts** | ~200ms (Node.js + Hono). Set `min-instances: 1` for voice to avoid latency. |
| **Secrets** | Env vars or Secret Manager. Never exposed to extension. |
| **Scaling** | Auto 0→N for REST. For voice, `min-instances: 1` recommended. |

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
→ Gemini Flash (system instruction + product context + top 10 results)
→ ChatResponse → side panel ChatThread
```

### Flow 3: Voice Chat

```
Side panel mic → WSS /live → Cloud Run → Gemini Live API
                                  ↕
Audio + transcript + turn_complete relayed back to side panel
```

---

## Configuration Reference

### Timeouts

| Constant | Value | Scope |
|----------|-------|-------|
| `SEARCH_TIMEOUT_MS` | 20s | Entire search pipeline |
| `IDENTIFY_TIMEOUT_MS` | 30s | Screenshot multi-product detection |
| `CHAT_TIMEOUT_MS` | 10s | Single chat message |
| `PRICE_FALLBACK_TIMEOUT_MS` | 5s | Price extraction budget |
| `EMBEDDING_TIMEOUT_MS` | 6s | Visual similarity scoring |
| Per-query (Brave/AliExpress) | 8s | Individual search query |
| `PRICE_HTTP_TIMEOUT_MS` | 2s | HTTP structured data fetch |
| `PRICE_NAV_TIMEOUT_MS` | 2s | Playwright navigation |

### Search & Ranking

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_RESULTS_FOR_RANKING` | 15 | Cap before ranking |
| `MIN_DISPLAY_RESULTS` | 10 | Backfill target |
| `MIN_CONFIDENCE_SCORE` | 0.25 | Filter threshold |
| `CONFIDENCE_THRESHOLDS` | high: 0.7, medium: 0.4 | Display labels |
| `TEXT_SCORE_WEIGHT` / `VISUAL_SCORE_WEIGHT` | 0.6 / 0.4 | Score blend ratio |
| `MAX_IMAGES_FOR_EMBEDDING` | 8 | Max candidates for visual scoring |
| `MAX_PRICE_FALLBACK_RESULTS` | 5 | Max priceless results to fill |

### Extension

| Constant | Value | Purpose |
|----------|-------|---------|
| `CACHE_TTL_MS` | 1 hr | Search result TTL |
| `CACHE_MAX_ENTRIES` | 50 | LRU eviction threshold |
| `MAX_CHAT_HISTORY` | 20 | Messages sent to /chat |
| `MIN_IMAGE_SIZE_PX` | 60 | Minimum image for overlay |
| `SIDE_PANEL_WIDTH_PX` | 360 | Side panel width |
