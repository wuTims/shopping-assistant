# Project Scaffolding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scaffold the Shopping Source Discovery Agent monorepo so all three packages (shared, extension, backend) can build and import from each other.

**Architecture:** pnpm workspace monorepo with three packages — `shared` (types/constants), `extension` (Chrome MV3 via Vite + CRXJS + React), and `backend` (Hono on Node.js). Shared types are consumed as a workspace dependency by both extension and backend.

**Tech Stack:** TypeScript 5.x, pnpm workspaces, Vite 6, @crxjs/vite-plugin, React 19, Hono 4, tsup, Node.js 24

---

### Task 1: Initialize Monorepo Root

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.npmrc`

**Step 1: Create root package.json**

```json
{
  "name": "shopping-assistant",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:ext": "pnpm --filter @shopping-assistant/extension dev",
    "dev:backend": "pnpm --filter @shopping-assistant/backend dev",
    "build:shared": "pnpm --filter @shopping-assistant/shared build",
    "build:ext": "pnpm --filter @shopping-assistant/extension build",
    "build:backend": "pnpm --filter @shopping-assistant/backend build",
    "build": "pnpm build:shared && pnpm build:ext && pnpm build:backend",
    "typecheck": "pnpm -r typecheck",
    "clean": "pnpm -r clean"
  },
  "engines": {
    "node": ">=20"
  }
}
```

**Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
```

**Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
.turbo/
*.tsbuildinfo
.env
.env.local
```

**Step 5: Create .npmrc**

```ini
shamefully-hoist=false
strict-peer-dependencies=false
```

**Step 6: Run pnpm install to generate lockfile**

Run: `pnpm install`
Expected: Creates pnpm-lock.yaml, empty node_modules

**Step 7: Commit**

```bash
git init
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .npmrc
git commit -m "chore: initialize pnpm monorepo root"
```

---

### Task 2: Scaffold Shared Package

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/tsup.config.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/constants.ts`
- Create: `packages/shared/src/index.ts`

**Step 1: Create packages/shared/package.json**

```json
{
  "name": "@shopping-assistant/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create packages/shared/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

**Step 3: Create packages/shared/tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

**Step 4: Create packages/shared/src/types.ts**

Paste all interfaces verbatim from the data-model-flow-spec:

```typescript
// === Detection ===

export interface DetectedProduct {
  id: string;
  imageUrl: string;
  title: string | null;
  price: number | null;
  currency: string | null;
  pageUrl: string;
  marketplace: string | null;
  schemaData: Record<string, unknown> | null;
  boundingRect: DOMRect;
  detectedAt: number;
}

// === Search Request/Response ===

export interface SearchRequest {
  imageUrl: string;
  imageBase64: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  sourceUrl: string;
}

export interface ProductIdentification {
  category: string;
  description: string;
  brand: string | null;
  attributes: {
    color: string | null;
    material: string | null;
    style: string | null;
    size: string | null;
    [key: string]: string | null;
  };
  searchQueries: string[];
  estimatedPriceRange: {
    low: number;
    high: number;
    currency: string;
  } | null;
}

export interface SearchResult {
  id: string;
  source: "gemini_grounding" | "brave";
  title: string;
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string;
  marketplace: string;
  snippet: string | null;
  structuredData: {
    brand: string | null;
    availability: string | null;
    rating: number | null;
    reviewCount: number | null;
  } | null;
  raw: Record<string, unknown>;
}

export interface RankedResult {
  result: SearchResult;
  confidence: "high" | "medium" | "low";
  confidenceScore: number;
  priceDelta: number | null;
  savingsPercent: number | null;
  comparisonNotes: string;
  rank: number;
}

export interface SearchResponse {
  requestId: string;
  originalProduct: {
    title: string | null;
    price: number | null;
    currency: string | null;
    imageUrl: string;
    identification: ProductIdentification;
  };
  results: RankedResult[];
  searchMeta: {
    totalFound: number;
    braveResultCount: number;
    groundingResultCount: number;
    sourceStatus: {
      brave: "ok" | "timeout" | "error";
      grounding: "ok" | "timeout" | "error";
    };
    searchDurationMs: number;
    rankingDurationMs: number;
  };
}

// === Cache ===

export interface CachedSearch {
  productId: string;
  response: SearchResponse;
  cachedAt: number;
  ttl: number;
}

// === Chat ===

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  inputMode: "text" | "voice";
  timestamp: number;
  context: {
    currentProduct: DetectedProduct | null;
    searchResults: RankedResult[] | null;
  } | null;
}

// === API Contracts ===

