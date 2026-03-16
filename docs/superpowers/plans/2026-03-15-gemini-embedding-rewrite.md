# Gemini Embedding-Based Visual Similarity Rewrite

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the slow generative visual comparison (`generateContent` with 9 images) with real image embeddings via `gemini-embedding-2-preview` + cosine similarity.

**Architecture:** Embed original product image and each candidate image in parallel via `embedContent`, then compute cosine similarity between the original vector and each candidate vector. This eliminates the generative LLM call, is faster (~500ms vs 5-6s), uses separate embedding quota (not the 20 req/day Flash limit), and produces deterministic scores.

**Tech Stack:** `@google/genai` SDK (`embedContent` API), `gemini-embedding-2-preview` model, existing `cosineSimilarity` function.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/backend/src/services/ai-client.ts` | Add `embeddingModel` constant |
| Modify | `packages/backend/src/services/embedding.ts` | Rewrite visual scoring: new `embedImage` helper + rewrite `computeVisualSimilarityScores` |
| Modify | `packages/backend/src/services/__tests__/embedding.test.ts` | Update mock, add `embedImage` tests |

**No new files.** The public API stays identical — `computeVisualSimilarityScores`, `blendScores`, `cosineSimilarity` keep the same signatures. `search.ts` requires **zero changes**.

---

## Chunk 1: Implementation

### Task 1: Add embedding model constant

**Files:**
- Modify: `packages/backend/src/services/ai-client.ts`

- [ ] **Step 1: Add the export**

```typescript
// ai-client.ts — add this line after the existing exports:
export const embeddingModel = "gemini-embedding-2-preview";
```

The full file should be:
```typescript
import { GoogleGenAI } from "@google/genai";

