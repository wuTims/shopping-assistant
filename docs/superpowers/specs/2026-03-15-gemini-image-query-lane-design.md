# Gemini Image Query Lane Design

**Date:** 2026-03-15

## Goal

Improve product search recall by adding a Gemini-generated image-first query lane on top of the existing retrieval pipeline, while keeping the current Brave image search, Brave web search, AliExpress search, and embedding-based final grading.

## Current State

The repo already has part of the desired architecture:

- `/search` identifies the product from an image and generates text-oriented search queries.
- Brave web search runs in multiple text-driven modes.
- Brave image search already runs in parallel, but it uses the same AI text queries.
- AliExpress search already supports text search plus direct image search.
- Final ranking already blends text scoring with embedding-based visual similarity.
- `IMAGE_CLICKED` requests now usually include both `imageUrl` and `imageBase64`, so overlay flows have strong visual input.

The current gap is that the "image" lane is not truly independent. It is still driven by the same text-oriented `identification.searchQueries`, so it does not add enough retrieval diversity.

## Recommended Approach

Keep the existing provider integrations and add a new Gemini function that generates image-first shopping queries from the source image itself. Feed those queries into Brave web search and Brave image search as a separate retrieval lane, merge them with existing text-lane and AliExpress results, then keep the existing dedupe and embedding-based grading path.

This keeps costs and code churn moderate because:

- provider integrations already exist
- visual grading already exists
- `IMAGE_CLICKED` already supplies usable image data

## Architecture

### 1. Canonical source image

At the start of `/search`, normalize the request into a single canonical source image:

- use `imageBase64` when present
- otherwise fetch `imageUrl`

That canonical image should be reused for:

- product identification
- Gemini image-query generation
- AliExpress image search
- embedding-based final grading

This removes path-specific inconsistencies where one stage sees a different image than another.

### 2. Retrieval lanes

The retrieval pipeline should become explicitly lane-based.

Text lane:

- title-derived Brave web queries
- identification-driven Brave web queries
- marketplace-specific Brave web queries
- existing AliExpress text queries

Image lane:

- new Gemini-generated image-first shopping queries
- Brave web search using those image-first queries
- Brave image search using those image-first queries
- existing AliExpress image search using the canonical image

The existing Brave image search should remain. The new work is to make it part of a genuinely separate image-first lane instead of feeding it the same text-oriented queries used elsewhere.

### 3. Merge and provenance

All provider results still merge into one candidate pool before price fallback and ranking, but each candidate needs retrieval provenance:

- `text`
- `image`
- `hybrid`

`hybrid` means the same normalized result was found by both lanes during merge/dedup.

This provenance should be available:

- per result
- in aggregate diagnostics in `searchMeta`

The UI does not need to change yet, but the API should expose the metadata so search quality can be inspected and tuned.

### 4. Ranking

The final trust model should not change.

The combined candidate pool should still flow through:

- dedupe
- source URL filtering
- heuristic pre-sort
- diversity cap
- price fallback
- embedding-based visual similarity
- final blended scoring

The new lane changes retrieval only. It does not bypass grading.

## Data Contract Changes

Shared types should be extended to support observability for the new lane.

`SearchResult`:

- add `retrievalLane?: "text" | "image" | "hybrid"`

`searchMeta`:

- add lane-level counts and diagnostics
- preserve existing provider-level diagnostics unless they are clearly obsolete

At minimum the response should expose enough information to answer:

- how many final results came from the image lane
- how many results were text-only vs image-only vs hybrid
- whether the Gemini image-query lane produced unique matches

## Query Generation Requirements

The new Gemini image-query generator should:

- prioritize shopping intent
- describe visually important attributes from the image
- allow broader near-match retrieval, not just exact SKU/title matching
- avoid overly verbose paragraph-style queries
- produce a small bounded set of queries, likely 3-5

Optional title hints may be included, but the image should remain the primary source of truth for this lane.

## Error Handling

The image lane should fail open:

- if image-query generation fails, continue with existing text retrieval
- if Brave image/web search for the image lane fails, continue with other providers
- if canonical image fetch fails for an `imageUrl`-only request, return the existing identification/search error only when no other usable image input exists

This feature should improve recall without making the pipeline brittle.

## Testing

The implementation should add or expand tests for:

- Gemini image-query generation output validation
- lane provenance merge behavior
- dedup promotion from `text` or `image` to `hybrid`
- `/search` response diagnostics for lane counts
- graceful degradation when the new Gemini image-query call fails

Existing Brave and AliExpress normalization tests should remain in place and should not be rewritten unless contract changes require it.

## Plan Impact

The previous implementation idea assumed a brand-new image lane. That is no longer accurate.

The updated implementation plan should instead focus on:

1. generating separate Gemini image-first queries
2. threading lane provenance through the merged candidate pool
3. exposing lane diagnostics in shared response types
4. reusing the current embedding-based ranking as-is
