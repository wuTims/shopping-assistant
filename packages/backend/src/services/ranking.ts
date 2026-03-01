import type { SearchResult, RankedResult } from "@shopping-assistant/shared";

// Merge, deduplicate, and prepare results for Gemini visual ranking
// TODO: Implement deduplication by URL and title similarity

export function mergeAndDedup(results: SearchResult[]): SearchResult[] {
  return results;
}

export function applyRanking(
  results: SearchResult[],
  scores: Record<string, number>,
  originalPrice: number | null,
): RankedResult[] {
  return [];
}
