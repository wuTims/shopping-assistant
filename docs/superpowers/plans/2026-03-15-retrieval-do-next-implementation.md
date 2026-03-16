# Retrieval Do Next Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve retrieval quality and observability by splitting AliExpress lane attribution, running Gemini image-first queries through Brave web search, preserving full contributing query provenance, adding degraded-path tests, and giving hybrid matches a small ranking boost.

**Architecture:** Keep the current `/search` orchestration and provider contracts mostly intact, but refine the provider outputs and route tagging so retrieval provenance is accurate before dedupe and ranking. Use `SearchResult` metadata to carry lane and matched-query provenance through merge, then apply a small hybrid-evidence boost in the existing text scoring and pre-sort paths.

**Tech Stack:** TypeScript, Hono, Vitest, shared package types, backend provider services

---

## File Map

- Modify: `packages/shared/src/types.ts`
  - Extend `SearchResult` with compact full-query provenance.
- Modify: `packages/backend/src/services/aliexpress.ts`
  - Split text and image outcomes while preserving a route-friendly combined entry point.
- Modify: `packages/backend/src/services/provider-outcome.ts`
  - Add lane-aware/provider-aware helpers or types if needed to avoid route-local ad hoc shapes.
- Modify: `packages/backend/src/routes/search.ts`
  - Run Brave web for Gemini image queries, tag all result streams, attach query provenance, compute better diagnostics, and merge outcomes.
- Modify: `packages/backend/src/services/ranking.ts`
  - Merge full matched-query provenance on dedupe and add the small hybrid ranking boost.
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`
  - Cover provenance merging and hybrid boost behavior.
- Modify: `packages/backend/src/routes/__tests__/search.test.ts`
  - Cover route orchestration, degraded-path behavior, and provenance payloads.
- Optional Modify: `packages/backend/src/services/__tests__/aliexpress.test.ts`
  - Add focused tests if `aliexpress.ts` gains new exported helpers worth pinning down directly.

## Chunk 1: Shared Provenance Model

### Task 1: Add matched-query provenance to shared types

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Write the failing type-aware test expectations in route/ranking tests**

Add assertions that final results include a `matchedQueries` array shaped like:

```ts
[
  { query: "blue striped midi dress", lane: "text", provider: "brave" },
  { query: "blue striped midi dress dupe", lane: "image", provider: "aliexpress" },
]
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```powershell
pnpm --filter backend exec vitest run packages/backend/src/services/__tests__/ranking.test.ts packages/backend/src/routes/__tests__/search.test.ts
```

Expected: FAIL because `matchedQueries` is not defined on `SearchResult` yet.

- [ ] **Step 3: Extend the shared type minimally**

Add a new interface and property:

```ts
export interface MatchedQuery {
  query: string;
  lane: "text" | "image";
  provider: "brave" | "aliexpress";
}

export interface SearchResult {
  // existing fields...
  retrievalLane?: "text" | "image" | "hybrid";
  matchedQueries?: MatchedQuery[];
}
```

- [ ] **Step 4: Rebuild shared types**

Run:

```powershell
& 'C:\Users\dand5\AppData\Roaming\npm\pnpm.cmd' build:shared
```

Expected: PASS and regenerated `packages/shared/dist` output.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/dist
git commit -m "feat: add query provenance to search results"
```

## Chunk 2: Provider and Route Orchestration

### Task 2: Split AliExpress into text and image outcomes

**Files:**
- Modify: `packages/backend/src/services/aliexpress.ts`
- Modify: `packages/backend/src/services/provider-outcome.ts`
- Optional Test: `packages/backend/src/services/__tests__/aliexpress.test.ts`

- [ ] **Step 1: Write the failing service or route test**

Add a test that mocks AliExpress text results and image results separately and expects the final merged route payload to preserve:
- text-only AliExpress results as `retrievalLane: "text"`
- image-only AliExpress results as `retrievalLane: "image"`
- duplicate AliExpress text+image matches as `retrievalLane: "hybrid"`

- [ ] **Step 2: Run the targeted route test to verify it fails**

Run:

```powershell
pnpm --filter backend exec vitest run packages/backend/src/routes/__tests__/search.test.ts
```

Expected: FAIL because `searchAliExpress()` currently collapses everything into one outcome.

- [ ] **Step 3: Add split outcome support in AliExpress service**

Refactor toward:

```ts
interface SplitProviderSearchOutcome {
  textOutcome: ProviderSearchOutcome;
  imageOutcome: ProviderSearchOutcome;
  combinedOutcome: ProviderSearchOutcome;
}

