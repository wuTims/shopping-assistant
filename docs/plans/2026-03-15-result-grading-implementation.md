# Result Grading Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current score-map ranking with a conservative Gemini-assisted grading pipeline that returns exact matches first and only shows lower-confidence variants as labeled fallback results.

**Architecture:** Keep URL/title dedup and provider collection intact, but insert a new grading stage that normalizes candidate evidence, computes deterministic comparison signals, asks Gemini for a structured match judgment, validates the response, and then tiers the final output by match class before any price-based ordering. The change is backend-heavy, with shared type updates and fixture-driven tests to lock ranking behavior.

**Tech Stack:** TypeScript, Vitest, Hono, `@google/genai`, pnpm workspaces

**Spec Reference:** `docs/plans/2026-03-15-result-grading-design.md`

---

## Chunk 1: Shared Contracts And Grading Domain

### Task 1: Add shared grading types

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Write the failing shared-contract test cases in the backend ranking suite**

Add assertions that describe the new shape expected by ranking code, for example:

```typescript
expectTypeOf<RankedResult["matchClass"]>().toEqualTypeOf<"exact" | "close_variant" | "mismatch">();
expectTypeOf<RankedResult["grading"]>().toMatchTypeOf<{
  matchedAttributes: string[];
  uncertainAttributes: string[];
  mismatchReasons: string[];
}>();
```

- [ ] **Step 2: Run the test/typecheck target to confirm the new fields do not exist yet**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts`
Expected: FAIL with TypeScript or runtime assertions referencing missing grading fields.

- [ ] **Step 3: Add the minimal shared types**

Update `packages/shared/src/types.ts` to add:

```typescript
export type MatchClass = "exact" | "close_variant" | "mismatch";

export interface CandidateEvidence {
  brand: string | null;
  model: string | null;
  keyAttributes: Record<string, string | null>;
  variantAttributes: Record<string, string | null>;
  missingEvidence: string[];
}

export interface CandidateComparison {
  hardMismatchReasons: string[];
  softDifferenceReasons: string[];
  matchedAttributes: string[];
  uncertainAttributes: string[];
}

export interface GeminiGradingResult {
  matchClass: MatchClass;
  confidence: number;
  matchedAttributes: string[];
  uncertainAttributes: string[];
  mismatchReasons: string[];
  variantAssessment: {
    hardDifferences: string[];
    softDifferences: string[];
  };
  explanation: string;
}
```

Extend `SearchResult` or a grading-local type only as needed, and extend `RankedResult` with:

```typescript
matchClass: MatchClass;
grading: GeminiGradingResult | null;
degraded: boolean;
```

Re-export new types from `packages/shared/src/index.ts`.

- [ ] **Step 4: Run typecheck to verify the shared contracts compile**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/shared typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/index.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat(shared): add result grading contracts"
```

### Task 2: Create focused grading domain helpers

**Files:**
- Create: `packages/backend/src/services/grading-types.ts`
- Create: `packages/backend/src/services/candidate-normalizer.ts`
- Create: `packages/backend/src/services/attribute-comparator.ts`
- Test: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Add failing tests for normalization and comparison behavior**

Add fixture-oriented tests that describe:

```typescript
it("marks conflicting brands as hard mismatches", () => {
  expect(compareCandidate(source, candidate).hardMismatchReasons).toContain("brand_mismatch");
});

it("treats color-only differences as soft differences", () => {
  expect(compareCandidate(source, candidate).softDifferenceReasons).toContain("color_difference");
});
```

- [ ] **Step 2: Run the backend test target to confirm the helpers are missing**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts`
Expected: FAIL with module-not-found or missing export errors.

- [ ] **Step 3: Implement minimal helper files**

Create `candidate-normalizer.ts` with one exported function:

```typescript
export function normalizeCandidate(result: SearchResult): NormalizedCandidate {
  return {
    id: result.id,
    title: result.title,
    marketplace: result.marketplace,
    price: result.price,
    currency: result.currency,
    imageUrl: result.imageUrl,
    canonicalUrl: result.productUrl,
    evidence: {
      brand: result.structuredData?.brand ?? null,
      model: null,
      keyAttributes: {},
      variantAttributes: {},
      missingEvidence: [],
    },
  };
}
```

Create `attribute-comparator.ts` with a conservative comparator that:
- checks brand contradictions
- checks obvious quantity/bundle keywords when present
- records color/style differences as soft
- leaves unknowns in `uncertainAttributes`

- [ ] **Step 4: Re-run the backend tests and make them pass**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts`
Expected: PASS for the newly added normalization/comparison cases.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/grading-types.ts packages/backend/src/services/candidate-normalizer.ts packages/backend/src/services/attribute-comparator.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat(backend): add candidate normalization and comparison helpers"
```

## Chunk 2: Gemini Structured Grading And Ranking Integration

### Task 3: Add Gemini structured grading response support

**Files:**
- Modify: `packages/backend/src/services/gemini.ts`
- Create: `packages/backend/src/services/__tests__/gemini-grading.test.ts`
- Test: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Write failing contract tests for Gemini grading parsing**

Create `packages/backend/src/services/__tests__/gemini-grading.test.ts` with tests like:

```typescript
it("accepts a valid structured grading response", () => {
  expect(parseAndValidateGrading(validJson, ["r1"])).toEqual(expected);
});

