import type { MatchedQuery, ProductIdentification, SearchResult, RankedResult } from "@shopping-assistant/shared";
import { CONFIDENCE_THRESHOLDS, MIN_CONFIDENCE_SCORE, MIN_DISPLAY_RESULTS, SOURCE_MARKETPLACE_PENALTY, MAX_SOURCE_MARKETPLACE_RESULTS } from "@shopping-assistant/shared";

// ── mergeAndDedup ────────────────────────────────────────────────────────────

export function mergeAndDedup(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();
  let urlDedups = 0;
  let titleDedups = 0;

  for (const result of results) {
    const normalizedUrl = normalizeUrl(result.productUrl);

    // URL-based dedup: keep the result with more data
    if (seen.has(normalizedUrl)) {
      const existing = seen.get(normalizedUrl)!;
      urlDedups++;
      if (resultRichness(result) > resultRichness(existing)) {
        seen.set(normalizedUrl, mergeRetrievalLane(result, existing));
      } else {
        seen.set(normalizedUrl, mergeRetrievalLane(existing, result));
      }
      continue;
    }

    // Title-similarity dedup: check if a very similar title already exists
    let isDuplicate = false;
    for (const [, existing] of seen) {
      const sim = titleSimilarity(result.title, existing.title);
      if (sim > 0.85) {
        titleDedups++;
        console.log(`[dedup] Title match (${sim.toFixed(2)}): "${result.title.slice(0, 50)}" ≈ "${existing.title.slice(0, 50)}"`);
        // Keep the one with more data
        if (resultRichness(result) > resultRichness(existing)) {
          seen.delete(normalizeUrl(existing.productUrl));
          seen.set(normalizedUrl, mergeRetrievalLane(result, existing));
        } else {
          seen.set(normalizeUrl(existing.productUrl), mergeRetrievalLane(existing, result));
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      seen.set(normalizedUrl, result);
    }
  }

  if (urlDedups > 0 || titleDedups > 0) {
    console.log(`[dedup] Removed ${urlDedups} URL dupes + ${titleDedups} title dupes (${results.length} → ${seen.size})`);
  }

  return Array.from(seen.values());
}

// ── applyRanking ─────────────────────────────────────────────────────────────

export function applyRanking(
  results: SearchResult[],
  scores: Record<string, number>,
  originalPrice: number | null,
): RankedResult[] {
  const aboveThreshold: RankedResult[] = [];
  const belowThreshold: RankedResult[] = [];

  for (const result of results) {
    const score = scores[result.id] ?? 0;

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

    const ranked: RankedResult = {
      result,
      confidence,
      confidenceScore: score,
      priceDelta,
      savingsPercent,
      comparisonNotes: notes.join(". "),
      rank: 0, // assigned after sorting
      priceAvailable: result.price != null,
    };

    if (score >= MIN_CONFIDENCE_SCORE) {
      aboveThreshold.push(ranked);
    } else {
      belowThreshold.push(ranked);
    }
  }

  // Sort both buckets by confidence score (desc), then savings (desc)
  const sortFn = (a: RankedResult, b: RankedResult) => {
    if (b.confidenceScore !== a.confidenceScore) {
      return b.confidenceScore - a.confidenceScore;
    }
    const aSavings = a.priceDelta ?? 0;
    const bSavings = b.priceDelta ?? 0;
    return aSavings - bSavings;
  };
  aboveThreshold.sort(sortFn);
  belowThreshold.sort(sortFn);

  // Guarantee at least MIN_DISPLAY_RESULTS by backfilling from below-threshold
  const ranked = [...aboveThreshold];
  if (ranked.length < MIN_DISPLAY_RESULTS && belowThreshold.length > 0) {
    const needed = MIN_DISPLAY_RESULTS - ranked.length;
    ranked.push(...belowThreshold.slice(0, needed));
  }

  // Assign ranks
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].rank = i + 1;
  }

  return ranked;
}

