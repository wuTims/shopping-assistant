# Live Agent Tool Use & Persona Enhancement — Design Spec

**Date:** 2026-03-16
**Status:** Approved
**Goal:** Transform the live voice agent from a static Q&A assistant into an agentic shopping concierge that can run searches mid-conversation, present results inline, and deliver a seamless, persona-driven voice experience.

**Motivation:** The current live agent satisfies basic voice interaction but scores poorly on competition judging criteria for: tool use / agentic behavior (agent cannot fetch new data), distinct persona (default voice, generic instructions), and fluidity (no proactive behavior, dead air during processing). This design addresses all three gaps.

---

## Architecture Overview

```
User speaks → AudioWorklet (16kHz PCM) → WebSocket → Backend /live
                                                        ↓
                                              Gemini Live API session
                                              (with tool declarations)
                                                        ↓
                                              Model requests search_products
                                                        ↓
                                              Backend executes voice search
                                              (Brave + AliExpress + ranking)
                                                        ↓
                                              sendToolResponse → model speaks about results
                                              tool_result → client renders inline cards
```

Two parallel workstreams:
1. **Backend tool use** — Gemini Live function calling + voice-optimized search pipeline
2. **Frontend persona + UX** — Voice config, system instruction persona, tool activity UI

---

## 1. Tool Declarations

Two tools declared in the `ai.live.connect()` config via `tools: [{ functionDeclarations: [...] }]`:

### `search_products`

**Purpose:** Search for product alternatives across marketplaces when the user asks about options not in the current results.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Search query derived from conversation (e.g. "wireless earbuds under $50") |
| `marketplace_filter` | string | no | Restrict to a specific marketplace (e.g. "amazon", "ebay", "aliexpress") |

**Execution:** Calls `executeVoiceSearch()` (see Section 2).

**Return to model:** Top 5 results formatted as text:
```
Found 5 results:
#1 "Product Title" on Amazon — USD 45.99 (23% savings)
#2 "Product Title" on eBay — USD 42.50 (28% savings)
...
```

**Side effect:** Sends `tool_result` WebSocket message to client with full `RankedResult[]` for UI rendering.

### `compare_prices`

**Purpose:** Compare prices across all known results (initial search + any voice-discovered results).

**Parameters:** None.

**Execution:** Pure computation. Reads from `[...initialResults, ...accumulatedResults]` — both the initial search results (parsed from config context at session start) and any results accumulated from voice `search_products` calls. Sorts by price, calculates savings vs. original product price.

**Return to model:** Price comparison summary as text.

---

## 2. Voice-Optimized Search Function

**New file:** `packages/backend/src/services/voice-search.ts`

**Exported function:**
```typescript
export async function executeVoiceSearch(
  query: string,
  options?: {
    marketplaceFilter?: string;
    originalPrice?: number;
    originalCurrency?: string;
    sourceUrl?: string;        // Filter out the product the user is viewing
    sourceMarketplace?: string;
    signal?: AbortSignal;
  }
): Promise<RankedResult[]>
```

**Synthetic `ProductIdentification`:** The voice path has no image, so it skips `identifyProduct()`. However, `heuristicPreSort()` and `buildFallbackScores()` both require a `ProductIdentification` parameter. We construct a minimal synthetic one from the query string:

```typescript
const identification: ProductIdentification = {
  category: query,
  description: query,
  brand: null,
  attributes: { color: null, material: null, style: null, size: null },
  searchQueries: [query],
  estimatedPriceRange: null,
};
```

This produces reasonable token overlap in the heuristic scoring functions.

**Pipeline (~4-5s):**
1. Build synthetic `ProductIdentification` from query
2. Generate marketplace queries via `generateMarketplaceQueries(query)` (or filter to single marketplace if `marketplaceFilter` provided)
3. Parallel search — unwrap provider outcomes:
   - `searchProducts([query, ...marketplaceQueries])` → access `.results` from `ProviderSearchOutcome`
   - `searchAliExpressSplit([query], null)` → access `.textOutcome.results` from `SplitProviderSearchOutcome` (image outcome ignored — no image available)
4. `mergeAndDedup()` all `SearchResult[]` arrays → `annotateResultValidation()` → `isDisplayableCandidate()` filter
5. Filter out source product URL (passed via options) to avoid returning the item the user is already viewing
6. `heuristicPreSort(filtered, identification, originalPrice, sourceMarketplace)` → `diversityCap()` → cap to 15 candidates
7. `quickHttpPriceEnrich(capped, 10)` — `maxPriceResults=10` limits priceless extraction; liveness checks still run on all candidates
8. `buildFallbackScores(capped, identification, sourceMarketplace, originalPrice)` → `applyRanking()`
9. Return top 5 ranked results