export interface ChatRequest {
  message: string;
  context: {
    product: DetectedProduct | null;
    results: RankedResult[] | null;
  };
  history: ChatMessage[];
}

export interface ChatResponse {
  reply: string;
}

// === WebSocket Messages ===

export type WsClientMessage =
  | { type: "config"; context: Record<string, unknown> }
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 16000; data: string }
  | { type: "text"; content: string };

export type WsServerMessage =
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 24000; data: string }
  | { type: "transcript"; content: string }
  | { type: "turn_complete" };
```

**Step 5: Create packages/shared/src/constants.ts**

```typescript
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const CACHE_MAX_ENTRIES = 50;
export const CACHE_SESSION_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
export const MAX_OVERLAYS_PER_PAGE = 20;
export const MIN_IMAGE_SIZE_PX = 100;
export const OVERLAY_ICON_SIZE_PX = 28;
export const OVERLAY_ICON_HOVER_SIZE_PX = 32;
export const SEARCH_TIMEOUT_MS = 15_000;
export const CHAT_TIMEOUT_MS = 10_000;
export const MAX_CHAT_HISTORY = 20;
export const SIDE_PANEL_WIDTH_PX = 360;

export const CONFIDENCE_THRESHOLDS = {
  high: 0.7,
  medium: 0.4,
} as const;
```

**Step 6: Create packages/shared/src/index.ts**

```typescript
export * from "./types.js";
export * from "./constants.js";
```

**Step 7: Install dependencies and verify build**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm install && pnpm build:shared`
Expected: Clean build, `packages/shared/dist/` contains index.js and index.d.ts

**Step 8: Commit**

```bash
git add packages/shared/
git commit -m "feat: add shared types and constants package"
```

---

### Task 3: Scaffold Extension Package

**Files:**
- Create: `packages/extension/package.json`
- Create: `packages/extension/tsconfig.json`
- Create: `packages/extension/vite.config.ts`
- Create: `packages/extension/src/manifest.json`
- Create: `packages/extension/src/content/index.ts`
- Create: `packages/extension/src/background/index.ts`
- Create: `packages/extension/src/sidepanel/index.html`
- Create: `packages/extension/src/sidepanel/index.tsx`
- Create: `packages/extension/src/sidepanel/App.tsx`
- Create: `packages/extension/src/sidepanel/App.css`

**Step 1: Create packages/extension/package.json**

```json
{
  "name": "@shopping-assistant/extension",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@shopping-assistant/shared": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.28",
    "@types/chrome": "^0.0.300",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

**Step 2: Create packages/extension/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome"]
  },
  "include": ["src"]
}
```

**Step 3: Create packages/extension/vite.config.ts**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.json";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: "dist",
  },
});
```

**Step 4: Create packages/extension/src/manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Shopping Source Discovery",
  "version": "0.1.0",
  "description": "Find cheaper alternatives for any product you see online.",
  "permissions": ["sidePanel", "storage", "activeTab"],
  "background": {
    "service_worker": "background/index.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/index.ts"],
      "run_at": "document_idle"
    }
  ],
  "side_panel": {
    "default_path": "sidepanel/index.html"
  },
  "action": {
    "default_title": "Shopping Source Discovery"
  },
  "icons": {}
}
```

**Step 5: Create packages/extension/src/content/index.ts**

Minimal placeholder — detection logic is a separate implementation task.

```typescript
import type { DetectedProduct } from "@shopping-assistant/shared";

console.log("[Shopping Assistant] Content script loaded");

// Placeholder: DOM heuristic detection will be implemented here
function detectProducts(): DetectedProduct[] {
  // TODO: Implement schema.org, OG tags, price pattern detection
  return [];
}

detectProducts();
```

**Step 6: Create packages/extension/src/background/index.ts**

Minimal service worker scaffold.

```typescript
console.log("[Shopping Assistant] Service worker started");

// Open side panel on extension icon click
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Shopping Assistant] Message received:", message);
  // TODO: Route messages to side panel, handle search orchestration
  sendResponse({ status: "ok" });
  return true;
});
```

**Step 7: Create packages/extension/src/sidepanel/index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Shopping Assistant</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./index.tsx"></script>
  </body>
