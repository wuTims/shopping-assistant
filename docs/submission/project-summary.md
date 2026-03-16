# Shopping Source Discovery Agent

A Chrome Extension that finds cheaper product alternatives across marketplaces, powered by Gemini and Brave Search. The backend runs on GCP Cloud Run with automated CI/CD.

---

## Features

### Product Detection
The extension scans any web page for product images using DOM heuristics (image elements, background images, structured data). When a product image >=60px is found, a small overlay icon appears. Clicking it triggers a search for cheaper alternatives. A MutationObserver handles lazy-loaded and dynamically inserted content.

### Multi-Source Search Pipeline
The backend runs a 5-phase pipeline within a 20-second budget:

1. **Identify** - Gemini 2.5 Flash analyzes the product image and extracts category, brand, attributes, and generates targeted search queries.
2. **Parallel Search** - Brave Web Search, Brave Image Search, and AliExpress API (text + visual) run concurrently with independent 8-second timeouts.
3. **Merge and Deduplicate** - Results are normalized, deduplicated by URL and title similarity (>85% threshold), and pre-sorted.
4. **Enrich** - Two parallel passes: (a) HTTP price extraction from JSON-LD/meta tags with stale link detection, and (b) visual similarity scoring via `gemini-embedding-2-preview` (256-dimensional cosine similarity).
5. **Rank** - Blended scoring (60% text heuristics, 40% visual similarity), confidence thresholds, and backfilling to ensure at least 10 results.

Each provider can fail independently without blocking the pipeline.

### Text Chat
Users ask follow-up questions about results in a chat interface. The backend sends product context and the top 10 results to Gemini 2.5 Flash, which answers with price comparisons, product advice, and marketplace-specific guidance.

### Voice Chat (Gemini Live API)
The side panel connects via WebSocket to the backend, which proxies to the Gemini Live API (`gemini-2.5-flash-native-audio-preview`). Audio streams bidirectionally: mic input at 16kHz PCM, response playback at 24kHz PCM via Web Audio API and AudioWorklet. Product context and search results are injected into the Gemini session as system instructions. Sessions last up to 15 minutes per Gemini's audio session limit.

MV3 service workers cannot hold persistent WebSocket connections, so the Cloud Run backend acts as a stateful proxy while keeping API credentials server-side.

### Bookmarking
Users save comparison results as bookmarks with marketplace, price, and product image. Bookmarks persist in `chrome.storage.local` and are accessible from the Settings page.

### Caching
Search results are cached in `chrome.storage.local` with a 1-hour TTL and 50-entry LRU eviction. Cache keys are SHA-256 hashes of product name, page URL, and image hash.

---

## Technologies

### Extension
| Technology | Version | Purpose |
|------------|---------|---------|
| Chrome MV3 | 120+ | Extension platform (service workers, side panels, content scripts) |
| React | 19.0.0 | Side panel UI |
| React Router | 7.13.1 | Client-side routing (MemoryRouter) |
| Vite | 6.0.0 | Build toolchain with HMR |
| CRXJS Vite Plugin | 2.0.0-beta.28 | MV3-aware bundling |
| Tailwind CSS | 3.4.19 | Utility-first styling |
| TypeScript | 5.7.0 | Strict mode throughout |
| Web Audio API | - | Voice recording and playback |
| AudioWorklet | - | Low-latency audio processing (640-sample buffer) |

### Backend
| Technology | Version | Purpose |
|------------|---------|---------|
| Node.js | 20 | Runtime |
| Hono | 4.0 | HTTP framework with WebSocket support |
| TypeScript | 5.7.0 | Strict mode |
| tsup | - | Build |
| Sharp | - | Image cropping for screenshot analysis |
| `@google/genai` | - | Gemini Flash, Embedding, and Live API client |
| `@google-cloud/secret-manager` | 6.1.1 | Runtime token persistence on GCP |

### Infrastructure
| Technology | Purpose |
|------------|---------|
| GCP Cloud Run | Container hosting (auto-scaling, WebSocket support) |
| GCP Artifact Registry | Docker image storage (SHA-tagged) |
| GCP Secret Manager | API key and OAuth token storage with runtime write-back |
| GCP Workload Identity Federation | Keyless GitHub Actions authentication via OIDC |
| GitHub Actions | CI/CD pipeline with canary deployment and auto-rollback |
| Docker | Multi-stage production build (node:20-slim) |
| pnpm | Monorepo workspace management |

### Monorepo Structure
A pnpm workspace with three packages sharing a single `tsconfig.base.json`:

- `packages/shared` - TypeScript types and constants consumed by both extension and backend. This is the contract between the two.
- `packages/extension` - Chrome Extension (Vite + CRXJS + React 19).
- `packages/backend` - Cloud Run API (Hono + Node.js).

