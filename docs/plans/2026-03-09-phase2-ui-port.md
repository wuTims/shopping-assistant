# Phase 2 Extension UI Port Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the Phase 2 styled UI (Tailwind design system, component-based side panel with Header/PriceBar/ResultCard/ChatThread) onto main's current functionality (screenshot-based detection, image overlay, price fallback, marketplace queries). Creates a new branch from main.

**Architecture:** New branch from main inherits all backend and extension functionality unchanged. Tailwind CSS replaces vanilla App.css. Side panel decomposes into Header, ProductSection, PriceBar, ResultCard, ChatThread components. App.tsx adapts phase2's layout/interactions to main's message protocol. Service worker gains state tracking (GET_STATE), chat forwarding (CHAT_REQUEST), and enriched messages. Content script and backend pipeline are untouched.

**Tech Stack:** React 19, Tailwind CSS v3, Vite + CRXJS, Chrome MV3 APIs, TypeScript strict mode

**Branch:** Create `feat/phase2-extension-ui-v2` from `main` (replaces the stale `feat/phase2-extension-ui` branch)

---

### Task 1: Create Branch + Tailwind Setup

**Files:**
- Create: `packages/extension/tailwind.config.ts`
- Create: `packages/extension/postcss.config.js`
- Create: `packages/extension/src/sidepanel/index.css`
- Modify: `packages/extension/src/sidepanel/index.html`
- Modify: `packages/extension/src/sidepanel/index.tsx`
- Delete: `packages/extension/src/sidepanel/App.css`
- Modify: `packages/extension/package.json` (via pnpm add)

**Step 1: Create branch from main**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && git checkout main && git checkout -b feat/phase2-extension-ui-v2`

**Step 2: Install Tailwind dependencies**

Run: `pnpm --filter @shopping-assistant/extension add -D tailwindcss postcss autoprefixer`

**Step 3: Create tailwind.config.ts**

Create `packages/extension/tailwind.config.ts`:

```typescript
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        primary: "#d95a00",
        "primary-dark": "#b34800",
        background: "#fdfaf5",
        surface: "#ffffff",
        "text-main": "#1a202c",
        "text-muted": "#4a5568",
        "accent-green": "#10b981",
        "accent-red": "#ef4444",
        "accent-yellow": "#f59e0b",
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
      boxShadow: {
        soft: "0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)",
      },
    },
  },
  plugins: [],
} satisfies Config;
```

**Step 4: Create postcss.config.js**

Create `packages/extension/postcss.config.js`:

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

**Step 5: Create index.css (replaces App.css)**

Create `packages/extension/src/sidepanel/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  @apply bg-background text-text-main;
  font-family: "Inter", sans-serif;
  width: 360px;
}

.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
```

**Step 6: Update index.html**

Replace `packages/extension/src/sidepanel/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Personal Shopper</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./index.tsx"></script>
  </body>
</html>
```

**Step 7: Update index.tsx**

Replace `packages/extension/src/sidepanel/index.tsx`:

```typescript
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

**Step 8: Delete App.css**

Run: `rm packages/extension/src/sidepanel/App.css`

**Step 9: Typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS (App.tsx still compiles — Tailwind classes are just strings).

**Step 10: Commit**

```bash
git add packages/extension/
git commit -m "feat(ext): add Tailwind CSS with design system tokens"
```

---

### Task 2: Update Shared Types + Backend Chat Route

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/backend/src/routes/chat.ts`

**Step 1: Add new types to shared/src/types.ts**

Add after the `CachedSearch` interface (after line 157):

```typescript
// === Extension Display Types ===

/** Minimal product info for UI display across extension contexts */
export interface ProductDisplayInfo {
  name: string;
  price: number | null;
  currency: string | null;
  imageUrl?: string;
  marketplace?: string;
}

/** Flexible product context for chat — accepts both DetectedProduct and ProductDisplayInfo shapes */
export interface ChatProductContext {
  title?: string | null;
  name?: string | null;
  price: number | null;
  currency: string | null;
  marketplace?: string | null;
  imageUrl?: string | null;
}

/** Service Worker → Side Panel messages */
export type BackgroundToSidePanelMessage =
  | { target: "sidepanel"; type: "identifying" }
  | { target: "sidepanel"; type: "product_selection"; products: IdentifiedProduct[]; screenshotDataUrl: string; pageUrl: string; tabId: number }
  | { target: "sidepanel"; type: "searching"; product: ProductDisplayInfo }
  | { target: "sidepanel"; type: "results"; product: ProductDisplayInfo; response: SearchResponse }
  | { target: "sidepanel"; type: "error"; product: ProductDisplayInfo | null; message: string }
  | { target: "sidepanel"; type: "chat_response"; reply: string }
  | { target: "sidepanel"; type: "chat_error"; error: string };

