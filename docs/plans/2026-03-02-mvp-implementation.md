# MVP Implementation Plan (Canonical)

**Date:** 2026-03-02
**Status:** Active
**Source of truth for execution:** This file + `docs/plans/2026-03-02-mvp-implementation-design.md`

## Objective
Ship a functional Shopping Source Discovery MVP with:
- Product detection on Amazon/eBay pages
- Backend product identification + multi-source search + ranking
- Side panel results and text chat
- Real-time voice conversation via Gemini Live API

## Repository Baseline (as of 2026-03-02)
- Workspace structure is valid and buildable.
- Shared types/constants are defined in `packages/shared`.
- Backend and extension files are mostly stubs.
- Current package stack in repo:
  - Backend: Hono 4 + `@hono/node-server` + `@hono/node-ws`
  - Extension: React 19 + Vite 6 + CRXJS
  - Language/tooling: TypeScript 5.7, Node 20+

## Canonical Architecture
1. Content script detects product candidates and sends `DetectedProduct` messages.
2. Background service worker opens side panel, checks cache, calls backend `/search` on cache miss.
3. Backend `/search` runs identify -> search -> dedup/rank pipeline and returns `SearchResponse`.
4. Side panel renders ranked results and supports `/chat` follow-up Q&A.
5. Voice mode opens `/live` WebSocket and streams audio both directions through backend proxy.

## Cross-Phase Guardrails
- Use `@google/genai` only. Do not introduce legacy `@google/generative-ai` patterns.
- Use `responseJsonSchema` (not deprecated `responseSchema`) for Gemini structured JSON output.
- Keep implementations compatible with current shared contracts in `packages/shared/src/types.ts`.
- All runtime messaging payloads must be structured-clone safe.
  - Do not send browser class instances (for example raw `DOMRect`) across `chrome.runtime.sendMessage`.
  - `DetectedProduct.boundingRect` uses `SerializableRect` (plain object), not `DOMRect`.
- Do not rely on missing external plan content. Every phase doc must be executable by itself.
- Keep API keys local only (`.env`), never in tracked docs or committed files.
- Scope CORS middleware to REST endpoints only. Do not apply CORS to the `/live` WebSocket upgrade path (Hono CORS middleware mutates headers, which breaks WebSocket upgrade).
- Extract shared backend utilities (e.g., `extractMarketplace`) into `packages/backend/src/utils/` rather than duplicating across service files. Follow DRY; avoid premature abstractions (YAGNI).

## Phase Breakdown
- Phase 1 doc: `docs/plans/2026-03-02-phase1-backend-api.md`
  - Backend services (`gemini`, `brave`, `ranking`) + `/search` + `/chat`
- Phase 2 doc: `docs/plans/2026-03-02-phase2-extension.md`
  - Content detection + service worker orchestration + side panel UI
- Phase 3 doc: `docs/plans/2026-03-02-phase3-voice.md`
  - WebSocket live proxy + extension voice capture/playback + transcript UX

## End-to-End Acceptance Criteria
1. On Amazon/eBay product pages, overlay icon appears on valid product images.
2. Clicking overlay opens side panel and yields ranked alternatives.
3. Text chat answers questions with product/result context.
4. Cache returns repeat queries quickly without backend recomputation.
5. Overlay icon shows a green dot indicator when cached results are available for that product.
6. Voice mode captures microphone input, streams to backend, plays Gemini audio response, and shows transcript.

## Critical Risks To Address In Implementation
- API drift risk: Gemini model names and Live API payload shapes can change.
  - Mitigation: keep model id configurable (`GEMINI_MODEL`, `GEMINI_LIVE_MODEL`) and typecheck against installed SDK before coding business logic.
- Extension networking risk: backend calls from extension contexts can fail without explicit permissions.
  - Mitigation: include backend origin under `host_permissions` and `connect-src` where required.
- Voice capture risk: `ScriptProcessorNode` is deprecated.
  - Mitigation: implement AudioWorklet pipeline for microphone PCM streaming.
- Message serialization risk across extension contexts.
  - Mitigation: keep `DetectedProduct` payload plain JSON data only.

## Task Map (Design Alignment)
1. API key/env setup
2. Gemini identify/rank services + shared backend utilities (`extractMarketplace`, etc.)
3. Gemini grounded search service
4. Brave search integration (Web Search API)
5. Ranking + dedup + confidence filtering
6. `/search` orchestration with graceful source degradation
7. `/chat` contextual assistant endpoint
8. Content script detection + overlays (including cached-result green dot indicator)
9. Service worker routing + caching
10. Side panel results/chat UX
11. WebSocket voice proxy + extension voice UX