export const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
export const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
export const embeddingModel = "gemini-embedding-2-preview";
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — no consumers yet

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/services/ai-client.ts
git commit -m "feat: add gemini-embedding-2-preview model constant"
```

---

### Task 2: Write failing tests for embedImage

**Files:**
- Modify: `packages/backend/src/services/__tests__/embedding.test.ts`

- [ ] **Step 1: Update the existing ai-client mock and add embedImage tests**

The test file already has `vi.mock("../ai-client.js", ...)` at the top. Update it to include the embedding model and a mock `embedContent` function, then add the new test suite.

Replace the mock block (lines 3-7) with:
```typescript
// Mock ai-client to avoid requiring GEMINI_API_KEY
vi.mock("../ai-client.js", () => ({
  ai: {
    models: {
      embedContent: vi.fn(),
    },
  },
  geminiModel: "gemini-2.5-flash",
  embeddingModel: "gemini-embedding-2-preview",
}));
```

Update the import line (line 9) to also import `embedImage`:
```typescript
import { cosineSimilarity, blendScores, embedImage } from "../embedding.js";
import { ai } from "../ai-client.js";
```

Add a new describe block after the existing `blendScores` tests:
```typescript
describe("embedImage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns embedding vector for an image", async () => {
    const mockVector = [0.1, 0.2, 0.3, 0.4];
    vi.mocked(ai.models.embedContent).mockResolvedValue({
      embeddings: [{ values: mockVector }],
    } as any);

    const result = await embedImage({ data: "base64data", mimeType: "image/jpeg" });

    expect(result).toEqual(mockVector);
    expect(ai.models.embedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-embedding-2-preview",
        contents: [{ inlineData: { mimeType: "image/jpeg", data: "base64data" } }],
      }),
    );
  });

  it("returns empty array when embeddings response is empty", async () => {
    vi.mocked(ai.models.embedContent).mockResolvedValue({
      embeddings: [],
    } as any);

    const result = await embedImage({ data: "base64data", mimeType: "image/jpeg" });
    expect(result).toEqual([]);
  });

  it("returns empty array when values are undefined", async () => {
    vi.mocked(ai.models.embedContent).mockResolvedValue({
      embeddings: [{ values: undefined }],
    } as any);

    const result = await embedImage({ data: "base64data", mimeType: "image/jpeg" });
    expect(result).toEqual([]);
  });

  it("propagates API errors", async () => {
    vi.mocked(ai.models.embedContent).mockRejectedValue(new Error("quota exceeded"));

    await expect(
      embedImage({ data: "base64data", mimeType: "image/jpeg" }),
    ).rejects.toThrow("quota exceeded");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/backend/src/services/__tests__/embedding.test.ts`
Expected: FAIL — `embedImage` is not exported from `../embedding.js`

---

### Task 3: Implement embedImage and rewrite computeVisualSimilarityScores

**Files:**
- Modify: `packages/backend/src/services/embedding.ts`

- [ ] **Step 1: Rewrite embedding.ts**

Replace the entire file content. Keep `cosineSimilarity` and `blendScores` unchanged. Replace the generative `computeVisualSimilarityScores` with an embedding-based approach, and add a new exported `embedImage` helper.

The full new file:

```typescript
import type { SearchResult } from "@shopping-assistant/shared";
import {
  MAX_IMAGES_FOR_EMBEDDING,
  VISUAL_SCORE_WEIGHT,
  TEXT_SCORE_WEIGHT,
} from "@shopping-assistant/shared";
import { ai, embeddingModel } from "./ai-client.js";
import type { FetchedImage } from "./gemini.js";
import { fetchImage } from "./gemini.js";

// ── Core Math ────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
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

// ── Image Embedding via Gemini ───────────────────────────────────────────────

const EMBEDDING_DIMS = 256;
const IMAGE_FETCH_TIMEOUT_MS = 3_000;

/**
 * Embed a single image using gemini-embedding-2-preview.
 * Returns the embedding vector, or an empty array on failure.
 */
export async function embedImage(image: FetchedImage): Promise<number[]> {
  const response = await ai.models.embedContent({
    model: embeddingModel,
    contents: [{ inlineData: { mimeType: image.mimeType, data: image.data } }],
    config: {
      outputDimensionality: EMBEDDING_DIMS,
    },
  });

  return response.embeddings?.[0]?.values ?? [];
}

// ── Visual Similarity via Embeddings ─────────────────────────────────────────

/**
 * Compare product images using gemini-embedding-2-preview embeddings.
 * Embeds the original image and up to MAX_IMAGES_FOR_EMBEDDING candidate
 * images in parallel, then scores each candidate via cosine similarity.
 */
export async function computeVisualSimilarityScores(
  originalImage: FetchedImage,
  results: SearchResult[],
): Promise<Record<string, number>> {
  // Select candidates with images
  const candidates = results
    .filter((r) => r.imageUrl !== null)
    .slice(0, MAX_IMAGES_FOR_EMBEDDING);

  const noImage = results.length - results.filter((r) => r.imageUrl !== null).length;
  console.log(`[visual-ranking] Candidates: ${candidates.length}/${results.length} have images (${noImage} missing imageUrl)`);

  if (candidates.length === 0) return {};

  // Fetch candidate images in parallel
  const fetchStart = Date.now();
  const fetchOutcomes = await Promise.allSettled(
    candidates.map(async (result) => {
      const image = await fetchImage(result.imageUrl!, IMAGE_FETCH_TIMEOUT_MS);
      return { id: result.id, image, title: result.title };
    }),
  );

  const fetched: Array<{ id: string; image: FetchedImage; title: string }> = [];
  let fetchFailed = 0;
  for (let i = 0; i < fetchOutcomes.length; i++) {
    const outcome = fetchOutcomes[i];
    if (outcome.status === "fulfilled") {
      fetched.push(outcome.value);
    } else {
      fetchFailed++;
      console.warn(`[visual-ranking] Image fetch failed for "${candidates[i].title.slice(0, 50)}": ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
    }
  }
  console.log(`[visual-ranking] Fetched ${fetched.length}/${candidates.length} images in ${Date.now() - fetchStart}ms (${fetchFailed} failed)`);

  if (fetched.length === 0) return {};

  // Embed original + all candidates in parallel
  const embedStart = Date.now();
  const [originalResult, ...candidateResults] = await Promise.allSettled([
    embedImage(originalImage),
    ...fetched.map((f) => embedImage(f.image)),
  ]);

  if (originalResult.status === "rejected") {
    console.warn("[visual-ranking] Failed to embed original image:", originalResult.reason);
    return {};
  }
  const origVector = originalResult.value;
  if (origVector.length === 0) {
    console.warn("[visual-ranking] Original image embedding returned empty vector");
    return {};
  }

  // Compute cosine similarity for each candidate
  const scores: Record<string, number> = {};
  for (let i = 0; i < candidateResults.length; i++) {
    const result = candidateResults[i];
    if (result.status === "fulfilled" && result.value.length > 0) {
      const similarity = cosineSimilarity(origVector, result.value);
      // Clamp to [0, 1] — image embeddings are typically non-negative
      // so cosine similarity is already in [0, 1], but clamp for safety
      scores[fetched[i].id] = Math.max(0, Math.min(1, similarity));
    }
  }

  console.log(`[visual-ranking] Embedded ${Object.keys(scores).length}/${fetched.length} images in ${Date.now() - embedStart}ms`);
  for (const [id, score] of Object.entries(scores)) {
    const title = fetched.find((f) => f.id === id)?.title ?? "?";
    console.log(`[visual-ranking]   ${id} "${title.slice(0, 60)}": ${score.toFixed(3)}`);
  }

  return scores;
}
```

**Key changes from the old implementation:**
1. Removed `import { Type } from "@google/genai"` — no longer needed (no JSON schema)
2. Replaced `import { ai, geminiModel as model }` with `import { ai, embeddingModel }`
3. Added `embedImage()` — calls `embedContent` with a single image, returns vector
4. Rewrote `computeVisualSimilarityScores()`:
   - Same image fetching logic (unchanged)
   - Instead of one `generateContent` call with all images + prompt, makes N+1 parallel `embedContent` calls
   - Uses existing `cosineSimilarity()` to score each candidate vs original
   - Same logging format for compatibility

**What stays the same:**
- `cosineSimilarity()` — identical, no changes
- `blendScores()` — identical, no changes
- Function signature of `computeVisualSimilarityScores` — identical
- Return type: `Record<string, number>` with scores in [0, 1]
- Error handling: returns `{}` on failure (graceful degradation)
- `search.ts` integration: **zero changes needed**

- [ ] **Step 2: Run tests**

Run: `npx vitest run packages/backend/src/services/__tests__/embedding.test.ts`
Expected: All tests PASS (cosineSimilarity: 6, blendScores: 3, embedImage: 4)

- [ ] **Step 3: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/ai-client.ts packages/backend/src/services/embedding.ts packages/backend/src/services/__tests__/embedding.test.ts
git commit -m "feat: replace generative visual comparison with gemini-embedding-2-preview embeddings"
```

---

## Verification Checklist

After implementation, verify these behaviors:

1. **Build**: `pnpm typecheck` passes with no errors
2. **Tests**: `npx vitest run` — all existing tests still pass + new embedImage tests pass
3. **API contract**: `computeVisualSimilarityScores` signature unchanged — search.ts needs no edits
4. **Log output**: Visual ranking logs should show `[visual-ranking] Embedded N/M images in Xms` instead of the old `[visual-ranking] Scored N/M result images`
5. **Graceful degradation**: If embedding API fails, returns `{}` and search falls back to text-only scoring (same as before)
6. **Parallelism**: Original image + all candidates embedded simultaneously via `Promise.allSettled`
7. **Quota isolation**: Uses `gemini-embedding-2-preview` model (separate quota from `gemini-2.5-flash` used for identification)