</html>
```

**Step 8: Create packages/extension/src/sidepanel/index.tsx**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./App.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

**Step 9: Create packages/extension/src/sidepanel/App.tsx**

```tsx
export default function App() {
  return (
    <div className="panel">
      <header className="header">
        <h1>Shopping Assistant</h1>
      </header>
      <main className="main">
        <p className="placeholder">Click a product overlay to search for cheaper alternatives.</p>
      </main>
    </div>
  );
}
```

**Step 10: Create packages/extension/src/sidepanel/App.css**

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1f2937;
  background: #ffffff;
  width: 360px;
}

.panel {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.header {
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}

.header h1 {
  font-size: 16px;
  font-weight: 600;
}

.main {
  flex: 1;
  padding: 16px;
}

.placeholder {
  color: #6b7280;
  font-size: 14px;
  text-align: center;
  margin-top: 40px;
}
```

**Step 11: Install dependencies and verify build**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm install && pnpm build:ext`
Expected: Build completes. `packages/extension/dist/` contains compiled extension files.

**Step 12: Commit**

```bash
git add packages/extension/
git commit -m "feat: scaffold chrome extension with Vite, CRXJS, and React"
```

---

### Task 4: Scaffold Backend Package

**Files:**
- Create: `packages/backend/package.json`
- Create: `packages/backend/tsconfig.json`
- Create: `packages/backend/tsup.config.ts`
- Create: `packages/backend/Dockerfile`
- Create: `packages/backend/src/index.ts`
- Create: `packages/backend/src/routes/search.ts`
- Create: `packages/backend/src/routes/chat.ts`
- Create: `packages/backend/src/services/gemini.ts`
- Create: `packages/backend/src/services/brave.ts`
- Create: `packages/backend/src/services/ranking.ts`
- Create: `packages/backend/src/ws/live.ts`

**Step 1: Create packages/backend/package.json**

```json
{
  "name": "@shopping-assistant/backend",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@shopping-assistant/shared": "workspace:*",
    "hono": "^4.0.0",
    "@hono/node-server": "^1.0.0",
    "@hono/node-ws": "^1.0.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create packages/backend/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "lib": ["ES2022"]
  },
  "include": ["src"]
}
```

**Step 3: Create packages/backend/tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node20",
});
```

**Step 4: Create packages/backend/src/index.ts**

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";

import { searchRoute } from "./routes/search.js";
import { chatRoute } from "./routes/chat.js";
import { liveWebSocket } from "./ws/live.js";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*", // TODO: Restrict to extension origin in production
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type"],
  }),
);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Routes
app.route("/search", searchRoute);
app.route("/chat", chatRoute);

// WebSocket for Live API proxy
app.get("/live", upgradeWebSocket(liveWebSocket));

const port = Number(process.env.PORT) || 8080;
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Backend running on http://localhost:${info.port}`);
});

injectWebSocket(server);
```

**Step 5: Create packages/backend/src/routes/search.ts**

```typescript
import { Hono } from "hono";
import type { SearchRequest, SearchResponse } from "@shopping-assistant/shared";

export const searchRoute = new Hono();

searchRoute.post("/", async (c) => {
  const body = await c.req.json<SearchRequest>();

  // TODO: Implement identification → parallel search → ranking pipeline
  console.log("[search] Received request for:", body.title ?? body.imageUrl);

  const stubResponse: SearchResponse = {
    requestId: crypto.randomUUID(),
    originalProduct: {
      title: body.title,
      price: body.price,
      currency: body.currency,
      imageUrl: body.imageUrl,
      identification: {
        category: "unknown",
        description: "Product identification not yet implemented",
        brand: null,
        attributes: { color: null, material: null, style: null, size: null },
        searchQueries: [],
        estimatedPriceRange: null,
      },
    },
    results: [],
    searchMeta: {
      totalFound: 0,
      braveResultCount: 0,
      groundingResultCount: 0,
      sourceStatus: { brave: "ok", grounding: "ok" },
      searchDurationMs: 0,
      rankingDurationMs: 0,
    },
  };

  return c.json(stubResponse);
});
```

**Step 6: Create packages/backend/src/routes/chat.ts**

```typescript
import { Hono } from "hono";
import type { ChatRequest, ChatResponse } from "@shopping-assistant/shared";

export const chatRoute = new Hono();

chatRoute.post("/", async (c) => {
  const body = await c.req.json<ChatRequest>();

  // TODO: Implement Gemini Flash chat with product context
  console.log("[chat] Received message:", body.message);

  const response: ChatResponse = {
    reply: "Chat is not yet implemented. This is a placeholder response.",
  };

  return c.json(response);
});
```

**Step 7: Create packages/backend/src/services/gemini.ts**

```typescript
// Gemini Flash client for identification, grounded search, and ranking
// TODO: Implement with @google/generative-ai SDK

export async function identifyProduct(imageUrl: string, title: string | null) {
  throw new Error("Not implemented: identifyProduct");
}

