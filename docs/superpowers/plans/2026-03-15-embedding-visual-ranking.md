# Embedding-Based Visual Ranking Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace text-only heuristic ranking with Gemini multimodal embedding-based visual similarity scoring, providing accurate product matching without the 17-second latency of the old generative ranking approach.

**Architecture:** Embed the original product image once using Gemini's multimodal embedding model. Batch-embed top N result images in parallel. Compute cosine similarity between original and each result embedding. Blend the visual similarity score (0-1) with the existing text heuristic score to produce a combined confidence score. This gives us visual accuracy (~2-4 seconds for 5-8 images) without the generative model overhead.

**Tech Stack:** `@google/genai` SDK embedding API, cosine similarity computation. No new dependencies needed.

**Key Decision:** We use a blended scoring approach: `0.4 * visualSimilarity + 0.6 * textHeuristic`. This ensures results without images still rank well via text, while visually similar products get a meaningful boost.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/backend/src/services/embedding.ts` | Gemini embedding for images + cosine similarity scoring |
| Create | `packages/backend/src/services/__tests__/embedding.test.ts` | Unit tests for cosine similarity and score blending |
| Modify | `packages/backend/src/services/ranking.ts` | Add `blendScores()`, remove dead code (`selectImageCandidates`) |
| Modify | `packages/backend/src/routes/search.ts` | Add embedding phase between Phase 3 and Phase 4 |
| Modify | `packages/shared/src/constants.ts` | Add `EMBEDDING_TIMEOUT_MS`, `MAX_IMAGES_FOR_EMBEDDING` |

---

## Chunk 1: Embedding Service

### Task 1: Add constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Add embedding constants**

Add to `packages/shared/src/constants.ts`:

```typescript
export const EMBEDDING_TIMEOUT_MS = 6_000;
export const MAX_IMAGES_FOR_EMBEDDING = 8;
export const VISUAL_SCORE_WEIGHT = 0.4;
export const TEXT_SCORE_WEIGHT = 0.6;
```

- [ ] **Step 2: Clean up unused constants**

Remove from `packages/shared/src/constants.ts`:

```typescript
// Remove these — dead code from old generative ranking
export const MAX_IMAGES_FOR_RANKING = 5;
export const RANKING_IMAGE_TIMEOUT_MS = 3_000;
```

- [ ] **Step 3: Build shared**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared`
Expected: Build succeeds

- [ ] **Step 4: Fix any imports of removed constants**

Search the codebase for `MAX_IMAGES_FOR_RANKING` and `RANKING_IMAGE_TIMEOUT_MS`. These should not be imported anywhere in active code (they were only used by the removed `rankResults` flow). If any tests reference them (like `ranking.test.ts`), remove those references.

Run: `cd /workspaces/web-dev-playground/shopping-assistant && grep -r "MAX_IMAGES_FOR_RANKING\|RANKING_IMAGE_TIMEOUT_MS" packages/ --include="*.ts"`

