import type { SearchResult } from "@shopping-assistant/shared";
import { extractMarketplace } from "../utils/marketplace.js";
import { isLikelyTimeoutError } from "../utils/errors.js";
import type { ProviderSearchOutcome } from "./provider-outcome.js";
import { resolveProviderStatus } from "./provider-outcome.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_API_KEY = process.env.BRAVE_API_KEY!;
const PER_QUERY_TIMEOUT_MS = 8_000;

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
  thumbnail?: { src: string };
  product_cluster?: Array<{
    name?: string;
    url?: string;
    price?: string;
    thumbnail?: { src: string };
  }>;
}

interface BraveSearchResponse {
  web?: { results: BraveWebResult[] };
}

export async function searchProducts(queries: string[]): Promise<ProviderSearchOutcome> {
  let idCounter = 0;

  const outcomes = await Promise.allSettled(
    queries.map(async (query) => {
      const url = new URL(BRAVE_API_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", "10");
      url.searchParams.set("result_filter", "web");

      const res = await fetch(url.toString(), {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": BRAVE_API_KEY,
        },
        signal: AbortSignal.timeout(PER_QUERY_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`Brave search failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as BraveSearchResponse;
      const webResults = data.web?.results ?? [];
      const queryResults: SearchResult[] = [];

      for (const item of webResults) {
        if (item.product_cluster?.length) {
          for (const product of item.product_cluster) {
            if (!product.url) continue;
            const parsed = parsePrice(product.price ?? null);
            queryResults.push({
              id: `brave_${idCounter++}`,
              source: "brave",
              title: product.name ?? item.title,
              price: parsed.price,
              currency: parsed.currency,
              imageUrl: product.thumbnail?.src ?? null,
              productUrl: product.url,
              marketplace: extractMarketplace(product.url),
              snippet: item.description ?? null,
              structuredData: null,
              raw: { braveProduct: product, parentResult: item.url },
            });
          }
        }

        const parsed = parsePriceFromSnippets(item);
        queryResults.push({
          id: `brave_${idCounter++}`,
          source: "brave",
          title: item.title,
          price: parsed.price,
          currency: parsed.currency,
          imageUrl: item.thumbnail?.src ?? null,
          productUrl: item.url,
          marketplace: extractMarketplace(item.url),
          snippet: item.description ?? item.extra_snippets?.[0] ?? null,
          structuredData: null,
          raw: { braveWebResult: item },
        });
      }

      return queryResults;
    }),
  );

  const results: SearchResult[] = [];
  let successfulQueries = 0;
  let failedQueries = 0;
  let timedOutQueries = 0;

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome.status === "fulfilled") {
      results.push(...outcome.value);
      successfulQueries++;
    } else {
      console.error(`Brave search error for "${queries[i]}":`, outcome.reason);
      failedQueries++;
      if (isLikelyTimeoutError(outcome.reason)) {
        timedOutQueries++;
      }
    }
  }

  return {
    results,
    status: resolveProviderStatus(successfulQueries, failedQueries, timedOutQueries),
    totalQueries: queries.length,
    successfulQueries,
    failedQueries,
    timedOutQueries,
  };
}

// ── Price parsing helpers ────────────────────────────────────────────────────

export function parsePrice(raw: string | null): { price: number | null; currency: string | null } {
  if (!raw) return { price: null, currency: null };

  // Match patterns like "$29.99", "£15.00", "€42", "USD 29.99"
  const match = raw.match(/([£$€¥])\s*([\d,]+(?:\.\d{1,2})?)/);
  if (match) {
    const currencyMap: Record<string, string | null> = { "$": "USD", "£": "GBP", "€": "EUR", "¥": null };
    return {
      price: parseFloat(match[2].replace(/,/g, "")),
      currency: currencyMap[match[1]] ?? null,
    };
  }

  // Try "USD 29.99" pattern
  const codeMatch = raw.match(/(USD|GBP|EUR|CAD|AUD|CNY|JPY)\s*([\d,]+(?:\.\d{1,2})?)/);
  if (codeMatch) {
    return {
      price: parseFloat(codeMatch[2].replace(/,/g, "")),
      currency: codeMatch[1],
    };
  }

  return { price: null, currency: null };
}

function parsePriceFromSnippets(item: BraveWebResult): { price: number | null; currency: string | null } {
  // Try description first, then extra_snippets
  const texts = [item.description, ...(item.extra_snippets ?? [])].filter(Boolean);
  for (const text of texts) {
    const result = parsePrice(text ?? null);
    if (result.price !== null) return result;
  }
  return { price: null, currency: null };
}