export async function searchAliExpressSplit(
  queries: string[],
  image: FetchedImage | null,
): Promise<SplitProviderSearchOutcome> { /* ... */ }
```

Keep `searchAliExpress()` as a thin wrapper if other callers still expect the old combined contract.

- [ ] **Step 4: Update `/search` to consume split AliExpress outcomes**

In `packages/backend/src/routes/search.ts`:
- tag text results as `text`
- tag image results as `image`
- combine them into the existing candidate pool
- preserve the combined provider status/diagnostics for overall accounting

- [ ] **Step 5: Run the route test to verify it passes**

Run:

```powershell
pnpm --filter backend exec vitest run packages/backend/src/routes/__tests__/search.test.ts
```

Expected: PASS for AliExpress lane attribution assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/services/aliexpress.ts packages/backend/src/services/provider-outcome.ts packages/backend/src/routes/search.ts packages/backend/src/routes/__tests__/search.test.ts
git commit -m "feat: split aliexpress retrieval lanes"
```

### Task 3: Run Gemini image queries through Brave web search

**Files:**
- Modify: `packages/backend/src/routes/search.ts`
- Modify: `packages/backend/src/routes/__tests__/search.test.ts`

- [ ] **Step 1: Write the failing route test**

Add a test where:
- title/AI Brave returns nothing
- Brave web for Gemini image queries returns one result
- Brave image returns one result

Assert:
- both streams are used
- both results are tagged `image`
- a duplicate between them becomes `hybrid` after dedupe only if another lane also found it

- [ ] **Step 2: Run the route test to verify it fails**

Run:

```powershell
pnpm --filter backend exec vitest run packages/backend/src/routes/__tests__/search.test.ts
```

Expected: FAIL because image-generated queries are only sent to `searchImages()` today.

- [ ] **Step 3: Add the second Brave web pass**

In `packages/backend/src/routes/search.ts`:
- call `searchProducts(imageSearchQueries)` in Phase 2
- tag those results as `image`
- merge provider stats into the overall Brave diagnostics without losing existing title/AI/marketplace accounting

- [ ] **Step 4: Run the route test to verify it passes**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routes/search.ts packages/backend/src/routes/__tests__/search.test.ts
git commit -m "feat: search brave web with image-first queries"
```

## Chunk 3: Provenance Merge and Ranking

### Task 4: Attach and merge full contributing query provenance

**Files:**
- Modify: `packages/backend/src/routes/search.ts`
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`
- Modify: `packages/backend/src/routes/__tests__/search.test.ts`

- [ ] **Step 1: Write the failing ranking and route tests**

Add tests asserting that:
- a result found by one query has exactly one `matchedQueries` entry
- a deduped result found by multiple lanes/providers keeps the union of contributing queries
- duplicate entries are normalized away when the same query/provider/lane combination appears twice

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```powershell
pnpm --filter backend exec vitest run packages/backend/src/services/__tests__/ranking.test.ts packages/backend/src/routes/__tests__/search.test.ts
```

Expected: FAIL because route tagging and dedupe do not yet carry query arrays.

- [ ] **Step 3: Add query-aware result tagging in the route**

Create a helper in `search.ts` along these lines:

```ts
function tagOutcomeResults(
  outcome: ProviderSearchOutcome,
  lane: "text" | "image" | "hybrid",
  provider: "brave" | "aliexpress",
  query: string | null,
): ProviderSearchOutcome
```

If one provider call aggregates many query results, either:
- tag per-query before flattening, or
- add a helper that maps each query’s result batch independently before combining them.

Goal: every result enters dedupe with the exact query that produced it.

- [ ] **Step 4: Merge matched queries in `mergeAndDedup()`**

Add helpers in `ranking.ts`:

```ts
function mergeMatchedQueries(primary: SearchResult, duplicate: SearchResult): MatchedQuery[] | undefined
function normalizeMatchedQueryKey(entry: MatchedQuery): string
```