- [ ] **Step 5: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/shared/src/constants.ts
git commit -m "feat: add embedding constants, remove dead ranking constants"
```

---

### Task 2: Create embedding service

**Files:**
- Create: `packages/backend/src/services/embedding.ts`
- Create: `packages/backend/src/services/__tests__/embedding.test.ts`

- [ ] **Step 1: Write failing tests for cosine similarity and score blending**

```typescript
// packages/backend/src/services/__tests__/embedding.test.ts
import { describe, it, expect } from "vitest";
import { cosineSimilarity, blendScores } from "../embedding.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it("handles real-world similarity range", () => {
    const a = [0.1, 0.3, 0.5, 0.7, 0.9];
    const b = [0.2, 0.4, 0.5, 0.6, 0.8];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.95);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("blendScores", () => {
  it("blends text and visual scores with default weights", () => {
    const textScores = { a: 0.8, b: 0.5, c: 0.3 };
    const visualScores = { a: 0.9, b: 0.2 }; // c has no visual score

    const blended = blendScores(textScores, visualScores);

    // a: 0.6 * 0.8 + 0.4 * 0.9 = 0.48 + 0.36 = 0.84
    expect(blended.a).toBeCloseTo(0.84, 2);
    // b: 0.6 * 0.5 + 0.4 * 0.2 = 0.30 + 0.08 = 0.38
    expect(blended.b).toBeCloseTo(0.38, 2);
    // c: no visual score → text score only
    expect(blended.c).toBe(0.3);
  });

  it("returns text scores unchanged when no visual scores", () => {
    const textScores = { a: 0.8, b: 0.5 };
    const blended = blendScores(textScores, {});
    expect(blended).toEqual(textScores);
  });

  it("clamps blended scores to [0, 0.95]", () => {
    const textScores = { a: 0.95 };
    const visualScores = { a: 1.0 };
    const blended = blendScores(textScores, visualScores);
    expect(blended.a).toBeLessThanOrEqual(0.95);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/embedding.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement embedding.ts**

```typescript
// packages/backend/src/services/embedding.ts
import type { SearchResult } from "@shopping-assistant/shared";
import {
  MAX_IMAGES_FOR_EMBEDDING,
  EMBEDDING_TIMEOUT_MS,
  VISUAL_SCORE_WEIGHT,
  TEXT_SCORE_WEIGHT,
} from "@shopping-assistant/shared";
import { ai } from "./ai-client.js";
import type { FetchedImage } from "./gemini.js";
import { fetchImage } from "./gemini.js";

// Multimodal embedding model — supports both text and image inputs
const EMBEDDING_MODEL = "gemini-embedding-exp-03-07";

// ── Core Math ────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dotProduct / denom;
}

// ── Score Blending ───────────────────────────────────────────────────────────

export function blendScores(
  textScores: Record<string, number>,
  visualScores: Record<string, number>,
): Record<string, number> {
  const blended: Record<string, number> = {};

  for (const [id, textScore] of Object.entries(textScores)) {
    if (id in visualScores) {
      const raw = TEXT_SCORE_WEIGHT * textScore + VISUAL_SCORE_WEIGHT * visualScores[id];
      blended[id] = Math.min(raw, 0.95);
    } else {
      blended[id] = textScore;
    }
  }

  return blended;
}

// ── Embedding API ────────────────────────────────────────────────────────────

async function embedImage(image: FetchedImage): Promise<number[]> {
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: {
      parts: [{ inlineData: { mimeType: image.mimeType, data: image.data } }],
    },
  });
  return response.embeddings?.[0]?.values ?? [];
}

// ── Visual Similarity Scoring ────────────────────────────────────────────────

/**
 * Compute visual similarity scores for search results by comparing their
 * product images against the original product image using multimodal embeddings.
 *
 * Returns a map of result ID → similarity score (0.0 to 1.0).
 * Results without images or with fetch failures are omitted.
 */
export async function computeVisualSimilarityScores(
  originalImage: FetchedImage,
  results: SearchResult[],
): Promise<Record<string, number>> {
  // Select candidates with images
  const candidates = results
    .filter((r) => r.imageUrl !== null)
    .slice(0, MAX_IMAGES_FOR_EMBEDDING);

  if (candidates.length === 0) return {};

  // Embed original image
  let originalEmbedding: number[];
  try {
    originalEmbedding = await embedImage(originalImage);
  } catch (err) {
    console.error("[embedding] Failed to embed original image:", err);
    return {};
  }

  if (originalEmbedding.length === 0) return {};

  // Fetch and embed result images in parallel
  const IMAGE_FETCH_TIMEOUT_MS = 3_000;
  const outcomes = await Promise.allSettled(
    candidates.map(async (result) => {
      const image = await fetchImage(result.imageUrl!, IMAGE_FETCH_TIMEOUT_MS);
      const embedding = await embedImage(image);
      return { id: result.id, embedding };
    }),
  );

  const scores: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled" && outcome.value.embedding.length > 0) {
      const similarity = cosineSimilarity(originalEmbedding, outcome.value.embedding);
      // Normalize from [-1, 1] to [0, 1] — negative similarity means very dissimilar
      scores[outcome.value.id] = Math.max(0, similarity);
    }
  }

  console.log(`[embedding] Scored ${Object.keys(scores).length}/${candidates.length} result images`);
  return scores;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/embedding.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/services/embedding.ts packages/backend/src/services/__tests__/embedding.test.ts
git commit -m "feat: add Gemini multimodal embedding service with cosine similarity scoring"
```

---

## Chunk 2: Pipeline Integration

### Task 3: Clean up dead ranking code

**Files:**
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Remove selectImageCandidates from ranking.ts**

Remove the `selectImageCandidates` function (lines 192-202) from `packages/backend/src/services/ranking.ts`. Also remove it from the exports.

- [ ] **Step 2: Remove selectImageCandidates tests from ranking.test.ts**

Remove the entire `describe("selectImageCandidates", ...)` block from `packages/backend/src/services/__tests__/ranking.test.ts`. Also remove the `selectImageCandidates` import.

- [ ] **Step 3: Run tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/ranking.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "refactor: remove dead selectImageCandidates code"
```

---

### Task 4: Clean up dead generative ranking code in gemini.ts

**Files:**
- Modify: `packages/backend/src/services/gemini.ts`

- [ ] **Step 1: Remove dead rankResults function and related types**

In `packages/backend/src/services/gemini.ts`, remove:
- The `RankResultsInput` interface (lines 244-249)
- The `rankResults` function (lines 251-319)
- The `parseAndValidateScores` function (lines 448-504)
- The `RankingOutputValidationError` class (lines 11-19)
- Any imports only used by those removed functions (check `Type` from `@google/genai` — it's still used by `identifyProduct`, so keep it)

- [ ] **Step 2: Run typecheck and all tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm typecheck && pnpm --filter @shopping-assistant/backend test`
Expected: All pass. If any test imports `RankingOutputValidationError`, update those too.

- [ ] **Step 3: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/services/gemini.ts
git commit -m "refactor: remove dead generative ranking code from gemini.ts"
```

---

### Task 5: Wire embedding into search pipeline

**Files:**
- Modify: `packages/backend/src/routes/search.ts`

- [ ] **Step 1: Import embedding service**

Add to imports in `packages/backend/src/routes/search.ts`:

```typescript
import { computeVisualSimilarityScores, blendScores } from "../services/embedding.js";
import { EMBEDDING_TIMEOUT_MS } from "@shopping-assistant/shared";
```

- [ ] **Step 2: Store original image for embedding use**

The original image is already available from the identification step. We need to capture it. After Phase 1 identification succeeds, store the original image. Modify the identification block:

When identification is from scratch (lines 86-99), the `identifyProduct` call returns `{ identification, originalImage }`. Store `originalImage`:

```typescript
    let originalImage: FetchedImage | null = null;

    // ... in the else branch where identifyProduct is called:
    const result = await identifyProduct(imageSource, body.title);
    identification = result.identification;
    originalImage = result.originalImage;
```

When identification is pre-computed (lines 76-85), build the image from the request:

```typescript
    // In the pre-computed branch:
    if (body.imageBase64) {
      originalImage = { data: body.imageBase64, mimeType: "image/png" };
    }
```

- [ ] **Step 3: Add embedding phase between Phase 3.5 and Phase 4**

Insert a new phase after price fallback and before ranking:

```typescript
  // ── Phase 3.75: embedding-based visual similarity ─────────────────────────
  let visualScores: Record<string, number> = {};
  if (originalImage && remaining() > EMBEDDING_TIMEOUT_MS + 1000) {
    try {
      visualScores = await withTimeout(
        computeVisualSimilarityScores(originalImage, capped),
        EMBEDDING_TIMEOUT_MS,
      );
      console.log(`[search:${requestId}] Embedding scored ${Object.keys(visualScores).length} results`);
    } catch (err) {
      console.warn(`[search:${requestId}] Embedding scoring failed:`, err);
    }
  } else {
    console.log(`[search:${requestId}] Skipping embedding — ${originalImage ? "insufficient time" : "no original image"}`);
  }
```

- [ ] **Step 4: Blend scores in Phase 4**

Modify Phase 4 to blend text heuristic scores with visual scores:

```typescript
  // ── Phase 4: ranking ─────────────────────────────────────────────────────
  const rankStart = Date.now();
  const textScores = buildFallbackScores(capped, identification);
  const scores = Object.keys(visualScores).length > 0
    ? blendScores(textScores, visualScores)
    : textScores;
  const rankingDurationMs = Date.now() - rankStart;
```

- [ ] **Step 5: Run typecheck and all tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm typecheck && pnpm --filter @shopping-assistant/backend test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/routes/search.ts
git commit -m "feat: integrate embedding-based visual ranking into search pipeline"
```