it("rejects a response with invalid match class", () => {
  expect(() => parseAndValidateGrading(invalidJson, ["r1"])).toThrow();
});
```

- [ ] **Step 2: Run the new test file to confirm the parser does not exist yet**

Run: `pnpm --filter @shopping-assistant/backend test -- gemini-grading.test.ts`
Expected: FAIL with missing parser/function errors.

- [ ] **Step 3: Implement `gradeResults` and parser/validator support in `gemini.ts`**

Add:
- `GradeResultsInput`
- `gradeResults(input): Promise<Record<string, GeminiGradingResult>>`
- `parseAndValidateGrading(rawResponse, expectedIds)`

Use Gemini JSON schema output with one object per result id. The prompt should:
- prefer false negatives over false positives
- use source attributes, candidate attributes, and image availability
- classify only `exact`, `close_variant`, or `mismatch`

The validator should reject:
- missing result ids
- extra ids
- invalid match classes
- non-numeric confidence or confidence outside `0..1`
- missing explanation or variant fields

- [ ] **Step 4: Re-run the grading parser tests**

Run: `pnpm --filter @shopping-assistant/backend test -- gemini-grading.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/gemini.ts packages/backend/src/services/__tests__/gemini-grading.test.ts
git commit -m "feat(gemini): add structured result grading response handling"
```

### Task 4: Replace `applyRanking` with tiered grading-aware selection

**Files:**
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Add failing ranking-behavior tests**

Expand `ranking.test.ts` with behavior-first cases:

```typescript
it("ranks exact matches ahead of cheaper close variants", () => {
  expect(selectRankedResults(input).map((r) => r.result.id)).toEqual(["exact_1", "variant_1"]);
});

it("suppresses mismatches from user-facing output", () => {
  expect(selectRankedResults(input).map((r) => r.result.id)).not.toContain("mismatch_1");
});

it("marks deterministic fallback results as degraded", () => {
  expect(selectRankedResults(input)[0].degraded).toBe(true);
});
```

- [ ] **Step 2: Run the backend ranking test file**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts`
Expected: FAIL because `applyRanking` still expects a numeric score map.

- [ ] **Step 3: Refactor `ranking.ts`**

Keep `mergeAndDedup`, but replace the final ranking API with two focused functions:

```typescript
export function buildDeterministicFallbackGrades(
  results: SearchResult[],
  identification: ProductIdentification,
): Record<string, GeminiGradingResult> { /* conservative fallback */ }

export function selectRankedResults(
  results: SearchResult[],
  grades: Record<string, GeminiGradingResult>,
  originalPrice: number | null,
  degraded = false,
): RankedResult[] { /* tier by matchClass, then confidence, then price */ }
```

Selection rules:
- drop `mismatch`
- tier `exact` before `close_variant`
- sort by `confidence desc` inside each tier
- use price only as a tie-breaker inside a tier
- set `comparisonNotes` from `explanation`, confidence, and price context

- [ ] **Step 4: Re-run ranking tests**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat(ranking): add grading-aware tiered result selection"
```

### Task 5: Integrate grading into the `/search` pipeline

**Files:**
- Modify: `packages/backend/src/routes/search.ts`
- Modify: `packages/backend/src/services/provider-outcome.ts`
- Test: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Add a failing integration-oriented test or fixture case**

If there is already route coverage, add to it. Otherwise add a focused service-level fixture in `ranking.test.ts` that mimics `/search` integration:

```typescript
it("falls back to deterministic grades when Gemini grading fails", () => {
  expect(searchMeta.rankingStatus).toBe("fallback");
});
```

- [ ] **Step 2: Run the targeted backend tests**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts`
Expected: FAIL because the route still uses `rankResults()` and score maps.

- [ ] **Step 3: Update the search route**

