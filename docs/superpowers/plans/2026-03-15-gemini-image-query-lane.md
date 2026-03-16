# Gemini Image Query Lane Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a true Gemini-generated image-first query lane to the existing search pipeline, preserve Brave image search and AliExpress image search, and expose lane provenance in the API for tuning and debugging.

**Architecture:** Reuse the current `/search` pipeline and embedding-based grading. Add a new Gemini function that generates image-first shopping queries from the canonical source image, run those queries through Brave web and Brave image search as a distinct retrieval lane, mark merged results as `text`, `image`, or `hybrid`, and return lane diagnostics in `searchMeta`.

**Tech Stack:** TypeScript, Hono, Gemini SDK, Brave Search API, AliExpress API, Vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/backend/src/services/gemini.ts` | Add image-first Gemini query generation |
| Modify | `packages/backend/src/routes/search.ts` | Orchestrate image-query lane and lane diagnostics |
| Modify | `packages/backend/src/services/ranking.ts` | Preserve lane provenance through dedupe/merge |
| Modify | `packages/backend/src/services/brave.ts` | Accept lane tagging for Brave result construction if needed |
| Modify | `packages/backend/src/services/aliexpress.ts` | Tag AliExpress text/image results with retrieval lane if needed |
| Modify | `packages/shared/src/types.ts` | Add per-result lane provenance and `searchMeta` lane diagnostics |
| Modify | `packages/backend/src/services/__tests__/brave.test.ts` | Keep Brave behavior stable if helper signatures change |
| Modify | `packages/backend/src/services/__tests__/ranking.test.ts` | Add merge/provenance tests |
| Create or Modify | `packages/backend/src/routes/__tests__/search.test.ts` | Add route-level orchestration tests if route test harness exists; otherwise create focused route tests |

---

## Chunk 1: Shared Contracts and Gemini Query Generation

### Task 1: Extend shared response types for retrieval-lane diagnostics

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Write the failing type-first test or usage target**

Add the new fields directly in the shared types and use them from a backend test in the next task. The new shape should support:

```ts
retrievalLane: "text" | "image" | "hybrid"
```

and search metadata like:

```ts
laneDiagnostics: {
  textResultCount: number;
  imageResultCount: number;
  hybridResultCount: number;
}
```

- [ ] **Step 2: Modify `packages/shared/src/types.ts`**

Update `SearchResult` and `SearchResponse["searchMeta"]` with the new lane fields while preserving the existing provider diagnostics.

- [ ] **Step 3: Run shared typecheck**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\tsc.cmd' --noEmit -p 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\tsconfig.json'`

Expected: FAIL at backend call sites that do not yet populate the new fields.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add retrieval lane diagnostics to shared search types"
```

### Task 2: Add Gemini image-first query generation

**Files:**
- Modify: `packages/backend/src/services/gemini.ts`
- Test: `packages/backend/src/services/__tests__/gemini.test.ts` if present, otherwise create it

- [ ] **Step 1: Write the failing test for image-query generation**

Add a focused unit test for a helper or parser that validates the Gemini output shape:

```ts
expect(result).toEqual({
  queries: expect.arrayContaining([
    expect.any(String),
  ]),
});
expect(result.queries.length).toBeGreaterThanOrEqual(3);
expect(result.queries.length).toBeLessThanOrEqual(5);
```

If direct SDK mocking is awkward, factor the schema parsing/normalization into a pure helper and test that helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/services/__tests__/gemini.test.ts`

Expected: FAIL because the new generator/helper does not exist yet.

- [ ] **Step 3: Implement the minimal Gemini query-generation path**

Add a new exported function in `packages/backend/src/services/gemini.ts`, for example:

```ts
export async function generateImageSearchQueries(
  imageSource: string | FetchedImage,
  titleHint: string | null,
): Promise<string[]>
```

Requirements:
- source image is primary input
- optional title hint is secondary
- output is 3-5 concise shopping queries
- queries should be broad enough for near matches
- keep JSON-schema validation for output

- [ ] **Step 4: Run the test to verify it passes**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/services/__tests__/gemini.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/gemini.ts packages/backend/src/services/__tests__/gemini.test.ts
git commit -m "feat: add Gemini image-first shopping query generation"
```

---

## Chunk 2: Merge Semantics and Provenance

### Task 3: Preserve lane provenance through merge and dedupe

**Files:**
- Modify: `packages/backend/src/services/ranking.ts`
- Test: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Write failing tests for provenance merge behavior**

Add tests that verify:

```ts
it("preserves text-only provenance", () => { ... })
it("preserves image-only provenance", () => { ... })
it("promotes duplicates across lanes to hybrid", () => { ... })
```

Use two results with the same normalized URL but different `retrievalLane` values and assert the merged result becomes `hybrid`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/services/__tests__/ranking.test.ts`

Expected: FAIL because `mergeAndDedup` does not yet merge lane metadata.

- [ ] **Step 3: Implement provenance-aware dedupe**

