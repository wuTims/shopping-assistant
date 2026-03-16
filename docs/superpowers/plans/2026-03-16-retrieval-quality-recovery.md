# Retrieval Quality Recovery Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans and superpowers:test-driven-development to implement this plan.

**Goal:** Recover search result quality after the UI/retrieval changes by removing dead/store/search-page candidates, making `See price` meaningful again, and verifying that the Gemini image-query lane is producing useful results.

## Scope

- Backend retrieval diagnostics
- URL classification and invalid-page filtering
- Product-page verification for top candidates
- `See price` policy tightening
- Gemini image-lane observability and query-quality control
- Ranking adjustments and regression coverage

## File Map

- Modify: `packages/backend/src/routes/search.ts`
- Create: `packages/backend/src/services/result-validation.ts`
- Modify: `packages/backend/src/services/brave.ts`
- Modify: `packages/backend/src/services/aliexpress.ts`
- Modify: `packages/backend/src/services/gemini.ts`
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/shared/src/types.ts`
- Create/Modify tests:
  - `packages/backend/src/routes/__tests__/search.test.ts`
  - `packages/backend/src/services/__tests__/brave.test.ts`
  - `packages/backend/src/services/__tests__/gemini.test.ts`
  - `packages/backend/src/services/__tests__/ranking.test.ts`
  - `packages/backend/src/services/__tests__/result-validation.test.ts`

## Chunk 1: Diagnostics and Shared Result Metadata

- [ ] Add failing tests for result diagnostics and URL classification metadata.
- [ ] Extend shared types with:
  - `urlClassification`
  - `priceSource`
  - `validationStatus`
  - richer lane diagnostics
- [ ] Tag Brave and AliExpress results with the initial metadata before merge.
- [ ] Verify tests pass.

## Chunk 2: URL Classification and Invalid Candidate Filtering

- [ ] Add failing tests for:
  - search-result pages
  - category/listing pages
  - seller/storefront pages
  - valid product-detail pages
- [ ] Implement `result-validation.ts` with shared URL classification helpers.
- [ ] Apply strict filtering in `/search` before ranking.
- [ ] Verify tests pass.

## Chunk 3: Product-Page Verification for Top Candidates

- [ ] Add failing route/service tests for redirected/dead/store-page candidates.
- [ ] Implement top-candidate page verification:
  - follow redirects
  - classify final URL/page
  - reject invalid pages
- [ ] Persist verification outcome onto result metadata.
- [ ] Verify tests pass.

## Chunk 4: Tighten `See price`

- [ ] Add failing tests proving only valid product pages may remain without price.
- [ ] Split `See price` semantics into:
  - valid product page with missing price
  - invalid page (discard)
- [ ] Ensure dead/store/search pages are removed instead of displayed.
- [ ] Verify tests pass.

## Chunk 5: Gemini Image-Lane Audit and Query Quality

- [ ] Add failing tests for image-query normalization and weak/generic query rejection.
- [ ] Add request logging/diagnostics for:
  - raw Gemini image queries
  - normalized queries
  - per-query provider contribution
- [ ] Tighten `generateImageSearchQueries()` normalization to reject low-signal generic queries and recover with stronger fallbacks.
- [ ] Verify tests pass.

## Chunk 6: Ranking Rebalance

- [ ] Add failing tests for ranking favoring validated product pages and hybrid evidence.
- [ ] Reweight ranking to prioritize:
  - validated product-detail candidates
  - trusted price sources
  - visual/title agreement
  - hybrid lane matches
- [ ] Reduce trust in snippet-only prices and weak URL classes.
- [ ] Verify tests pass.

## Chunk 7: Full Verification

- [ ] Run targeted backend tests for validation, Brave, Gemini, ranking, and route orchestration.
- [ ] Run backend typecheck.
- [ ] Summarize diagnostic fields and residual risks.
