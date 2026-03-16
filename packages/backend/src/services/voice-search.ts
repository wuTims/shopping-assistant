import type { ProductIdentification, RankedResult, SearchResult } from "@shopping-assistant/shared";
import { searchProducts } from "./brave.js";
import { searchAliExpressSplit } from "./aliexpress.js";
import { mergeAndDedup, heuristicPreSort, diversityCap, buildFallbackScores, applyRanking } from "./ranking.js";
import { annotateResultValidation, isDisplayableCandidate } from "./result-validation.js";
import { quickHttpPriceEnrich } from "./price-fallback.js";
import { generateMarketplaceQueries } from "../utils/marketplace-queries.js";

/**
 * Voice-optimized search pipeline.
 *
 * Reuses existing search/ranking modules but skips image-based steps
 * (no screenshot, no visual ranking, no image search lane).
 */
export async function executeVoiceSearch(
  query: string,
  options?: {
    marketplaceFilter?: string;
    originalPrice?: number;
    originalCurrency?: string;
    sourceUrl?: string;
    sourceMarketplace?: string;
    signal?: AbortSignal;
  },
): Promise<RankedResult[]> {
  const originalPrice = options?.originalPrice ?? null;
  const sourceMarketplace = options?.sourceMarketplace ?? null;
  const sourceUrl = options?.sourceUrl ?? null;
  const signal = options?.signal;

  try {
    // 1. Build synthetic identification from the voice query
    const identification: ProductIdentification = {
      category: query,
      description: query,
      brand: null,
      attributes: { color: null, material: null, style: null, size: null },
      searchQueries: [query],
      estimatedPriceRange: null,
    };

    // 2. Generate marketplace queries
    let marketplaceQueries = generateMarketplaceQueries(query);
    if (options?.marketplaceFilter) {
      const filter = options.marketplaceFilter.toLowerCase();
      marketplaceQueries = marketplaceQueries.filter((q) =>
        q.toLowerCase().includes(filter),
      );
    }
    const allQueries = [query, ...marketplaceQueries];

    // 3. Parallel search (Brave text + AliExpress text)
    if (signal?.aborted) return [];

    const [braveOutcome, aliSplitOutcome] = await Promise.all([
      searchProducts(allQueries),
      searchAliExpressSplit([query], null),
    ]);

    const braveResults: SearchResult[] = braveOutcome.results;
    const aliResults: SearchResult[] = aliSplitOutcome.textOutcome.results;

    // 4. Merge, dedup, validate, filter
    const merged = mergeAndDedup([...braveResults, ...aliResults]);
    const validated = merged.map((r) => annotateResultValidation(r));
    const displayable = validated.filter((r) => isDisplayableCandidate(r));

    // 5. Filter out source product URL
    const withoutSource = sourceUrl
      ? displayable.filter((r) => r.productUrl !== sourceUrl)
      : displayable;

    // 6. Heuristic pre-sort and diversity cap
    const preSorted = heuristicPreSort(withoutSource, identification, originalPrice, sourceMarketplace);
    const capped = diversityCap(preSorted, 15, sourceMarketplace);

    // 7. Price enrichment + dead link removal
    if (signal?.aborted) return [];

    const { prices, deadLinks, unreachable } = await quickHttpPriceEnrich(capped, 10);

    const enriched = capped
      .map((r) => {
        const priceEntry = prices.get(r.id);
        if (priceEntry) {
          return { ...r, price: priceEntry.price, currency: priceEntry.currency, priceSource: "fallback_http" as const };
        }
        return r;
      })
      .filter((r) => !deadLinks.has(r.id))
      .filter((r) => !unreachable.has(r.id));

    // 8. Fallback scoring and ranking
    const scores = buildFallbackScores(enriched, identification, sourceMarketplace, originalPrice);
    const ranked = applyRanking(enriched, scores, originalPrice);

    // 9. Return top 3
    return ranked.slice(0, 3);
  } catch {
    // If aborted or any unexpected error, return empty
    return [];
  }
}