Update `mergeAndDedup` in `packages/backend/src/services/ranking.ts` so that when two duplicate results from different lanes collapse into one, the winner keeps `retrievalLane: "hybrid"`.

Keep the existing richness-based selection logic. Only add the lane merge behavior.

- [ ] **Step 4: Run the ranking test to verify it passes**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/services/__tests__/ranking.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat: preserve retrieval lane provenance during dedupe"
```

### Task 4: Thread lane tagging through provider result creation

**Files:**
- Modify: `packages/backend/src/services/brave.ts`
- Modify: `packages/backend/src/services/aliexpress.ts`
- Test: `packages/backend/src/services/__tests__/brave.test.ts`
- Test: `packages/backend/src/services/__tests__/aliexpress.test.ts`

- [ ] **Step 1: Write failing provider normalization tests**

Add or extend tests so provider normalization functions can emit tagged results, for example:

```ts
expect(results[0].retrievalLane).toBe("image");
```

Only do this where signatures change. If tagging is injected after provider normalization in the route, keep provider tests unchanged.

- [ ] **Step 2: Run the affected tests to verify failure**

Run:

```bash
& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/services/__tests__/brave.test.ts packages/backend/src/services/__tests__/aliexpress.test.ts
```

Expected: FAIL only if helper signatures changed.

- [ ] **Step 3: Implement minimal tagging strategy**

Prefer the smallest surface area:
- either add an optional `retrievalLane` argument to provider search functions
- or tag the returned result arrays in `search.ts` immediately after each provider call

Choose the simpler approach that avoids unnecessary signature churn.

- [ ] **Step 4: Re-run the affected tests**

Run:

```bash
& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/services/__tests__/brave.test.ts packages/backend/src/services/__tests__/aliexpress.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/brave.ts packages/backend/src/services/aliexpress.ts packages/backend/src/services/__tests__/brave.test.ts packages/backend/src/services/__tests__/aliexpress.test.ts
git commit -m "feat: tag provider results with retrieval lane metadata"
```

---

## Chunk 3: Search Route Orchestration

### Task 5: Add the Gemini image-query lane to `/search`

**Files:**
- Modify: `packages/backend/src/routes/search.ts`
- Test: `packages/backend/src/routes/__tests__/search.test.ts` or create equivalent

- [ ] **Step 1: Write failing route-level tests**

Add route tests for:
- successful merge of text-lane and image-lane results
- lane counts in `searchMeta`
- fallback behavior when Gemini image-query generation fails

At minimum, the test should assert that the final response contains:

```ts
expect(response.searchMeta.laneDiagnostics).toEqual({
  textResultCount: expect.any(Number),
  imageResultCount: expect.any(Number),
  hybridResultCount: expect.any(Number),
});
```

and that deduped duplicates across lanes surface as `hybrid`.

- [ ] **Step 2: Run the route test to verify it fails**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/routes/__tests__/search.test.ts`

Expected: FAIL because the route does not yet create a separate Gemini image-query lane or lane diagnostics.

- [ ] **Step 3: Implement the orchestration changes**

In `packages/backend/src/routes/search.ts`:
- derive or fetch a canonical source image once
- call `generateImageSearchQueries(...)` after identification is available
- run image-first Brave web and Brave image searches in parallel with the existing text lane
- keep existing AliExpress image search in the image lane
- tag results as `text`, `image`, or `hybrid`
- populate `searchMeta.laneDiagnostics`

Do not remove the existing Brave image search path. Replace its current `aiQueries.slice(0, 2)` input with the new Gemini image-first query set.

- [ ] **Step 4: Run the route test to verify it passes**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/routes/__tests__/search.test.ts`

Expected: PASS

- [ ] **Step 5: Run backend typecheck**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\tsc.cmd' --noEmit -p 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\tsconfig.json'`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routes/search.ts packages/backend/src/routes/__tests__/search.test.ts
git commit -m "feat: add Gemini image-query retrieval lane to search route"
```

---

## Chunk 4: Full Verification

### Task 6: Verify end-to-end backend behavior

**Files:**
- No code changes expected

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\vitest.cmd' run packages/backend/src/services/__tests__/gemini.test.ts packages/backend/src/services/__tests__/ranking.test.ts packages/backend/src/services/__tests__/brave.test.ts packages/backend/src/services/__tests__/aliexpress.test.ts packages/backend/src/routes/__tests__/search.test.ts
```

Expected: PASS

- [ ] **Step 2: Run backend typecheck**

Run: `& 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\node_modules\\.bin\\tsc.cmd' --noEmit -p 'C:\\dev\\repos\\shopping-assistant\\packages\\backend\\tsconfig.json'`

Expected: PASS

- [ ] **Step 3: Manually verify with the running dev backend**

Use a real `IMAGE_CLICKED` flow and confirm:
- search still completes when the Gemini image-query step succeeds
- final results include a mix of text/image/hybrid provenance
- exact or near-image matches improve relative to the current behavior

- [ ] **Step 4: Commit final plan-following cleanup if needed**

```bash
git add -A
git commit -m "test: verify Gemini image-query lane integration"
```
