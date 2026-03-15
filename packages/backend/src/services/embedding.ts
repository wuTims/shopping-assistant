import type { SearchResult } from "@shopping-assistant/shared";
import {
  MAX_IMAGES_FOR_EMBEDDING,
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
