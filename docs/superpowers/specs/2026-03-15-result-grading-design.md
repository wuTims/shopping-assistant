# Result Grading Design

**Date:** 2026-03-15
**Status:** Approved

## Context

The current backend search pipeline identifies a source product, gathers marketplace candidates, and ranks them for the side panel. The next iteration needs a stricter grading stage that prioritizes returning the same product the user is viewing over returning the cheapest similar item.

The main product requirement is conservative matching. A candidate should only be surfaced as a strong result when the system has high confidence that it represents the same underlying product. Lower-confidence variants can still be returned, but only as fallback results with clear labeling.

This design keeps Gemini deeply involved in grading while preserving deterministic guardrails around obvious mismatches and output policy.

## Goals

- Maximize exact product matches in returned results
- Use both textual/structured attributes and visual evidence during grading
- Keep variant handling conservative, with category-aware treatment when possible
- Allow fallback results when exact matches are unavailable, but label them clearly
- Make grading behavior explainable and testable

## Non-Goals

- Building a provider-specific integration for dropshipping APIs
- Redesigning the side panel UI beyond any labels needed for confidence tiers
- Introducing user accounts, persistence, or a database
- Solving category-specific grading for every retail vertical in v1

## Recommended Approach

Use a hybrid grading pipeline with deterministic pre-filtering plus Gemini as the final evaluator.

This approach keeps the backend in control of normalization, obvious contradiction checks, and output policy, while assigning the core product-match judgment to Gemini. It is stricter and easier to debug than a pure LLM judge, but more capable than rules-only matching when marketplace listings are incomplete or noisy.

## Alternatives Considered

### 1. Pure LLM judge

Send the source product and all candidates directly to Gemini and let it decide which results are exact matches, variants, or mismatches.

**Why not chosen:** Fast to prototype, but weak on determinism and difficult to debug when ranking quality regresses.

### 2. Rules-only matcher

Build a deterministic score from normalized title, brand, model, variant, quantity, and price fields, with little or no Gemini involvement.

**Why not chosen:** Predictable, but too brittle for inconsistent marketplace metadata and weak when image evidence is needed.

## Architecture

The grading stage becomes a dedicated backend pipeline that starts after candidate collection and before the final search response is returned.

### 1. Candidate Normalizer

Normalize every candidate result from Brave, Gemini grounding, and future providers into one shared grading shape:

- marketplace
- title
- canonical URL
- image URL
- price and currency
- extracted brand
- extracted model or product line
- extracted key attributes
- extracted variant attributes
- source reliability metadata

This stage does not decide match quality. Its job is to produce comparable inputs and capture missing data explicitly.

### 2. Attribute Comparator

Build a source-versus-candidate comparison record using the identified source product and the normalized candidate.

This stage should:

- detect hard contradictions when the evidence is clear
- preserve uncertainty instead of over-rejecting
- separate hard mismatches from soft differences

Examples:

- likely hard mismatch: different brand with strong confidence
- likely hard mismatch: conflicting model number or incompatible quantity/bundle
- likely soft difference: color, packaging wording, incomplete accessory details

Because v1 targets general retail, the comparator should use one shared policy with room for lightweight category-aware overrides later.

### 3. Gemini Grading Service

Gemini receives:

- source product summary from identification
- source image
- normalized candidate data
- candidate image
- comparison record from the deterministic layer
- grading instructions and allowed response schema

Gemini then returns a structured grading result:

- `matchClass`: `exact` | `close_variant` | `mismatch`
- `confidence`: numeric score
- `matchedAttributes`: list
- `uncertainAttributes`: list
- `mismatchReasons`: list
- `variantAssessment`: hard vs soft differences
- `explanation`: short reason suitable for UI or logs

Gemini is the main judgment layer. The backend should validate the response schema before using it.

### 4. Result Selector

The selector applies a strict output policy:

- rank `exact` matches first
- only use price as a tie-breaker within the same confidence tier
- include `close_variant` results only when exact matches are too few or too weak
- suppress `mismatch` results from user-facing output