export function buildFallbackScores(
  results: SearchResult[],
  identification: ProductIdentification,
  sourceMarketplace: string | null = null,
): Record<string, number> {
  const scores: Record<string, number> = {};
  const brand = identification.brand?.toLowerCase().trim() ?? null;
  const categoryTokens = tokenize(identification.category);
  const descriptionTokens = tokenize(identification.description);
  const referenceTokens = new Set([...categoryTokens, ...descriptionTokens]);

  console.log(`[text-scoring] Reference tokens (${referenceTokens.size}): ${[...referenceTokens].join(", ")}`);
  if (brand) console.log(`[text-scoring] Brand: "${brand}"`);

  for (const result of results) {
    const titleTokens = tokenize(result.title);
    const marketplaceTokens = tokenize(result.marketplace);
    const resultTokens = new Set([...titleTokens, ...marketplaceTokens]);

    let overlap = 0;
    const matchedTokens: string[] = [];
    for (const token of referenceTokens) {
      if (resultTokens.has(token)) {
        overlap++;
        matchedTokens.push(token);
      }
    }

    const overlapRatio = referenceTokens.size > 0 ? overlap / referenceTokens.size : 0;
    const brandBoost = brand && result.title.toLowerCase().includes(brand) ? 0.25 : 0;
    const categoryBoost = categoryTokens.some((t) => resultTokens.has(t)) ? 0.1 : 0;
    const richnessBoost = (result.imageUrl ? 0.04 : 0) + (result.price !== null ? 0.04 : 0);
    const hybridBoost = result.retrievalLane === "hybrid" ? HYBRID_LANE_BOOST : 0;
    const sourcePenalty =
      sourceMarketplace && baseMarketplace(result.marketplace) === baseMarketplace(sourceMarketplace)
        ? SOURCE_MARKETPLACE_PENALTY
        : 0;
    const rawScore = 0.12 + overlapRatio * 0.55 + brandBoost + categoryBoost + richnessBoost + hybridBoost - sourcePenalty;

    scores[result.id] = clamp(rawScore, 0, 0.95);

    console.log(
      `[text-scoring]   [${result.id}] "${result.title.slice(0, 50)}": ` +
      `overlap=${overlap}/${referenceTokens.size} (${(overlapRatio * 100).toFixed(0)}%) ` +
      `brand=${brandBoost.toFixed(2)} cat=${categoryBoost.toFixed(2)} rich=${richnessBoost.toFixed(2)} hybrid=${hybridBoost.toFixed(2)} ` +
      `src=${sourcePenalty > 0 ? `-${sourcePenalty.toFixed(2)}` : "0.00"} ` +
      `→ ${scores[result.id].toFixed(3)} [${matchedTokens.join(",")}]`,
    );
  }

  return scores;
}

// ── heuristicPreSort ────────────────────────────────────────────────────────

const KNOWN_MARKETPLACES = new Set([
  "Amazon", "eBay", "Walmart", "Target", "Best Buy", "Newegg",
  "B&H Photo", "Costco", "AliExpress", "Etsy",
]);
const HYBRID_LANE_BOOST = 0.05;