/** Side Panel → Service Worker messages */
export type SidePanelToBackgroundMessage =
  | { type: "select_product"; tabId: number; product: IdentifiedProduct; screenshotDataUrl: string; pageUrl: string }
  | { type: "GET_STATE" }
  | { type: "CHAT_REQUEST"; request: ChatRequest };
```

**Step 2: Update ChatRequest.context.product type**

In `packages/shared/src/types.ts`, change the `ChatRequest` interface (around line 175):

From:
```typescript
export interface ChatRequest {
  message: string;
  context: {
    product: DetectedProduct | null;
    results: RankedResult[] | null;
  };
  history: ChatMessage[];
}
```

To:
```typescript
export interface ChatRequest {
  message: string;
  context: {
    product: ChatProductContext | null;
    results: RankedResult[] | null;
  };
  history: ChatMessage[];
}
```

**Step 3: Update ChatMessage.context type**

In `packages/shared/src/types.ts`, change the `ChatMessage` interface (around line 161):

From:
```typescript
  context: {
    currentProduct: DetectedProduct | null;
    searchResults: RankedResult[] | null;
  } | null;
```

To:
```typescript
  context: {
    currentProduct: ChatProductContext | null;
    searchResults: RankedResult[] | null;
  } | null;
```

**Step 4: Add lastAccessedAt to CachedSearch**

In `packages/shared/src/types.ts`, update the `CachedSearch` interface (around line 152):

From:
```typescript
export interface CachedSearch {
  productId: string;
  response: SearchResponse;
  cachedAt: number;
  ttl: number;
}
```

To:
```typescript
export interface CachedSearch {
  productId: string;
  response: SearchResponse;
  cachedAt: number;
  lastAccessedAt: number;
  ttl: number;
}
```

**Step 5: Update backend chat route**

In `packages/backend/src/routes/chat.ts`, change the import (line 6):

From:
```typescript
  DetectedProduct,
```

To:
```typescript
  ChatProductContext,
