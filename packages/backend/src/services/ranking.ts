import type { ProductIdentification, SearchResult, RankedResult } from "@shopping-assistant/shared";
import { CONFIDENCE_THRESHOLDS, MIN_CONFIDENCE_SCORE } from "@shopping-assistant/shared";

// ── mergeAndDedup ────────────────────────────────────────────────────────────

export function mergeAndDedup(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();

  for (const result of results) {
    const normalizedUrl = normalizeUrl(result.productUrl);

    // URL-based dedup: keep the result with more data
    if (seen.has(normalizedUrl)) {
      const existing = seen.get(normalizedUrl)!;
      if (resultRichness(result) > resultRichness(existing)) {
        seen.set(normalizedUrl, result);
      }
      continue;
    }

    // Title-similarity dedup: check if a very similar title already exists
    let isDuplicate = false;
    for (const [, existing] of seen) {
      if (titleSimilarity(result.title, existing.title) > 0.85) {
        // Keep the one with more data
        if (resultRichness(result) > resultRichness(existing)) {
          seen.delete(normalizeUrl(existing.productUrl));
          seen.set(normalizedUrl, result);
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      seen.set(normalizedUrl, result);
    }
  }

  return Array.from(seen.values());
}

// ── applyRanking ─────────────────────────────────────────────────────────────

export function applyRanking(
  results: SearchResult[],
  scores: Record<string, number>,
  originalPrice: number | null,
): RankedResult[] {
  const ranked: RankedResult[] = [];

  for (const result of results) {
    const score = scores[result.id] ?? 0;

    // Filter clearly irrelevant results
    if (score < MIN_CONFIDENCE_SCORE) continue;

    const confidence = scoreToConfidence(score);
    const { priceDelta, savingsPercent } = computePriceDelta(originalPrice, result.price);

    const notes: string[] = [];
    if (result.price !== null && originalPrice !== null) {
      if (priceDelta! < 0) {
        notes.push(`${Math.abs(savingsPercent!).toFixed(0)}% cheaper`);
      } else if (priceDelta! > 0) {
        notes.push(`${savingsPercent!.toFixed(0)}% more expensive`);
      } else {
        notes.push("Same price");
      }
    }
    notes.push(`Confidence: ${confidence} (${(score * 100).toFixed(0)}%)`);

    ranked.push({
      result,
      confidence,
      confidenceScore: score,
      priceDelta,
      savingsPercent,
      comparisonNotes: notes.join(". "),
      rank: 0, // assigned after sorting
    });
  }

  // Sort: primarily by confidence score (desc), secondarily by savings (desc)
  ranked.sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) {
      return b.confidenceScore - a.confidenceScore;
    }
    // More savings (more negative priceDelta) is better
    const aSavings = a.priceDelta ?? 0;
    const bSavings = b.priceDelta ?? 0;
    return aSavings - bSavings;
  });

  // Assign ranks
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].rank = i + 1;
  }

  return ranked;
}

export function buildFallbackScores(
  results: SearchResult[],
  identification: ProductIdentification,
): Record<string, number> {
  const scores: Record<string, number> = {};
  const brand = identification.brand?.toLowerCase().trim() ?? null;
  const categoryTokens = tokenize(identification.category);
  const descriptionTokens = tokenize(identification.description);
  const referenceTokens = new Set([...categoryTokens, ...descriptionTokens]);

  for (const result of results) {
    const titleTokens = tokenize(result.title);
    const marketplaceTokens = tokenize(result.marketplace);
    const resultTokens = new Set([...titleTokens, ...marketplaceTokens]);

    let overlap = 0;
    for (const token of referenceTokens) {
      if (resultTokens.has(token)) overlap++;
    }

    const overlapRatio = referenceTokens.size > 0 ? overlap / referenceTokens.size : 0;
    const brandBoost = brand && result.title.toLowerCase().includes(brand) ? 0.25 : 0;
    const categoryBoost = categoryTokens.some((t) => resultTokens.has(t)) ? 0.1 : 0;
    const richnessBoost = (result.imageUrl ? 0.04 : 0) + (result.price !== null ? 0.04 : 0);
    const rawScore = 0.12 + overlapRatio * 0.55 + brandBoost + categoryBoost + richnessBoost;

    scores[result.id] = clamp(rawScore, 0, 0.95);
  }

  return scores;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Strip common tracking params
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "tag", "linkCode", "linkId", "pf_rd_p", "pf_rd_r",
      "gclid", "fbclid", "msclkid",
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }
    // Normalize: lowercase host, remove trailing slash
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
  } catch {
    return url.toLowerCase();
  }
}

function titleSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();

  const na = normalize(a);
  const nb = normalize(b);

  if (na === nb) return 1;

  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);

  if (union.size === 0) return 0;
  return intersection.size / union.size; // Jaccard similarity
}

function resultRichness(r: SearchResult): number {
  let score = 0;
  if (r.price !== null) score += 2;
  if (r.imageUrl) score += 2;
  if (r.snippet) score += 1;
  if (r.structuredData?.rating) score += 1;
  return score;
}

function scoreToConfidence(score: number): "high" | "medium" | "low" {
  if (score >= CONFIDENCE_THRESHOLDS.high) return "high";
  if (score >= CONFIDENCE_THRESHOLDS.medium) return "medium";
  return "low";
}

function computePriceDelta(
  originalPrice: number | null,
  resultPrice: number | null,
): { priceDelta: number | null; savingsPercent: number | null } {
  if (originalPrice === null || resultPrice === null) {
    return { priceDelta: null, savingsPercent: null };
  }
  const delta = resultPrice - originalPrice;
  const percent = (delta / originalPrice) * 100;
  return { priceDelta: delta, savingsPercent: percent };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