This guarantees that a cheaper but weaker match never outranks a stronger exact match.

## Data Flow

```text
POST /search
  -> identify source product
  -> collect marketplace candidates
  -> normalize candidates
  -> compare attributes against source
  -> Gemini grades each eligible candidate
  -> validate grading responses
  -> select and tier final results
  -> return exact matches first, fallback variants second
```

## Grading Policy

The system should answer one question in order: "Can this candidate be trusted as the same product the user is viewing?"

### Deterministic Responsibilities

The deterministic layer should handle only cheap, defensible logic:

- normalize fields and extracted attributes
- detect missing evidence
- reject only clear contradictions
- pass uncertain candidates forward for Gemini review

It should not attempt to fully replace Gemini with a hand-built final score.

### Gemini Responsibilities

Gemini should make the final match judgment using combined text and visual evidence.

It should weigh:

- source title and extracted attributes
- candidate title and extracted attributes
- brand and model consistency
- product image similarity
- variant differences
- evidence gaps

The grading prompt should explicitly prefer false negatives over false positives. If Gemini is unsure whether two products are the same, it should downgrade to `close_variant` or `mismatch` rather than promote to `exact`.

### Variant Policy

Variant handling should be conservative and category-aware when possible.

For v1:

- treat some differences as likely hard mismatches when they materially change the product
- treat some differences as soft penalties when they do not materially change the product identity
- keep room for future category-specific policies without requiring them on day one

Examples of likely hard mismatches:

- storage capacity for electronics when it changes the SKU materially
- bundle size or quantity when the offer is meaningfully different
- incompatible model generation

Examples of likely soft differences:

- color in categories where color does not change the core product
- packaging revisions
- minor listing-title wording differences

## Error Handling

If Gemini grading fails, times out, or returns malformed structured output, the backend must not silently degrade to naive price sorting.

Fallback behavior should be:

- use deterministic comparison output to create a reduced-confidence ranking
- mark the search response as degraded
- label affected results as lower-confidence in metadata
- preserve enough detail for logs and debugging

If key candidate evidence is missing, such as image URLs or extractable attributes, the grader should continue when possible but lower confidence accordingly.

## Testing Strategy

Testing should focus on ranking behavior and grading correctness, not just isolated helper functions.

### Unit Tests

- candidate normalization
- attribute comparison rules
- response schema validation
- selector tiering and tie-break behavior

### Contract Tests

- Gemini grading response parsing
- malformed or incomplete Gemini responses
- prompt-to-schema compatibility

### Ranking Fixtures

Create curated fixtures covering:

- exact matches with cleaner and noisier metadata
- close variants that are cheaper but should rank lower
- obvious mismatches that must be excluded
- mixed evidence cases where text and image signals disagree
- missing image or attribute cases

Expected assertions:

- exact matches outrank all variants
- variants appear only when exact matches are insufficient or weak
- obvious mismatches do not surface
- degraded mode is labeled and remains conservative

## File Impact

This design likely affects:

- backend ranking services in [packages/backend/src/services/ranking.ts](C:\dev\repos\shopping-assistant\packages\backend\src\services\ranking.ts)
- provider outcome shaping in [packages/backend/src/services/provider-outcome.ts](C:\dev\repos\shopping-assistant\packages\backend\src\services\provider-outcome.ts)
- Gemini grading logic in [packages/backend/src/services/gemini.ts](C:\dev\repos\shopping-assistant\packages\backend\src\services\gemini.ts)
- shared grading types in [packages/shared/src/types.ts](C:\dev\repos\shopping-assistant\packages\shared\src\types.ts)

The implementation plan should confirm whether these responsibilities stay in existing files or get split into smaller grading-focused units.

## Scope Boundaries

**In scope:**

- stricter final-stage grading and selection logic
- Gemini-driven structured match judgments
- confidence tiers for exact and fallback results
- tests and fixtures for ranking behavior

**Out of scope:**

- dropshipping provider integration
- broader voice chat changes
- marketplace-specific business logic outside grading
- major UI redesign