In `packages/backend/src/routes/search.ts`:
- replace `rankResults()` usage with `gradeResults()` plus `selectRankedResults()`
- normalize and compare candidates before calling Gemini
- pass only the capped candidate set to grading
- if Gemini grading throws, use `buildDeterministicFallbackGrades()` and set `rankingStatus: "fallback"`
- continue populating `rankingFailureReason`

In `provider-outcome.ts`, add any metadata helper needed for degraded grading diagnostics only if reused. Do not broaden provider status semantics unnecessarily.

- [ ] **Step 4: Run backend tests and typecheck**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: PASS

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/routes/search.ts packages/backend/src/services/provider-outcome.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat(search): integrate Gemini-assisted grading pipeline"
```

## Chunk 3: Fixtures, Response Metadata, And Final Verification

### Task 6: Add curated ranking fixtures for mixed-quality candidates

**Files:**
- Create: `packages/backend/src/services/__tests__/fixtures/result-grading.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Create failing fixture-driven tests**

Add fixtures for:
- exact same product with cleaner metadata
- cheaper variant with storage or bundle mismatch
- obvious mismatch from another brand
- exact match with missing image
- close variant with only partial evidence

Example test:

```typescript
it("returns variants only after exact matches", () => {
  const ranked = selectRankedResults(results, grades, 299);
  expect(ranked.map((r) => [r.result.id, r.matchClass])).toEqual([
    ["exact_amazon", "exact"],
    ["exact_ebay", "exact"],
    ["variant_aliexpress", "close_variant"],
  ]);
});
```

- [ ] **Step 2: Run the ranking test file**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts`
Expected: FAIL until fixtures and ordering logic align.

- [ ] **Step 3: Add the fixture module and adjust tests/helpers**

Create a single fixture source file exporting:
- `baseIdentification`
- `exactMatchResults`
- `variantResults`
- `mismatchResults`
- expected grading maps

Keep the fixture data small and readable. Prefer literal marketplace titles over generated strings.

- [ ] **Step 4: Re-run the ranking tests**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/__tests__/fixtures/result-grading.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "test(ranking): add curated result grading fixtures"
```

### Task 7: Surface grading metadata to the extension safely

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/extension/src/sidepanel/components/ResultCard.tsx`
- Modify: `packages/extension/src/sidepanel/components/ProductSection.tsx`

- [ ] **Step 1: Add a failing UI-level expectation**

If there is no component test harness, document this as a manual verification step in code comments and use type-level assertions instead. The minimum behavior to lock:
- exact matches can display their confidence tier
- fallback variants are distinguishable from exact matches
- mismatches are never sent to the UI

- [ ] **Step 2: Run typecheck to capture current gaps**

Run: `pnpm typecheck`
Expected: FAIL or remain pending until the UI reads the new `matchClass` metadata.

- [ ] **Step 3: Thread minimal metadata through the UI**

Update the side panel card rendering to show:
- confidence text from existing `confidence`
- a fallback label when `matchClass === "close_variant"`

Do not redesign the layout. Keep this to a small badge or secondary label so the implementation stays within the approved scope.

- [ ] **Step 4: Re-run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/extension/src/sidepanel/components/ResultCard.tsx packages/extension/src/sidepanel/components/ProductSection.tsx
git commit -m "feat(extension): label fallback graded results"
```

### Task 8: Final verification and cleanup

**Files:**
- Review: `docs/plans/2026-03-15-result-grading-design.md`
- Review: `docs/plans/2026-03-15-result-grading-implementation.md`

- [ ] **Step 1: Run focused backend tests**

Run: `pnpm --filter @shopping-assistant/backend test -- ranking.test.ts gemini-grading.test.ts`
Expected: PASS

- [ ] **Step 2: Run full workspace typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run the backend build if grading code touched exported modules**

Run: `pnpm build`
Expected: PASS

- [ ] **Step 4: Manually verify one fallback-label UI path**

Load the extension and confirm one `close_variant` result shows a lower-confidence label while exact matches remain first.

- [ ] **Step 5: Commit final verification or follow-up fixes**

```bash
git add .
git commit -m "test: verify result grading pipeline end to end"
```

---

## Notes

- Keep file boundaries tight. If `packages/backend/src/services/gemini.ts` becomes unwieldy, split the grading-specific parser/prompt code into `packages/backend/src/services/gemini-grading.ts` and adjust the plan during execution.
- Do not remove the existing fallback heuristics until the deterministic fallback grading path is in place and covered by tests.
- Price remains a tie-breaker only. Any implementation that lets a `close_variant` outrank an `exact` match is a regression against the approved design.