---

## Data Sources

### Gemini API (Google AI)
| Model | Usage |
|-------|-------|
| `gemini-2.5-flash` | Product identification (image analysis with structured JSON output), search query generation, text chat responses, screenshot multi-product detection |
| `gemini-embedding-2-preview` | 256-dimensional image embeddings for visual similarity ranking (cosine similarity) |
| `gemini-2.5-flash-native-audio-preview` | Bidirectional voice via Gemini Live API, proxied through Cloud Run WebSocket |

All Gemini calls use the `@google/genai` SDK, authenticated via `GEMINI_API_KEY` stored in Secret Manager.

### Brave Search API
| Endpoint | Usage |
|----------|-------|
| Web Search (`/res/v1/web/search`) | Product discovery using AI-generated and marketplace-specific queries. Extracts structured pricing from product clusters and shopping domains. 10 results per query. |
| Image Search (`/res/v1/images/search`) | Visual similarity search filtered to shopping domains. 20 results per query. |

### AliExpress TOP API
| Method | Usage |
|--------|-------|
| `aliexpress.ds.text.search` | Keyword-based product search |
| `aliexpress.ds.product.search.image` | Visual product search from base64 image |

Authenticated via HMAC-SHA256 signed requests and OAuth 2.0 tokens. Tokens have 24-hour expiry and are auto-refreshed; refreshed tokens are written back to GCP Secret Manager to survive instance restarts.

---

## GCP Deployment

The backend deploys to Cloud Run in `us-central1` via a GitHub Actions pipeline that triggers on pushes to `main`. The pipeline:

1. Typechecks the backend against shared types
2. Builds a Docker image and pushes it to Artifact Registry
3. Deploys a canary revision with zero traffic
4. Verifies the canary via health check (5 retries)
5. Routes traffic to the new revision on success, rolls back on failure

Authentication from GitHub Actions to GCP uses Workload Identity Federation (OIDC token exchange). No long-lived service account keys are stored.

Cloud Run is configured with session affinity (for WebSocket reconnection), 1-hour request timeout (for voice sessions), and 1 warm instance for demo responsiveness.

See [gcp-deployment-proof.md](gcp-deployment-proof.md) for detailed evidence and file references.

---

## Findings and Learnings

### Gemini Grounding removed in favor of Brave Search
We initially used Gemini's built-in Google Search grounding tool alongside Brave Search for dual-source coverage. In testing, grounding calls timed out at a near-100% rate, making the feature unreliable within our 20-second pipeline budget. We removed it and rely on Brave Search and AliExpress API as search providers. Gemini is used for product understanding and ranking, not for search retrieval.

### Heuristic ranking outperformed AI-based ranking
Our first approach used Gemini Flash to rank results by visual and semantic similarity. This added 3-5 seconds of latency and produced inconsistent orderings. We replaced it with a deterministic blend: 60% text-based heuristic scoring (title overlap, brand match, price proximity, category relevance) and 40% visual similarity from `gemini-embedding-2-preview`. The result is faster, more predictable, and equally effective.

### Base64 image transfer is more reliable than URL-based fetching
Product image URLs on major marketplaces are often protected by CDN restrictions, CORS policies, or anti-hotlinking measures. Server-side fetches of image URLs failed frequently. We switched to capturing product images client-side via `canvas.drawImage()` and sending base64 data directly. This eliminated fetch failures at the cost of slightly larger request payloads.

### AliExpress token lifecycle requires persistent storage
AliExpress OAuth tokens expire every 24 hours. On Cloud Run, instances are ephemeral, so in-memory token storage is lost on scale-down or redeployment. We integrated the `@google-cloud/secret-manager` SDK to write refreshed tokens back to Secret Manager at runtime. The backend detects its environment (GCP vs. local) and uses the appropriate storage backend.

### MV3 service workers cannot hold WebSocket connections
Chrome MV3 service workers are event-driven and terminate after ~30 seconds of inactivity. This makes them unsuitable for persistent WebSocket connections to the Gemini Live API. We solved this by having the side panel (which stays alive while open) connect directly to the Cloud Run backend via WebSocket. The backend maintains the upstream Gemini Live session and relays audio and transcripts.

### Canary deployments catch real issues
During CI/CD development, our canary health check caught a broken revision before it received traffic. The auto-rollback step restored the previous working revision without manual intervention. This validated the investment in a canary-based deployment strategy over direct traffic routing.

### Event delegation scales better on third-party DOM
Our initial overlay system attached hover listeners to every detected product image. On pages with hundreds of images (e.g., marketplace listing pages), this caused measurable performance degradation. Switching to a single delegated event listener on `document.body` with hit-testing eliminated the overhead.