When duplicates merge:
- preserve the richer result as today
- union and dedupe `matchedQueries`
- promote `retrievalLane` to `hybrid` when lanes differ

- [ ] **Step 5: Run the tests to verify they pass**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routes/search.ts packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts packages/backend/src/routes/__tests__/search.test.ts
git commit -m "feat: preserve contributing query provenance"
```

### Task 5: Add a small hybrid-evidence ranking boost

**Files:**
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Write the failing ranking tests**

Add tests showing:
- two otherwise similar results rank with `hybrid` above `text`
- the boost is small and does not overpower a clearly better semantic match

- [ ] **Step 2: Run the ranking test to verify it fails**

Run:

```powershell
pnpm --filter backend exec vitest run packages/backend/src/services/__tests__/ranking.test.ts
```

Expected: FAIL because retrieval lane does not affect scores today.

- [ ] **Step 3: Implement the minimal boost**

In `ranking.ts`, add a constant such as:

```ts
const HYBRID_LANE_BOOST = 0.05;
```

Apply it in:
- `buildFallbackScores()`
- `heuristicPreSort()`

Only for `result.retrievalLane === "hybrid"`.

- [ ] **Step 4: Run the ranking test to verify it passes**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat: boost hybrid retrieval matches in ranking"
```

## Chunk 4: Degraded-Path Coverage and Final Verification

### Task 6: Add degraded-path route tests

**Files:**
- Modify: `packages/backend/src/routes/__tests__/search.test.ts`

- [ ] **Step 1: Write failing degraded-path tests**

Add tests for:
- Gemini image-query generation rejects, request still returns 200
- Brave image search rejects, Brave image-query web search still contributes
- Brave image-query web search rejects, Brave image search still contributes
- AliExpress text rejects while image succeeds
- AliExpress image rejects while text succeeds

Each test should assert:
- response status remains 200
- `laneDiagnostics` reflects surviving results
- `matchedQueries` only include successful contributing queries

- [ ] **Step 2: Run the route tests to verify they fail**

Run:

```powershell
pnpm --filter backend exec vitest run packages/backend/src/routes/__tests__/search.test.ts
```

Expected: FAIL where degraded-path behavior or provenance accounting is incomplete.

- [ ] **Step 3: Implement the minimal fail-open fixes**

In `packages/backend/src/routes/search.ts`:
- ensure image-query generation failure leaves `imageSearchQueries` empty and continues
- ensure each provider outcome is independently tagged and merged only when fulfilled
- ensure failed query streams do not inject bogus `matchedQueries`

- [ ] **Step 4: Run the route tests to verify they pass**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routes/search.ts packages/backend/src/routes/__tests__/search.test.ts
git commit -m "test: cover degraded retrieval lane behavior"
```

### Task 7: Final verification

**Files:**
- Verify only

- [ ] **Step 1: Run all targeted backend tests**

Run:

```powershell
pnpm --filter backend exec vitest run packages/backend/src/services/__tests__/ranking.test.ts packages/backend/src/routes/__tests__/search.test.ts packages/backend/src/services/__tests__/gemini.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run backend typecheck**

Run:

```powershell
pnpm --filter backend exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Rebuild shared package**

Run:

```powershell
& 'C:\Users\dand5\AppData\Roaming\npm\pnpm.cmd' build:shared
```

Expected: PASS.

- [ ] **Step 4: Manual verification checklist**

Verify in a real `IMAGE_CLICKED` flow:
- `/search` response includes `retrievalLane`
- `/search` response includes `matchedQueries`
- AliExpress text-only hits are no longer blindly `hybrid`
- Brave image-derived web hits appear in results
- duplicate results found by multiple lanes show merged provenance

- [ ] **Step 5: Final commit**

```bash
git add packages/shared/src/types.ts packages/shared/dist packages/backend/src/services/aliexpress.ts packages/backend/src/services/provider-outcome.ts packages/backend/src/routes/search.ts packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts packages/backend/src/routes/__tests__/search.test.ts packages/backend/src/services/__tests__/aliexpress.test.ts
git commit -m "feat: improve retrieval lane provenance and image-first recall"
```
