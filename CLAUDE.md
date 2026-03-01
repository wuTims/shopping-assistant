# Shopping Source Discovery Agent

Chrome extension (MV3) that finds cheaper product alternatives across marketplaces, powered by Gemini and Brave Search.

## Project Structure

pnpm monorepo with three packages:

- `packages/shared` — TypeScript types and constants (consumed by both)
- `packages/extension` — Chrome Extension (Vite + CRXJS + React 19)
- `packages/backend` — Cloud Run API (Hono + Node.js)

## Commands

```bash
pnpm install              # Install all workspace dependencies
pnpm build:shared         # Build shared types (run first after changes)
pnpm dev:ext              # Dev server for extension (with HMR)
pnpm dev:backend          # Dev server for backend (with watch)
pnpm build                # Build all packages (shared → ext → backend)
pnpm typecheck            # Typecheck all packages
```

## Conventions

- **TypeScript everywhere.** Strict mode. No `any` unless absolutely necessary.
- **ESM only.** All packages use `"type": "module"`. Use `.js` extensions in relative imports within shared package.
- **Shared types are the contract.** All data flowing between extension and backend MUST use types from `@shopping-assistant/shared`. Never duplicate types.
- **Backend is stateless.** No database, no user accounts, no server-side persistence. Session state lives in `chrome.storage.local`.
- **Credentials stay server-side.** Gemini and Brave API keys live in backend env vars only. The extension NEVER touches provider API keys.

## Architecture Quick Reference

**Extension flow:** Content script detects products via DOM heuristics → user clicks overlay → service worker checks cache → sends SearchRequest to backend → displays results in side panel.

**Backend pipeline:** POST /search → Gemini Flash identifies product → parallel search (Gemini Grounding + Brave) → merge/dedup → Gemini Flash visual ranking → return ranked results.

**Voice:** Side panel connects to backend via WSS → backend proxies to Gemini Live API.

See `docs/` for full specs: architecture, data model, frontend UX.

## Key Files

| What | Where |
|------|-------|
| Shared types | `packages/shared/src/types.ts` |
| Constants/thresholds | `packages/shared/src/constants.ts` |
| Content script | `packages/extension/src/content/index.ts` |
| Service worker | `packages/extension/src/background/index.ts` |
| Side panel React app | `packages/extension/src/sidepanel/` |
| Extension manifest | `packages/extension/src/manifest.json` |
| Backend entry | `packages/backend/src/index.ts` |
| Search endpoint | `packages/backend/src/routes/search.ts` |
| Chat endpoint | `packages/backend/src/routes/chat.ts` |
| Live API proxy | `packages/backend/src/ws/live.ts` |
| Gemini client | `packages/backend/src/services/gemini.ts` |
| Brave client | `packages/backend/src/services/brave.ts` |