```

Then update the `buildContextBlock` function signature (line 81):

From:
```typescript
function buildContextBlock(
  product: DetectedProduct | null,
  results: RankedResult[] | null,
): string {
```

To:
```typescript
function buildContextBlock(
  product: ChatProductContext | null,
  results: RankedResult[] | null,
): string {
```

And update the title line (line 89):

From:
```typescript
    parts.push(`Title: ${product.title ?? "Unknown"}`);
```

To:
```typescript
    parts.push(`Title: ${product.title ?? product.name ?? "Unknown"}`);
```

**Step 6: Build shared and typecheck**

Run: `pnpm build:shared && pnpm typecheck`
Expected: PASS.

**Step 7: Run backend tests**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All tests PASS.

**Step 8: Commit**

```bash
git add packages/shared/src/types.ts packages/backend/src/routes/chat.ts
git commit -m "feat(shared): add extension display types and flexible chat product context"
```

---

### Task 3: Create Side Panel UI Components

**Files:**
- Create: `packages/extension/src/sidepanel/components/Header.tsx`
- Create: `packages/extension/src/sidepanel/components/ProductSection.tsx`
- Create: `packages/extension/src/sidepanel/components/PriceBar.tsx`
- Create: `packages/extension/src/sidepanel/components/ResultCard.tsx`
- Create: `packages/extension/src/sidepanel/components/ChatThread.tsx`

**Step 1: Create components directory**

Run: `mkdir -p packages/extension/src/sidepanel/components`

**Step 2: Create Header.tsx**

Create `packages/extension/src/sidepanel/components/Header.tsx`:

```typescript
export function Header() {
  return (
    <header className="flex items-center justify-between px-5 py-3.5 bg-background border-b border-gray-200 sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <span className="material-icons text-primary text-xl">shopping_bag</span>
        <h1 className="text-lg font-semibold text-text-main">Personal Shopper</h1>
      </div>
      <button
        className="w-8 h-8 flex items-center justify-center rounded-full text-text-muted hover:bg-gray-200 transition-colors"
        aria-label="Settings"
      >
        <span className="material-icons text-xl">settings</span>
      </button>
    </header>
  );
}
```

**Step 3: Create ProductSection.tsx**

Create `packages/extension/src/sidepanel/components/ProductSection.tsx`:

```typescript
import type { ProductDisplayInfo } from "@shopping-assistant/shared";

interface Props {
  product: ProductDisplayInfo;
}

export function ProductSection({ product }: Props) {
  const priceStr = product.price !== null
    ? `${product.currency === "USD" || !product.currency ? "$" : product.currency}${product.price}`
    : null;

  return (
    <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {product.imageUrl ? (
            <img
              src={product.imageUrl}
              alt={product.name}
              className="w-14 h-14 rounded-xl object-cover shadow-sm"
            />
          ) : (
            <div className="w-14 h-14 rounded-xl bg-gray-100 flex items-center justify-center shadow-sm">
              <span className="material-icons text-2xl text-gray-300">image</span>
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs text-text-muted font-medium">Current Product</p>
            <p className="text-base font-bold text-text-main mt-0.5 truncate max-w-[180px]">
              {product.name}
              {priceStr && <span className="text-primary ml-1.5">{priceStr}</span>}
            </p>
            {product.marketplace && (
              <p className="text-xs text-text-muted">on {product.marketplace}</p>
            )}
          </div>
        </div>
        <span className="bg-orange-100 text-primary text-xs font-semibold px-2.5 py-1 rounded-full shadow-sm whitespace-nowrap">
          You're Here
        </span>
      </div>
    </section>
  );
}
```

**Step 4: Create PriceBar.tsx**

Create `packages/extension/src/sidepanel/components/PriceBar.tsx`:

```typescript
import type { SearchResponse } from "@shopping-assistant/shared";

interface Props {
  productPrice: number | null;
  response: SearchResponse;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function PriceBar({ productPrice, response, collapsed, onToggle }: Props) {
  const prices = response.results
    .map((r) => r.result.price)
    .filter((p): p is number => p !== null);

  if (prices.length === 0 || productPrice === null) return null;

  const allPrices = [...prices, productPrice];
  const low = Math.min(...allPrices);
  const high = Math.max(...allPrices);
  const range = high - low;
  if (range === 0) return null;

  const position = ((productPrice - low) / range) * 100;
  const bestPrice = Math.min(...prices);
  const bestResult = response.results.find((r) => r.result.price === bestPrice);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const aboveAvg = Math.round(((productPrice - avg) / avg) * 100);

  const label = position > 66 ? "HIGH" : position > 33 ? "FAIR" : "LOW";
  const labelColor = position > 66 ? "text-accent-red" : position > 33 ? "text-accent-yellow" : "text-accent-green";
  const dotBorder = position > 66 ? "border-accent-red" : position > 33 ? "border-accent-yellow" : "border-accent-green";

  if (collapsed) {
    return (
      <button onClick={onToggle} className="w-full bg-surface rounded-2xl px-4 py-2.5 shadow-soft border border-gray-100 flex items-center gap-2 text-left">
        <span className="material-icons text-sm text-accent-red">warning_amber</span>
        <span className="text-sm text-text-muted">Price is <span className={`font-bold ${labelColor}`}>{label}</span></span>
        <span className="material-icons text-xs text-text-muted ml-auto">expand_more</span>
      </button>
    );
  }

  return (
    <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
      {onToggle ? (
        <button onClick={onToggle} className="w-full flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="material-icons text-sm text-accent-red">warning_amber</span>
            <span className="text-sm text-text-muted">This price is</span>
            <span className={`text-sm font-bold ${labelColor}`}>{label}</span>
          </div>
          <span className="material-icons text-xs text-text-muted">expand_less</span>
        </button>
      ) : (
        <div className="flex items-center gap-2 mb-3">
          <span className="material-icons text-sm text-accent-red">warning_amber</span>
          <span className="text-sm text-text-muted">This price is</span>
          <span className={`text-sm font-bold ${labelColor}`}>{label}</span>
        </div>
      )}

      {/* Gradient bar */}
      <div className="relative h-2 rounded-full w-full mb-2 bg-gradient-to-r from-accent-green via-accent-yellow to-accent-red">
        <div
          className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full border-4 ${dotBorder} shadow-sm z-10`}
          style={{ left: `${Math.min(Math.max(position, 5), 95)}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-text-muted mb-4">
        <span>${low.toFixed(2)}</span>
        <span>${high.toFixed(2)}</span>
      </div>

      {/* AI insight */}
      {bestResult && (
        <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 shadow-sm">
            <span className="material-icons text-sm">smart_toy</span>
          </div>
          <p className="text-sm text-text-main leading-snug">
            {aboveAvg > 0 ? (
              <>
                <span className="font-bold text-primary">{aboveAvg}%</span> above average.
                Best on {bestResult.result.marketplace}.
              </>
            ) : (
              <>This price is competitive.</>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
```

**Step 5: Create ResultCard.tsx**

Create `packages/extension/src/sidepanel/components/ResultCard.tsx`:

```typescript
import type { RankedResult } from "@shopping-assistant/shared";

interface Props {
  ranked: RankedResult;
  compact?: boolean;
}

export function ResultCard({ ranked, compact }: Props) {
  const { result } = ranked;
  const priceStr = result.price !== null
    ? `$${result.price.toFixed(2)}`
    : "N/A";

  const savingsStr = ranked.savingsPercent !== null && ranked.savingsPercent > 0
    ? `${ranked.savingsPercent.toFixed(0)}% less`
    : null;

  const handleClick = () => {
    window.open(result.productUrl, "_blank", "noopener");
  };

  const confidenceIndicator =
    ranked.confidence === "medium" ? (
      <span className="text-xs text-accent-yellow font-medium">Similar</span>
    ) : ranked.confidence === "low" ? (
      <span className="text-xs text-text-muted font-medium">May differ</span>
    ) : null;

  if (compact) {
    return (
      <button
        onClick={handleClick}
        className="w-full flex items-center gap-2.5 py-2 px-1 hover:bg-gray-50 rounded-lg transition-colors text-left group"
      >
        {result.imageUrl && (
          <img
            src={result.imageUrl}
            alt={result.title}
            className="w-8 h-8 rounded-lg object-cover mix-blend-multiply opacity-90 group-hover:opacity-100 shrink-0"
          />
        )}
        <span className="text-xs text-text-muted font-medium shrink-0 w-20 truncate">{result.marketplace}</span>
        <span className="text-xs text-text-main truncate flex-1">{result.title}</span>
        <span className="text-sm font-bold text-text-main shrink-0">{priceStr}</span>
        {savingsStr && (
          <span className="text-xs text-accent-green font-medium shrink-0">-{ranked.savingsPercent?.toFixed(0)}%</span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-center justify-between group py-1 text-left"
    >
      <div className="flex items-center gap-3 min-w-0">
        {result.imageUrl && (
          <img
            src={result.imageUrl}
            alt={result.title}
            className="w-12 h-12 rounded-xl object-cover mix-blend-multiply opacity-90 group-hover:opacity-100 transition-opacity shrink-0"
          />
        )}
        <div className="min-w-0">
          <h4 className="font-medium text-text-main text-sm truncate max-w-[160px]">{result.title}</h4>
          <p className="text-text-muted text-xs">{result.marketplace}</p>
          {confidenceIndicator}
        </div>
      </div>
      <div className="text-right shrink-0 ml-2">
        <p className="font-bold text-base text-text-main">{priceStr}</p>
        {savingsStr && (
          <p className="text-accent-green text-xs font-medium">{savingsStr}</p>
        )}
      </div>
    </button>
  );
}
```

**Step 6: Create ChatThread.tsx**

Create `packages/extension/src/sidepanel/components/ChatThread.tsx`:

```typescript
import { useState, useRef, useEffect } from "react";
import type { ChatMessage } from "@shopping-assistant/shared";

interface Props {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isLoading: boolean;
}

export function ChatThread({ messages, onSendMessage, isLoading }: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    onSendMessage(text);
    setInput("");
    inputRef.current?.focus();
  };

  const handleMicClick = () => {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed", bottom: "70px", right: "20px",
      background: "#1a202c", color: "white", padding: "6px 12px",
      borderRadius: "8px", fontSize: "12px", zIndex: "9999",
    } as CSSStyleDeclaration);
    el.textContent = "Voice coming soon";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar">
        {messages.length === 0 && (
          <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 flex items-center gap-3">
            <div className="w-7 h-7 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <p className="text-sm text-text-main">I can help you compare — hold mic or type below.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
                <span className="material-icons text-xs">smart_toy</span>
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-white rounded-br-md"
                  : "bg-white border border-gray-100 text-text-main rounded-bl-md shadow-sm"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="px-3 py-2.5 border-t border-gray-100 bg-background">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="Ask about these..."
            className="flex-1 bg-white border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-text-main placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            disabled={isLoading}
          />
          {input.trim() ? (
            <button
              onClick={handleSubmit}
              disabled={isLoading}
              className="w-10 h-10 flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary-dark transition-colors disabled:opacity-50"
            >
              <span className="material-icons text-lg">send</span>
            </button>
          ) : (
            <button
              onClick={handleMicClick}
              className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 text-text-muted hover:bg-gray-200 transition-colors"
            >
              <span className="material-icons text-lg">mic</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

**Step 7: Typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS.

**Step 8: Commit**

```bash
git add packages/extension/src/sidepanel/components/
git commit -m "feat(ext): add side panel components — Header, ProductSection, PriceBar, ResultCard, ChatThread"
```

---

### Task 4: Rewrite App.tsx with Phase 2 Design

**Files:**
- Modify: `packages/extension/src/sidepanel/App.tsx`

**Step 1: Replace App.tsx**

Replace `packages/extension/src/sidepanel/App.tsx` with:

```typescript
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  IdentifiedProduct,
  ProductDisplayInfo,
  SearchResponse,
  ChatMessage,
  ChatRequest,
  BackgroundToSidePanelMessage,
} from "@shopping-assistant/shared";
import { Header } from "./components/Header";
import { ProductSection } from "./components/ProductSection";
import { PriceBar } from "./components/PriceBar";
import { ResultCard } from "./components/ResultCard";
import { ChatThread } from "./components/ChatThread";

type ViewState =
  | { view: "empty" }
  | { view: "identifying" }
  | { view: "product_selection"; products: IdentifiedProduct[]; screenshotDataUrl: string; pageUrl: string; tabId: number }
  | { view: "loading"; product: ProductDisplayInfo; phase: 1 | 2 | 3 }
  | { view: "results"; product: ProductDisplayInfo; response: SearchResponse }
  | { view: "error"; message: string };

export default function App() {
  const [state, setState] = useState<ViewState>({ view: "empty" });
  const [chatActive, setChatActive] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [priceBarCollapsed, setPriceBarCollapsed] = useState(false);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ── Request initial state from service worker ──
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response: BackgroundToSidePanelMessage | null) => {
      if (chrome.runtime.lastError || !response) return;
      handleMessage(response);
    });
  }, []);

  // ── Listen for messages from service worker ──
  useEffect(() => {
    const listener = (message: Record<string, unknown>) => {
      if (message.target !== "sidepanel") return;
      handleMessage(message as BackgroundToSidePanelMessage);
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      clearPhaseTimers();
    };
  }, []);

  function handleMessage(message: BackgroundToSidePanelMessage) {
    switch (message.type) {
      case "identifying":
        setState({ view: "identifying" });
        setChatActive(false);
        setChatMessages([]);
        break;
      case "product_selection":
        clearPhaseTimers();
        setState({
          view: "product_selection",
          products: message.products,
          screenshotDataUrl: message.screenshotDataUrl,
          pageUrl: message.pageUrl,
          tabId: message.tabId,
        });
        break;
      case "searching":
        setState({ view: "loading", product: message.product, phase: 1 });
        setChatActive(false);
        setChatMessages([]);
        setChatLoading(false);
        setPriceBarCollapsed(false);
        startPhaseTimers();
        break;
      case "results":
        clearPhaseTimers();
        setState({ view: "results", product: message.product, response: message.response });
        break;
      case "error":
        clearPhaseTimers();
        setState({ view: "error", message: message.message });
        break;
      case "chat_response":
        setChatLoading(false);
        setChatMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: message.reply,
            inputMode: "text",
            timestamp: Date.now(),
            context: null,
          },
        ]);
        break;
      case "chat_error":
        setChatLoading(false);
        setChatMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "Sorry, I couldn't respond. Please try again.",
            inputMode: "text",
            timestamp: Date.now(),
            context: null,
          },
        ]);
        break;
    }
  }

  function startPhaseTimers() {
    clearPhaseTimers();
    phaseTimersRef.current = [
      setTimeout(() => setState((s) => s.view === "loading" ? { ...s, phase: 2 } : s), 2000),
      setTimeout(() => setState((s) => s.view === "loading" ? { ...s, phase: 3 } : s), 5000),
    ];
  }

  function clearPhaseTimers() {
    phaseTimersRef.current.forEach(clearTimeout);
    phaseTimersRef.current = [];
  }

  const handleSendMessage = useCallback((text: string) => {
    if (state.view !== "results") return;

    if (!chatActive) {
      setChatActive(true);
      setPriceBarCollapsed(true);
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      inputMode: "text",
      timestamp: Date.now(),
      context: chatMessages.length === 0 ? {
        currentProduct: state.product,
        searchResults: state.response.results,
      } : null,
    };

    const newMessages = [...chatMessages, userMessage];
    setChatMessages(newMessages);
    setChatLoading(true);

    const request: ChatRequest = {
      message: text,
      context: {
        product: state.product,
        results: state.response.results,
      },
      history: newMessages,
    };

    chrome.runtime.sendMessage({ type: "CHAT_REQUEST", request });
  }, [state, chatActive, chatMessages]);

  const phaseText = (phase: 1 | 2 | 3) => {
    switch (phase) {
      case 1: return "Identifying product...";
      case 2: return "Searching across marketplaces...";
      case 3: return "Comparing results...";
    }
  };

  // Filter results to those with pricing data
  const displayResults = state.view === "results"
    ? state.response.results.filter((r) => r.priceAvailable)
    : [];
  const hiddenCount = state.view === "results"
    ? state.response.results.length - displayResults.length
    : 0;

  return (
    <div className="flex flex-col h-screen bg-background font-display">
      <Header />

      {/* Empty state */}
      {state.view === "empty" && (
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <span className="material-icons text-5xl text-gray-300 mb-3 block">shopping_bag</span>
            <p className="text-text-muted text-sm">Click the extension icon or a product overlay to find better prices.</p>
          </div>
        </main>
      )}

      {/* Identifying state */}
      {state.view === "identifying" && (
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <div className="w-10 h-10 border-4 border-gray-200 border-t-primary rounded-full animate-spin mb-4 mx-auto" />
            <p className="text-sm text-text-muted animate-pulse">Identifying products...</p>
          </div>
        </main>
      )}

      {/* Product selection */}
      {state.view === "product_selection" && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar">
          <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
            <h3 className="font-semibold text-base mb-2 text-text-main">Multiple products found</h3>
            <p className="text-sm text-text-muted mb-4">Which product are you looking for?</p>
            <div className="space-y-2">
              {state.products.map((product, i) => (
                <button
                  key={i}
                  onClick={() => {
                    chrome.runtime.sendMessage({
                      type: "select_product",
                      tabId: state.tabId,
                      product,
                      screenshotDataUrl: state.screenshotDataUrl,
                      pageUrl: state.pageUrl,
                    });
                    setState({
                      view: "loading",
                      product: { name: product.name, price: product.price, currency: product.currency },
                      phase: 1,
                    });
                    startPhaseTimers();
                  }}
                  className="w-full flex items-center justify-between p-3 rounded-xl border border-gray-100 hover:border-primary hover:bg-orange-50 transition-colors text-left group"
                >
                  <p className="text-sm font-medium text-text-main group-hover:text-primary truncate">{product.name}</p>
                  {product.price != null && (
                    <span className="text-sm font-bold text-text-main shrink-0 ml-2">
                      {product.currency ?? "$"}{product.price.toFixed(2)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        </main>
      )}

      {/* Loading state */}
      {state.view === "loading" && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-10 h-10 border-4 border-gray-200 border-t-primary rounded-full animate-spin mb-4" />
            <p className="text-sm text-text-muted animate-pulse">{phaseText(state.phase)}</p>
          </div>
        </main>
      )}

      {/* Error state */}
      {state.view === "error" && (
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <span className="material-icons text-4xl text-gray-300 mb-3 block">error_outline</span>
            <p className="text-sm text-text-main mb-1">{state.message}</p>
            <button
              onClick={() => setState({ view: "empty" })}
              className="mt-4 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors"
            >
              Try Again
            </button>
          </div>
        </main>
      )}

      {/* Results — full view (no chat) */}
      {state.view === "results" && !chatActive && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 pb-40 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <PriceBar productPrice={state.product.price} response={state.response} />

          <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
            <h3 className="font-semibold text-base mb-3 text-text-main">
              Top results ({displayResults.length})
            </h3>
            {displayResults.length === 0 ? (
              <p className="text-sm text-text-muted">No alternatives with pricing found.</p>
            ) : (
              <div className="space-y-3 divide-y divide-gray-100">
                {displayResults.map((ranked) => (
                  <div key={ranked.result.id} className="pt-3 first:pt-0">
                    <ResultCard ranked={ranked} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {hiddenCount > 0 && (
            <p className="text-xs text-text-muted text-center">
              {hiddenCount} result{hiddenCount > 1 ? "s" : ""} hidden (no price available)
            </p>
          )}

          <p className="text-xs text-text-muted text-center pb-2">
            Found {state.response.searchMeta.totalFound} results in{" "}
            {(state.response.searchMeta.searchDurationMs / 1000).toFixed(1)}s
          </p>
        </main>
      )}

      {/* Results — split view (with chat) */}
      {state.view === "results" && chatActive && (
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Compressed results (top ~40%) */}
          <div className="h-[40%] overflow-y-auto px-4 pt-3 pb-2 space-y-2 border-b border-gray-200 no-scrollbar">
            <ProductSection product={state.product} />
            <PriceBar
              productPrice={state.product.price}
              response={state.response}
              collapsed={priceBarCollapsed}
              onToggle={() => setPriceBarCollapsed(!priceBarCollapsed)}
            />
            <div className="space-y-0.5">
              {displayResults.map((ranked) => (
                <ResultCard key={ranked.result.id} ranked={ranked} compact />
              ))}
            </div>
          </div>

          {/* Chat area (bottom ~60%) */}
          <div className="h-[60%] flex flex-col">
            <ChatThread
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              isLoading={chatLoading}
            />
          </div>
        </main>
      )}

      {/* Input bar for results view (pre-chat) */}
      {state.view === "results" && !chatActive && (
        <div className="sticky bottom-0 left-0 right-0 bg-background border-t border-gray-100">
          {/* Nudge */}
          <div className="px-4 pt-3 pb-1">
            <div className="bg-orange-50 border border-orange-100 rounded-xl p-2.5 flex items-center gap-2.5">
              <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0">
                <span className="material-icons text-xs">smart_toy</span>
              </div>
              <p className="text-xs text-text-main">I can help you compare — hold mic or type below.</p>
            </div>
          </div>

          {/* Input */}
          <div className="px-3 py-2.5">
            <ChatInputBar onSend={handleSendMessage} />
          </div>
        </div>
      )}
    </div>
  );
}

function ChatInputBar({ onSend }: { onSend: (text: string) => void }) {
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleMicClick = () => {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed", bottom: "70px", right: "20px",
      background: "#1a202c", color: "white", padding: "6px 12px",
      borderRadius: "8px", fontSize: "12px", zIndex: "9999",
    } as CSSStyleDeclaration);
    el.textContent = "Voice coming soon";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        placeholder="Ask about these..."
        className="flex-1 bg-white border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-text-main placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
      />
      {input.trim() ? (
        <button
          onClick={handleSubmit}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary-dark transition-colors"
        >
          <span className="material-icons text-lg">send</span>
        </button>
      ) : (
        <button
          onClick={handleMicClick}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 text-text-muted hover:bg-gray-200 transition-colors"
        >
          <span className="material-icons text-lg">mic</span>
        </button>
      )}
    </div>
  );
}
```

**Step 2: Typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/App.tsx
git commit -m "feat(ext): rewrite side panel with phase2 design — styled states, chat, price comparison"
```

---

### Task 5: Update Service Worker + Manifest

**Files:**
- Modify: `packages/extension/src/manifest.json`
- Modify: `packages/extension/src/background/index.ts`

**Step 1: Update manifest**

In `packages/extension/src/manifest.json`, add `host_permissions` after `permissions` and update the action title:

Replace the full file:

```json
{
  "manifest_version": 3,
  "name": "Shopping Source Discovery",
  "version": "0.1.0",
  "description": "Find cheaper alternatives for any product you see online.",
  "permissions": ["sidePanel", "storage", "activeTab"],
  "host_permissions": ["http://localhost:8080/*"],
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/index.ts"],
      "run_at": "document_idle"
    }
  ],
  "side_panel": {
    "default_path": "src/sidepanel/index.html"
  },
  "action": {
    "default_title": "Personal Shopper"
  },
  "icons": {}
}
```

**Step 2: Replace service worker**

Replace `packages/extension/src/background/index.ts` with:

```typescript
import type {
  IdentifyResponse,
  IdentifiedProduct,
  SearchRequest,
  SearchResponse,
  ProductDisplayInfo,
  ChatRequest,
} from "@shopping-assistant/shared";
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES } from "@shopping-assistant/shared";

const BACKEND_URL = "http://localhost:8080";

console.log("[Shopping Assistant] Service worker started");

// State tracking for GET_STATE
let lastSidePanelMessage: Record<string, unknown> | null = null;
let activeTabId: number | null = null;

// Open side panel and trigger screenshot on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  activeTabId = tab.id;

  await chrome.sidePanel.open({ tabId: tab.id });

  try {
    notifySidePanel(tab.id, { type: "identifying" });

    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });

    const identifyRes = await fetch(`${BACKEND_URL}/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        screenshot: screenshotDataUrl,
        pageUrl: tab.url ?? "",
      }),
    });

    if (!identifyRes.ok) {
      notifySidePanel(tab.id, {
        type: "error",
        product: null,
        message: "Failed to identify products on this page.",
      });
      return;
    }

    const identified: IdentifyResponse = await identifyRes.json();

    if (identified.products.length === 0) {
      notifySidePanel(tab.id, {
        type: "error",
        product: null,
        message: "No products found on this page.",
      });
      return;
    }

    if (identified.products.length === 1 || identified.pageType === "product_detail") {
      const product = identified.products[0];
      const displayProduct = identifiedToDisplay(product);
      notifySidePanel(tab.id, { type: "searching", product: displayProduct });
      await searchForProduct(tab.id, displayProduct, screenshotDataUrl, tab.url ?? "");
    } else {
      notifySidePanel(tab.id, {
        type: "product_selection",
        products: identified.products,
        screenshotDataUrl,
        pageUrl: tab.url ?? "",
        tabId: tab.id,
      });
    }
  } catch (err) {
    console.error("[Shopping Assistant] Screenshot flow failed:", err);
    if (tab.id) {
      notifySidePanel(tab.id, {
        type: "error",
        product: null,
        message: "Something went wrong. Please try again.",
      });
    }
  }
});

// Listen for messages from side panel and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    sendResponse(lastSidePanelMessage);
    return false;
  }

  if (message.type === "select_product") {
    const { product, screenshotDataUrl, pageUrl } = message;
    const effectiveTabId = message.tabId ?? sender.tab?.id;
    if (!effectiveTabId) return false;
    activeTabId = effectiveTabId;
    const displayProduct = identifiedToDisplay(product);
    notifySidePanel(effectiveTabId, { type: "searching", product: displayProduct });
    searchForProduct(effectiveTabId, displayProduct, screenshotDataUrl, pageUrl).then(() =>
      sendResponse({ status: "ok" }),
    );
    return true;
  }

  if (message.type === "IMAGE_CLICKED") {
    const tabId = sender.tab?.id;
    if (!tabId) return false;
    activeTabId = tabId;

    const { imageUrl, titleHint, pageUrl } = message;

    (async () => {
      await chrome.sidePanel.open({ tabId });

      const product: ProductDisplayInfo = {
        name: titleHint || "Product",
        price: null,
        currency: null,
        imageUrl,
      };

      notifySidePanel(tabId, { type: "searching", product });
      await searchForProduct(tabId, product, "", pageUrl, imageUrl);
      sendResponse({ status: "ok" });
    })();

    return true;
  }

  if (message.type === "CHAT_REQUEST") {
    const { request } = message as { request: ChatRequest };
    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!res.ok) throw new Error("Chat request failed");
        const data = await res.json();
        if (activeTabId) {
          notifySidePanel(activeTabId, { type: "chat_response", reply: data.reply });
        }
      } catch {
        if (activeTabId) {
          notifySidePanel(activeTabId, { type: "chat_error", error: "Chat failed" });
        }
      }
      sendResponse({ status: "ok" });
    })();
    return true;
  }

  return false;
});

function identifiedToDisplay(product: IdentifiedProduct): ProductDisplayInfo {
  return {
    name: product.name,
    price: product.price,
    currency: product.currency,
    imageUrl: product.imageRegion
      ? `data:image/png;base64,${product.imageRegion}`
      : undefined,
  };
}

async function searchForProduct(
  tabId: number,
  product: ProductDisplayInfo,
  screenshotDataUrl: string,
  pageUrl: string,
  imageUrl?: string,
): Promise<void> {
  const cacheKey = `search:${product.name}:${pageUrl}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    const enriched = enrichProduct(product, cached);
    notifySidePanel(tabId, { type: "results", product: enriched, response: cached });
    return;
  }

  try {
    const searchReq: SearchRequest = {
      imageUrl: imageUrl ?? product.imageUrl ?? null,
      imageBase64: !imageUrl && screenshotDataUrl
        ? (screenshotDataUrl.includes(",")
          ? screenshotDataUrl.split(",")[1]
          : screenshotDataUrl)
        : null,
      title: product.name !== "Product" ? product.name : null,
      price: product.price,
      currency: product.currency,
      sourceUrl: pageUrl,
    };

    const searchRes = await fetch(`${BACKEND_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchReq),
    });

    if (!searchRes.ok) {
      notifySidePanel(tabId, {
        type: "error",
        product,
        message: "Search failed. Please try again.",
      });
      return;
    }

    const response: SearchResponse = await searchRes.json();
    await setCache(cacheKey, response);
    const enriched = enrichProduct(product, response);
    notifySidePanel(tabId, { type: "results", product: enriched, response });
  } catch (err) {
    console.error("[Shopping Assistant] Search failed:", err);
    notifySidePanel(tabId, {
      type: "error",
      product,
      message: "Search failed. Please try again.",
    });
  }
}

function enrichProduct(product: ProductDisplayInfo, response: SearchResponse): ProductDisplayInfo {
  return {
    ...product,
    name: response.originalProduct.title ?? product.name,
    imageUrl: product.imageUrl || response.originalProduct.imageUrl || undefined,
  };
}

function notifySidePanel(tabId: number, message: Record<string, unknown>): void {
  const full = { target: "sidepanel", tabId, ...message };
  lastSidePanelMessage = full;
  chrome.runtime.sendMessage(full).catch(() => {
    // Side panel may not be ready yet
  });
}

async function getCached(key: string): Promise<SearchResponse | null> {
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return null;
  const entry = data[key] as { response: SearchResponse; cachedAt: number };
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.response;
}

async function setCache(key: string, response: SearchResponse): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const searchKeys = Object.keys(all).filter((k) => k.startsWith("search:"));
  if (searchKeys.length >= CACHE_MAX_ENTRIES) {
    const oldest = searchKeys
      .map((k) => ({ key: k, cachedAt: (all[k] as { cachedAt: number }).cachedAt }))
      .sort((a, b) => a.cachedAt - b.cachedAt);
    const toRemove = oldest.slice(0, searchKeys.length - CACHE_MAX_ENTRIES + 1).map((e) => e.key);
    await chrome.storage.local.remove(toRemove);
  }
  await chrome.storage.local.set({ [key]: { response, cachedAt: Date.now() } });
}
```

**Step 3: Typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add packages/extension/src/manifest.json packages/extension/src/background/index.ts
git commit -m "feat(ext): update service worker with state tracking, chat support, and enriched messages"
```

---

### Task 6: Build and Verify

**Step 1: Full build**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm build`
Expected: All packages build successfully.

**Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS across all packages.

**Step 3: Run backend tests**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All tests PASS (backend changes were minimal — only chat route type update).

**Step 4: Verify extension build output**

Run: `ls packages/extension/dist/ 2>/dev/null && echo "Extension built successfully" || echo "Check build output"`
Expected: Extension dist directory exists with built assets.

**Step 5: Commit if any fixes were needed**

```bash
git add -A && git commit -m "fix: resolve issues found during build verification"
```