**What's skipped vs. full `/search` pipeline:**
- No `identifyProduct()` — we have text, not an image
- No `generateImageSearchQueries()` / Brave image search / AliExpress image search
- No `computeVisualSimilarityScores()` — no source image to compare against
- `diversityCap` applied but with smaller candidate pool (15 vs `MAX_RESULTS_FOR_RANKING`)
- `quickHttpPriceEnrich` with `maxPriceResults=10` for latency (note: liveness checks still run on all candidates, so total HTTP requests may exceed 10)

**Abort support:** Accepts `AbortSignal` so in-flight searches can be cancelled on barge-in. Note: `searchProducts` and `searchAliExpressSplit` use their own internal timeout signals. The external `AbortSignal` cancels at the `executeVoiceSearch` boundary — in-flight HTTP requests from provider functions will complete but their results are discarded.

**Concurrency cap:** At most 1 voice search may be in-flight at a time. If the model calls `search_products` while a previous search is still running, the previous search is aborted before starting the new one.

**Reused modules:** `searchProducts` (brave.ts), `searchAliExpressSplit` (aliexpress.ts), `mergeAndDedup` / `heuristicPreSort` / `diversityCap` / `buildFallbackScores` / `applyRanking` (ranking.ts), `annotateResultValidation` / `isDisplayableCandidate` (result-validation.ts), `quickHttpPriceEnrich` (price-fallback.ts), `generateMarketplaceQueries` (marketplace-queries.ts).

---

## 3. Persona & Voice Configuration

### System Instruction

Replace the current generic `buildSystemInstruction()` with:

```
You are a knowledgeable shopping concierge helping a customer compare products and find the best deals. You are calm, professional, and focused on helping them make the best purchasing decision.

Behavior:
- Be concise. Keep responses to 2-3 sentences unless the user asks for detail.
- When using search_products, tell the customer what you're doing: "Let me check a few marketplaces for that..." — never go silent.
- When presenting search results, lead with the best value and explain why.
- If prices are missing for some results, acknowledge that honestly.
- When comparing products, highlight meaningful differences (price, marketplace trustworthiness, shipping) not specs the user can read themselves.
- If the user interrupts, gracefully pivot to their new question without repeating yourself.
- Greet the customer briefly when the conversation starts: mention the product they're looking at and the price range found, then ask how you can help.
```

### Voice Selection

Add to `ai.live.connect()` config:
```typescript
speechConfig: {
  voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }
}
```

`Kore` — calm, clear, professional voice. Alternative: `Aoede` for a warmer tone.

### Proactive Greeting

The system instruction includes greeting guidance. Combined with the product context sent as the initial user turn, the model's first audio response will naturally greet the user and summarize what it knows about their product.

---

## 4. WebSocket Protocol Changes

### New `WsServerMessage` variants

Added to `packages/shared/src/types.ts`:

```typescript
export type WsServerMessage =
  // ... existing types ...
  | { type: "tool_start"; toolName: string; toolCallId: string }
  | { type: "tool_result"; toolName: string; toolCallId: string; results: RankedResult[] }
  | { type: "tool_cancelled"; toolCallId: string };
```

**No new client → server messages.** The model decides when to call tools autonomously.

### Message flow during tool execution

```
[Model decides to search]
  Server → Client:  { type: "tool_start", toolName: "search_products", toolCallId: "abc123" }
  Server → Client:  { type: "audio", ... }  (model narrates: "Let me check...")

[Search completes]
  Server → Client:  { type: "tool_result", toolName: "search_products", toolCallId: "abc123", results: [...] }
  Server → Gemini:  session.sendToolResponse({ functionResponses: [{ id: toolCallId, name: "search_products", response: { results: "..." } }] })
  Server → Client:  { type: "audio", ... }  (model discusses results)

[If user interrupts mid-search]
  Gemini → Server:  toolCallCancellation { ids: ["abc123"] }
  Server → Client:  { type: "tool_cancelled", toolCallId: "abc123" }
  Server:           abortController.abort() — cancel in-flight HTTP requests
```

---

## 5. Backend `live.ts` Changes

### New imports

```typescript
import { Type } from "@google/genai";
import type { FunctionDeclaration, FunctionCall } from "@google/genai";
import type { RankedResult } from "@shopping-assistant/shared";
import { executeVoiceSearch } from "../services/voice-search.js";
```

### Tool declarations

Defined as constants in `live.ts`:

```typescript
const searchProductsDeclaration: FunctionDeclaration = {
  name: "search_products",
  description: "Search for product alternatives across online marketplaces. Use when the user asks about options not in the current results, wants to search a specific store, or asks for different alternatives.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Search query for finding products" },
      marketplace_filter: { type: Type.STRING, description: "Optional: restrict to a specific marketplace (amazon, ebay, walmart, aliexpress, etc.)" },
    },
    required: ["query"],
  },
};

const comparePricesDeclaration: FunctionDeclaration = {
  name: "compare_prices",
  description: "Compare prices across all known results from the initial search and any subsequent searches. Use when the user asks which option is cheapest, wants a price comparison, or asks about savings.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};
```

