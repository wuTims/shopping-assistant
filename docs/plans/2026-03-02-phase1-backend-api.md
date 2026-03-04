# Phase 1: Backend API Implementation

**Date:** 2026-03-02
**Depends on:** Project scaffolding complete
**Aligned with:** `docs/plans/2026-03-02-mvp-implementation.md`, `docs/plans/2026-03-02-mvp-implementation-design.md`

## Goal
Implement and validate backend MVP behavior for:
- Product identification
- Grounded search + Brave search
- Result normalization, dedup, ranking
- `/search` and `/chat` endpoints

Phase complete when `POST /search` and `POST /chat` return real, non-stub data against live providers.

## Required Stack and Contracts
- Runtime: Node 20+
- Server: Hono + `@hono/node-server` + `@hono/node-ws`
- LLM SDK: `@google/genai` (not legacy SDK)
- Search provider: Brave Web Search API
- Types/constants: `@shopping-assistant/shared`

## Task 1: Dependencies and Environment
**Files:**
- Modify: `packages/backend/package.json`
- Create local-only: `packages/backend/.env`
- Create tracked template: `packages/backend/.env.example`

**Actions:**
1. Add backend dependency: `@google/genai`.
2. Keep env in backend package scope (not repo root).
3. Add required keys:
   - `GEMINI_API_KEY`
   - `BRAVE_API_KEY`
   - `PORT=8080`
4. Add optional model indirection to reduce API drift:
   - `GEMINI_MODEL` (default flash model)
   - `GEMINI_LIVE_MODEL` (used later in phase 3)
5. Update backend dev script to load `.env` in local dev.

**Acceptance checks:**
- `pnpm dev:backend` starts and serves `/health`.
- No secrets are committed.

## Task 2: Shared Backend Utilities (`packages/backend/src/utils/`)
Extract reusable helpers that multiple services need:
- `extractMarketplace(url: string): string` — parse URL hostname to marketplace display name (Amazon, eBay, AliExpress, etc.). Used by both Gemini grounding normalization and Brave search normalization. Single source of truth; do not duplicate across service files.

## Task 3: Implement Gemini Service (`packages/backend/src/services/gemini.ts`)
Implement three exported functions:
1. `identifyProduct(imageUrl, title)` -> `ProductIdentification`
2. `groundedSearch(queries)` -> normalized `SearchResult[]`
3. `rankResults(originalImageUrl, results, identification)` -> score map

**Implementation constraints:**
- Use `responseJsonSchema` (not deprecated `responseSchema`) for structured JSON output in `identifyProduct` and `rankResults`.
- `searchQueries` must return 2-3 useful marketplace-oriented queries.
- `groundedSearch` must return normalized `SearchResult` entries with stable IDs.
- Import `extractMarketplace` from shared utils — do not define locally.
- `rankResults` should do best-effort visual comparison:
  - Include original image.
  - Include result images when available.
  - Fall back to text-based ranking note when result image is absent.

**Critical alignment note:**
Ranking must not be text-only if images are available; design intent is visual similarity support.

## Task 4: Implement Brave Service (`packages/backend/src/services/brave.ts`)
Implement `searchProducts(queries)` with per-query requests and merged results.

**Requirements:**
- Use Brave Web Search API (`/res/v1/web/search`).
- Parse `web.results`, `product_cluster`, and `extra_snippets` fields.
- Extract price/currency when present.
- Import `extractMarketplace` from shared utils — do not define locally.
- Normalize to `SearchResult` shape.
- Return empty results (not throw) on per-query provider failure; log status.

## Task 5: Implement Ranking Service (`packages/backend/src/services/ranking.ts`)
Implement:
- `mergeAndDedup(results)`
- `applyRanking(results, scores, originalPrice)`

**Required logic:**
- URL normalization dedup (strip tracking params).
- Title similarity dedup pass (simple normalized string similarity is sufficient).
- Confidence mapping from score -> `high|medium|low` using shared thresholds.
- Compute `priceDelta` and `savingsPercent` when prices are available.
- Filter clearly irrelevant results below configured minimum confidence.
- Sort primarily by confidence score, secondarily by savings.

## Task 6: Wire `/search` Route (`packages/backend/src/routes/search.ts`)
Pipeline must be:
1. Identify product
2. Parallel source search (Gemini grounding + Brave)
3. Merge/dedup
4. Rank
5. Return `SearchResponse`

**Behavioral requirements:**
- Use bounded timeouts per source.
- Graceful degradation via `Promise.allSettled`.
- Return source status (`ok|timeout|error`) for each provider.
- Keep response shape exactly aligned with shared `SearchResponse` type.

## Task 7: Implement `/chat` Route (`packages/backend/src/routes/chat.ts`)
Use Gemini Flash with:
- System instruction framing the assistant as shopping comparison helper
- Product + ranked result context injection
- Conversation history from `ChatRequest.history`

**Behavioral requirements:**
- Return `{ reply: string }` in all cases.
- On provider failure, return safe fallback reply and 500 status.

## Task 8: CORS and Middleware Verification
Confirm that CORS middleware in `packages/backend/src/index.ts` is scoped to REST endpoints only (`/health`, `/search/*`, `/chat/*`). The `/live` WebSocket upgrade path must NOT have CORS middleware applied — Hono's CORS middleware mutates response headers, which breaks WebSocket upgrade handshakes.

This has already been fixed in the codebase. Verify it remains correct after any `index.ts` changes.

## Task 9: Verification and Quality Gates
Run in order:
1. `pnpm build:shared`
2. `pnpm --filter @shopping-assistant/backend typecheck`
3. `pnpm build:backend`
4. Start backend and curl test:
   - `/health`
   - `/search`
   - `/chat`

**Completion criteria:**
- Typecheck passes.
- Build passes.
- `/search` returns non-empty metadata and source statuses.
- `/chat` returns model-backed response.

## Critical Corrections Applied vs Earlier Draft
- Removed dependency on legacy/ambiguous SDK patterns.
- Added explicit title-similarity + confidence-threshold ranking requirements.
- Added visual-ranking requirement to include result images when available.
- Added model-id indirection to reduce breakage from provider model name changes.
- Specified `responseJsonSchema` (not deprecated `responseSchema`) for Gemini structured output.
- Added shared utility extraction task (`extractMarketplace`) to avoid duplication across services.
- Added CORS scoping verification task — REST-only, not WebSocket.
- Clarified Brave Web Search API endpoint and required response fields.

## Next
Proceed to `docs/plans/2026-03-02-phase2-extension.md`.