export function heuristicPreSort(
  results: SearchResult[],
  identification: ProductIdentification,
  originalPrice: number | null,
  sourceMarketplace: string | null = null,
): SearchResult[] {
  const brand = identification.brand?.toLowerCase().trim() ?? null;
  const categoryTokens = tokenize(identification.category);
  const descriptionTokens = tokenize(identification.description);
  const referenceTokens = new Set([...categoryTokens, ...descriptionTokens]);

  const scored = results.map((r) => {
    const titleTokens = tokenize(r.title);
    const resultTokens = new Set(titleTokens);

    // Title overlap
    let overlap = 0;
    for (const token of referenceTokens) {
      if (resultTokens.has(token)) overlap++;
    }
    const overlapScore = referenceTokens.size > 0 ? overlap / referenceTokens.size : 0;

    // Brand match
    const brandScore = brand && r.title.toLowerCase().includes(brand) ? 0.25 : 0;

    // Has price & image
    const hasPrice = r.price !== null ? 0.1 : 0;
    const hasImage = r.imageUrl ? 0.1 : 0;

    // Price proximity (closer to original price is better)
    let priceProximity = 0;
    if (originalPrice !== null && r.price !== null && originalPrice > 0) {
      const ratio = r.price / originalPrice;
      // Prefer results within 50% of original price
      if (ratio >= 0.3 && ratio <= 2.0) {
        priceProximity = 0.15 * (1 - Math.abs(1 - ratio));
      }
    }

    // Known marketplace boost
    const marketplaceScore = KNOWN_MARKETPLACES.has(r.marketplace) ? 0.05 : 0;
    const hybridBoost = r.retrievalLane === "hybrid" ? HYBRID_LANE_BOOST : 0;

    const sourcePenalty =
      sourceMarketplace && baseMarketplace(r.marketplace) === baseMarketplace(sourceMarketplace)
        ? SOURCE_MARKETPLACE_PENALTY
        : 0;

    const total = overlapScore * 0.4 + brandScore + hasPrice + hasImage + priceProximity + marketplaceScore + hybridBoost - sourcePenalty;
    return { result: r, score: total };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.result);
}

// ── diversityCap ─────────────────────────────────────────────────────────

const MIN_SLOTS_PER_MARKETPLACE = 3;

/**
 * Cap results while preserving marketplace diversity.
 * Reserves up to MIN_SLOTS_PER_MARKETPLACE for each marketplace that has results,
 * then fills remaining slots by heuristic score order.
 */
export function diversityCap(
  preSorted: SearchResult[],
  limit: number,
  sourceMarketplace: string | null = null,
): SearchResult[] {
  const sourceBase = sourceMarketplace ? baseMarketplace(sourceMarketplace) : null;

  // Group by marketplace, preserving pre-sort order within each group
  const byMarketplace = new Map<string, SearchResult[]>();
  for (const r of preSorted) {
    const mp = r.marketplace;
    if (!byMarketplace.has(mp)) byMarketplace.set(mp, []);
    byMarketplace.get(mp)!.push(r);
  }

  const selected: SearchResult[] = [];
  const selectedIds = new Set<string>();

  // First pass: reserve top results from each marketplace
  // Track source marketplace count globally across regional variants (e.g., "Amazon" + "Amazon UK")
  const marketplaceCount = byMarketplace.size;
  const perMarketplace = Math.min(
    MIN_SLOTS_PER_MARKETPLACE,
    Math.floor(limit / marketplaceCount),
  );

  let sourceCount = 0;
  for (const [mp, items] of byMarketplace) {
    const isSource = sourceBase !== null && baseMarketplace(mp) === sourceBase;
    const groupCap = isSource
      ? Math.max(0, Math.min(perMarketplace, MAX_SOURCE_MARKETPLACE_RESULTS - sourceCount))
      : perMarketplace;
    for (const r of items.slice(0, groupCap)) {
      selected.push(r);
      selectedIds.add(r.id);
      if (isSource) sourceCount++;
    }
  }

  // Second pass: fill remaining slots, preferring non-source marketplaces
  for (const r of preSorted) {
    if (selected.length >= limit) break;
    if (selectedIds.has(r.id)) continue;
    const isSource = sourceBase !== null && baseMarketplace(r.marketplace) === sourceBase;
    if (isSource) continue; // skip source marketplace in overflow
    selected.push(r);
    selectedIds.add(r.id);
  }

  // Third pass: if still under limit, allow source marketplace overflow up to cap
  for (const r of preSorted) {
    if (selected.length >= limit) break;
    if (selectedIds.has(r.id)) continue;
    const isSource = sourceBase !== null && baseMarketplace(r.marketplace) === sourceBase;
    if (isSource && sourceCount >= MAX_SOURCE_MARKETPLACE_RESULTS) continue;
    selected.push(r);
    selectedIds.add(r.id);
    if (isSource) sourceCount++;
  }

  return selected;
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

function mergeRetrievalLane(primary: SearchResult, duplicate: SearchResult): SearchResult {
  const primaryLane = primary.retrievalLane;
  const duplicateLane = duplicate.retrievalLane;
  const matchedQueries = mergeMatchedQueries(primary, duplicate);

  if (!primaryLane) {
    return matchedQueries ? { ...primary, matchedQueries } : primary;
  }
  if (!duplicateLane || duplicateLane === primaryLane) {
    return matchedQueries ? { ...primary, matchedQueries } : primary;
  }

  return { ...primary, retrievalLane: "hybrid", ...(matchedQueries ? { matchedQueries } : {}) };
}

function mergeMatchedQueries(primary: SearchResult, duplicate: SearchResult): MatchedQuery[] | undefined {
  const merged = [...(primary.matchedQueries ?? []), ...(duplicate.matchedQueries ?? [])];
  if (merged.length === 0) return undefined;

  const deduped = new Map<string, MatchedQuery>();
  for (const entry of merged) {
    deduped.set(normalizeMatchedQueryKey(entry), entry);
  }
  return Array.from(deduped.values());
}

function normalizeMatchedQueryKey(entry: MatchedQuery): string {
  return `${entry.provider}:${entry.lane}:${entry.query.trim().toLowerCase()}`;
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

/** Normalize marketplace variants to base name (e.g., "Amazon UK" → "Amazon"). */
export function baseMarketplace(name: string): string {
  if (name.startsWith("Amazon")) return "Amazon";
  if (name.startsWith("eBay")) return "eBay";
  return name;
}
