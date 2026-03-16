import { fetchAndExtractPrice } from "./price-extractor.js";
import { classifyResultUrl } from "./result-validation.js";

/**
 * Detect URLs that are category/search/listing pages rather than product pages.
 * Price extraction on these pages returns misleading prices (random product on page).
 *
 * Delegates to the shared classifyResultUrl() in result-validation.ts — single
 * source of truth for URL classification.
 */
function isNonProductUrl(url: string): boolean {
  const classification = classifyResultUrl(url);
  // "product_detail" → definitely a product, allow
  // "unknown"        → unrecognized pattern, allow (benefit of the doubt)
  // anything else    → search/category/store, skip
  return classification !== "product_detail" && classification !== "unknown";
}

/**
 * Fast HTTP-only price enrichment + dead link detection.
 * Runs in parallel with visual embedding — no Playwright, no Gemini Vision.
 *
 * All paths use GET + stale body detection because sites like Amazon/Lowes
 * return HTTP 200 for unavailable products with "Currently unavailable" text.
 */
export async function quickHttpPriceEnrich(
  results: Array<{
    id: string;
    productUrl: string;
    price: number | null;
    currency: string | null;
    priceSource?: string;
  }>,
  maxPriceResults: number,
): Promise<{
  prices: Map<string, { price: number; currency: string }>;
  deadLinks: Set<string>;
}> {
  const deadLinks = new Set<string>();
  const prices = new Map<string, { price: number; currency: string }>();

  // Price extraction for priceless results via HTTP (no Playwright)
  const priceless = results
    .filter((r) => r.price == null && !isNonProductUrl(r.productUrl))
    .slice(0, maxPriceResults);

  // Liveness check for results with provider-structured prices (product clusters)
  const clusterPriced = results.filter(
    (r) => r.price != null && r.priceSource === "provider_structured",
  );

  // GET liveness + stale check for remaining product_detail results not covered
  // by the priceless or cluster-priced pools above.
  const checkedIds = new Set([
    ...priceless.map((r) => r.id),
    ...clusterPriced.map((r) => r.id),
  ]);
  const unchecked = results.filter(
    (r) => !checkedIds.has(r.id) && !isNonProductUrl(r.productUrl),
  );

  console.log(
    `[quick-enrich] Checking ${priceless.length} priceless + ${clusterPriced.length} cluster-priced + ${unchecked.length} liveness-only results`,
  );

  await Promise.allSettled([
    // GET requests — extract price + check liveness + stale detection
    ...priceless.map(async (r) => {
      const result = await fetchAndExtractPrice(r.productUrl);
      if (result.httpStatus === 404 || result.httpStatus === 410) {
        console.log(
          `[quick-enrich] Dead link (${result.httpStatus}): ${r.productUrl.slice(0, 80)}`,
        );
        deadLinks.add(r.id);
        return;
      }
      if (result.stale) {
        console.log(
          `[quick-enrich] Stale product: ${r.productUrl.slice(0, 80)}`,
        );
        deadLinks.add(r.id);
        return;
      }
      if (result.price != null && result.currency != null) {
        console.log(
          `[quick-enrich] Price found: ${result.currency}${result.price} from ${new URL(r.productUrl).hostname}`,
        );
        prices.set(r.id, { price: result.price, currency: result.currency });
      }
    }),
    // GET requests — liveness + stale detection (cluster-priced).
    // Uses GET (not HEAD) because Amazon/Lowes return 200 for dead products
    // with "Currently unavailable" text that only stale body detection catches.
    ...clusterPriced.map(async (r) => {
      const result = await fetchAndExtractPrice(r.productUrl);
      if (result.httpStatus === 404 || result.httpStatus === 410) {
        console.log(
          `[quick-enrich] Dead link (${result.httpStatus}): ${r.productUrl.slice(0, 80)}`,
        );
        deadLinks.add(r.id);
        return;
      }
      if (result.stale) {
        console.log(
          `[quick-enrich] Stale cluster-priced product: ${r.productUrl.slice(0, 80)}`,
        );
        deadLinks.add(r.id);
      }
    }),
    // GET requests — liveness + stale detection for remaining unchecked results.
    // Uses GET (not HEAD) because some sites (Amazon) return 200 for dead
    // products with "Currently unavailable" text that only stale detection catches.
    ...unchecked.map(async (r) => {
      const result = await fetchAndExtractPrice(r.productUrl);
      if (result.httpStatus === 404 || result.httpStatus === 410) {
        console.log(
          `[quick-enrich] Dead link (${result.httpStatus}): ${r.productUrl.slice(0, 80)}`,
        );
        deadLinks.add(r.id);
        return;
      }
      if (result.stale) {
        console.log(
          `[quick-enrich] Stale product: ${r.productUrl.slice(0, 80)}`,
        );
        deadLinks.add(r.id);
        return;
      }
      // Bonus: if we got a price and the result was priceless, use it
      if (r.price == null && result.price != null && result.currency != null) {
        console.log(
          `[quick-enrich] Bonus price found: ${result.currency}${result.price} from ${new URL(r.productUrl).hostname}`,
        );
        prices.set(r.id, { price: result.price, currency: result.currency });
      }
    }),
  ]);

  console.log(
    `[quick-enrich] Found ${prices.size} prices, ${deadLinks.size} dead links`,
  );
  return { prices, deadLinks };
}

