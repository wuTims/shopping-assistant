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

const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Embed a single image using gemini-embedding-2-preview.
 * Throws on invalid input (empty data, unsupported MIME type).
 * Returns the embedding vector, or an empty array if the API returns no embeddings.
 */
export async function embedImage(image: FetchedImage): Promise<number[]> {
  if (!image.data || image.data.length === 0) {
    throw new Error("Cannot embed image: empty data");
  }
  if (!SUPPORTED_IMAGE_MIMES.has(image.mimeType)) {
    throw new Error(`Unsupported image MIME type for embedding: ${image.mimeType}`);
  }

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
    console.warn(
      `[visual-ranking] Failed to embed original image (${originalImage.mimeType}, ${originalImage.data.length} chars):`,
      originalResult.reason,
    );
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