### State tracking

New state within `liveWebSocket()` closure:

```typescript
const pendingToolCalls = new Map<string, AbortController>();
let accumulatedResults: RankedResult[] = [];     // Results from voice search tool calls
let initialResults: RankedResult[] = [];          // Parsed from config message context
let initialContext: Record<string, unknown> = {}; // Raw config context for product info
```

**Parsing initial results:** When the `config` message arrives, extract `context.results` (the top 5 results sent from the frontend as `{ rank, title, price, currency, marketplace, confidence }`). Convert these into lightweight `RankedResult` objects and store in `initialResults`. The `compare_prices` tool reads from `[...initialResults, ...accumulatedResults]` to have the full picture.

### `toolCall` handling in `onmessage` callback

When `message.toolCall?.functionCalls` is present:
1. For each `FunctionCall` in the array, send `tool_start` to client (using `functionCall.id` as `toolCallId`)
2. Execute the function (search or compare)
3. If not cancelled: send `tool_result` to client, then `session.sendToolResponse({ functionResponses: [{ id: functionCall.id, name: functionCall.name, response: { ... } }] })` — the `id` field is **required** to correlate the response with the pending tool call
4. Append new results to `accumulatedResults`

### `toolCallCancellation` handling

When `message.toolCallCancellation?.ids` is present:
1. For each ID, call `pendingToolCalls.get(id)?.abort()`
2. Send `tool_cancelled` to client
3. Clean up from `pendingToolCalls` map

---

## 6. Frontend Changes

### `useVoice.ts` hook

**New state:**
```typescript
toolActivity: { active: boolean; toolName: string | null }
```

**New callback prop:**
```typescript
onToolResult?: (results: RankedResult[]) => void
```

**New message handlers in `ws.onmessage`:**
- `tool_start` → set `toolActivity = { active: true, toolName }`
- `tool_result` → set `toolActivity = { active: false, toolName: null }`, call `onToolResult(results)`
- `tool_cancelled` → set `toolActivity = { active: false, toolName: null }`

### `ChatThread.tsx` component

**Tool activity indicator:** When `toolActivity.active` is true, render a compact inline card between messages:
- Search icon + "Searching across marketplaces..." with subtle pulse animation
- Styled consistently with the existing chat bubble aesthetic (rounded, semi-transparent)

**Inline result cards:** When tool results arrive, render compact `ResultCard`-style elements in the chat flow:
- Thumbnail image, title (truncated), price, marketplace badge, savings percentage
- Horizontally scrollable row if multiple results
- Tapping a card opens the product URL

### `SidepanelStateContext.tsx` state

**New state:**
```typescript
const [voiceSearchResults, setVoiceSearchResults] = useState<RankedResult[]>([]);
```

**`onToolResult` callback:** Merges new results into `voiceSearchResults`, deduplicating by product URL.

**Chat focus options:** `chatFocusOptions` memo updated to include products from `voiceSearchResults` in addition to the original search results.

**Cleanup:** `voiceSearchResults` cleared when voice session ends or when navigating away from results view.

---

## 7. File Map

| Action | File | Responsibility |
|--------|------|---------------|
| **New** | `packages/backend/src/services/voice-search.ts` | `executeVoiceSearch()` — text-based search reusing existing modules |
| **Modify** | `packages/backend/src/ws/live.ts` | Tool declarations, toolCall/cancellation handling, persona, voice config |
| **Modify** | `packages/shared/src/types.ts` | Add `tool_start`, `tool_result`, `tool_cancelled` to `WsServerMessage` |
| **Modify** | `packages/extension/src/sidepanel/hooks/useVoice.ts` | Handle tool messages, expose `toolActivity` + `onToolResult` |
| **Modify** | `packages/extension/src/sidepanel/components/ChatThread.tsx` | Tool activity indicator + inline result cards |
| **Modify** | `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx` | Accumulate voice results, update chat focus options |

**Not changed:** `/search` endpoint, `/chat` endpoint, content script, service worker, manifest, audio worklet.

---

## 8. Risk & Edge Cases

| Risk | Mitigation |
|------|-----------|
| Search takes >5s, feels like dead air | Model narrates during execution per system instruction; `tool_start` triggers visual indicator |
| User interrupts mid-search | `toolCallCancellation` → `AbortController.abort()` → `tool_cancelled` to client |
| Search returns 0 results | Tool response says "no results found"; model handles gracefully per system instruction |
| Multiple tool calls in quick succession | Each tracked independently via `toolCallId` in the `pendingToolCalls` map |
| Session timeout during search | Existing 15-min timeout still applies; search is short enough (~5s) to not be a factor |
| `compare_prices` called with no results | Returns summary of initial results only; if none, model says it has nothing to compare |
| Voice search returns user's own product | Source URL filtering applied (same logic as `/search` route) |
| Rapid successive search requests | Concurrency cap: max 1 in-flight voice search; previous aborted before starting new |