export async function groundedSearch(queries: string[]) {
  throw new Error("Not implemented: groundedSearch");
}

export async function rankResults(
  originalImageUrl: string,
  resultImageUrls: string[],
) {
  throw new Error("Not implemented: rankResults");
}
```

**Step 8: Create packages/backend/src/services/brave.ts**

```typescript
// Brave Search LLM Context API client
// TODO: Implement with fetch to Brave API

export async function searchProducts(queries: string[]) {
  throw new Error("Not implemented: searchProducts");
}
```

**Step 9: Create packages/backend/src/services/ranking.ts**

```typescript
import type { SearchResult, RankedResult } from "@shopping-assistant/shared";

// Merge, deduplicate, and prepare results for Gemini visual ranking
// TODO: Implement deduplication by URL and title similarity

export function mergeAndDedup(results: SearchResult[]): SearchResult[] {
  return results;
}

export function applyRanking(
  results: SearchResult[],
  scores: Record<string, number>,
  originalPrice: number | null,
): RankedResult[] {
  return [];
}
```

**Step 10: Create packages/backend/src/ws/live.ts**

```typescript
import type { WSContext } from "hono/ws";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";

// Gemini Live API WebSocket proxy
// TODO: Implement upstream Gemini Live API session management

export function liveWebSocket(c: unknown) {
  return {
    onOpen(_evt: Event, ws: WSContext) {
      console.log("[ws] Client connected");
    },

    onMessage(evt: MessageEvent, ws: WSContext) {
      const message = JSON.parse(evt.data as string) as WsClientMessage;
      console.log("[ws] Received:", message.type);

      // TODO: Forward to Gemini Live API upstream session
      if (message.type === "text") {
        const response: WsServerMessage = {
          type: "transcript",
          content: "Live API proxy not yet implemented.",
        };
        ws.send(JSON.stringify(response));
      }
    },

    onClose() {
      console.log("[ws] Client disconnected");
    },
  };
}
```

**Step 11: Create packages/backend/Dockerfile**

```dockerfile
FROM node:20-slim AS base
RUN corepack enable

WORKDIR /app

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @shopping-assistant/backend --filter @shopping-assistant/shared

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/backend/ packages/backend/

# Build
RUN pnpm build:shared && pnpm --filter @shopping-assistant/backend build

# Run
FROM node:20-slim
WORKDIR /app
COPY --from=base /app/packages/backend/dist ./dist
COPY --from=base /app/packages/backend/package.json ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

**Step 12: Install dependencies and verify build**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm install && pnpm build:shared && pnpm build:backend`
Expected: Clean build. `packages/backend/dist/index.js` exists.

**Step 13: Verify backend starts**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && timeout 5 pnpm dev:backend || true`
Expected: Logs "Backend running on http://localhost:8080" before timeout kills it.

**Step 14: Commit**

```bash
git add packages/backend/
git commit -m "feat: scaffold Hono backend with search, chat, and WebSocket routes"
```

---

### Task 5: Organize Documentation Artifacts

**Files:**
- Move: `architecture-spec.md` → `docs/architecture-spec.md`
- Move: `architecture-diagram.mermaid` → `docs/architecture-diagram.mermaid`
- Move: `data-model-flow-spec.md` → `docs/data-model-flow-spec.md`
- Move: `frontend-ux-spec.md` → `docs/frontend-ux-spec.md`

**Step 1: Move spec files into docs/**

```bash
mv architecture-spec.md docs/
mv architecture-diagram.mermaid docs/
mv data-model-flow-spec.md docs/
mv frontend-ux-spec.md docs/
```

**Step 2: Commit**

```bash
git add -A
git commit -m "chore: organize spec documents into docs/"
```

---

### Task 6: Create CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

**Step 1: Write CLAUDE.md**

See the full content below — lean, convention-focused, no fluff.

```markdown
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
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md with project conventions and structure"
```

---

### Task 7: Final Verification

**Step 1: Full workspace install + build**

Run: `pnpm install && pnpm build`
Expected: All three packages build cleanly with zero errors.

**Step 2: Typecheck all packages**

Run: `pnpm typecheck`
Expected: No type errors across any package.

**Step 3: Verify extension loads in Chrome**

Manual check: Load `packages/extension/dist/` as unpacked extension in `chrome://extensions`. Side panel should open and show "Shopping Assistant" placeholder.

**Step 4: Verify backend responds**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm dev:backend &` then `curl http://localhost:8080/health`
Expected: `{"status":"ok"}`

**Step 5: Final commit if any fixups needed**

```bash
git add -A
git commit -m "chore: fix scaffolding issues from verification"
```
