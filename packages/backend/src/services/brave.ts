import { randomUUID } from "node:crypto";
import type { SearchResult } from "@shopping-assistant/shared";
import { extractMarketplace, isKnownMarketplaceDomain } from "../utils/marketplace.js";
import { isLikelyTimeoutError } from "../utils/errors.js";
import type { ProviderSearchOutcome } from "./provider-outcome.js";
import { resolveProviderStatus } from "./provider-outcome.js";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const BRAVE_IMAGE_API_URL = "https://api.search.brave.com/res/v1/images/search";
const BRAVE_API_KEY = process.env.BRAVE_API_KEY!;
const PER_QUERY_TIMEOUT_MS = 8_000;

/** Check if a URL belongs to a known shopping marketplace using the shared domain list. */
function isShoppingDomain(url: string): boolean {
  return isKnownMarketplaceDomain(url);
}

const GENERIC_LISTING_PATH_PATTERNS = [
  /^\/search(?:\/|$)/i,
  /^\/browse(?:\/|$)/i,
  /^\/c(?:\/|$)/i,
  /^\/b(?:\/|$)/i,
  /^\/shop(?:\/|$)/i,
  /^\/collections?(?:\/|$)/i,
  /^\/category(?:\/|$)/i,
];

const PRODUCT_DETAIL_PATH_PATTERNS: Array<{ host: RegExp; path: RegExp }> = [
  { host: /(^|\.)walmart\.com$/i, path: /^\/ip(?:\/|$)/i },
  { host: /(^|\.)amazon\./i, path: /^\/(?:dp|gp\/product)(?:\/|$)/i },
  { host: /(^|\.)ebay\./i, path: /^\/itm(?:\/|$)/i },
  { host: /(^|\.)target\.com$/i, path: /^\/p\/(?:-|$)/i },
  { host: /(^|\.)bestbuy\.com$/i, path: /^\/site\/(?!searchpage)/i },
  { host: /(^|\.)homedepot\.com$/i, path: /^\/p\/(?:-|$)/i },
  { host: /(^|\.)lowes\.com$/i, path: /^\/pd\/(?:-|$)/i },
  { host: /(^|\.)etsy\.com$/i, path: /^\/listing\/\d+/i },
  { host: /(^|\.)aliexpress\.com$/i, path: /^\/item\/(?:-|$|[\w-]+\.html)/i },
];

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
      const productClusterCount = webResults.filter((r) => r.product_cluster?.length).length;
      const shoppingDomainCount = webResults.filter((r) => !r.product_cluster?.length && isShoppingDomain(r.url)).length;
      console.log(`[brave] Query "${query.slice(0, 80)}": ${webResults.length} web results, ${productClusterCount} with product clusters, ${shoppingDomainCount} shopping domain hits`);

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
              priceSource: parsed.price !== null ? "provider_structured" : "none",
              imageUrl: product.thumbnail?.src ?? null,
              productUrl: product.url,
              marketplace: extractMarketplace(product.url),
              snippet: item.description ?? null,
              structuredData: null,
              raw: { braveProduct: product, parentResult: item.url },
            });
          }
        }

        // Add the web result itself only if it's from a shopping domain and NOT already
        // represented by product_cluster entries (which have structured prices and direct URLs).
        // The parent URL for clustered results is typically a search/category page with no price.
        const isShoppingSite = isShoppingDomain(item.url);
        if (!item.product_cluster?.length && isShoppingSite && isLikelyProductDetailUrl(item.url)) {
          const parsed = parsePriceFromSnippets(item);
          queryResults.push({
            id: `brave_${idCounter++}`,
            source: "brave",
            title: item.title,
            price: parsed.price,
            currency: parsed.currency,
            priceSource: parsed.price !== null ? "provider_snippet" : "none",
            imageUrl: item.thumbnail?.src ?? null,
            productUrl: item.url,
            marketplace: extractMarketplace(item.url),
            snippet: item.description ?? item.extra_snippets?.[0] ?? null,
            structuredData: null,
            raw: { braveWebResult: item },
          });
        }
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

export function isLikelyProductDetailUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, "");
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";

    for (const { host, path } of PRODUCT_DETAIL_PATH_PATTERNS) {
      if (host.test(hostname)) {
        return path.test(pathname);
      }
    }

    if (parsed.searchParams.has("q") || parsed.searchParams.has("query")) {
      return false;
    }

    return !GENERIC_LISTING_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
  } catch {
    return false;
  }
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

// ── Brave Image Search ──────────────────────────────────────────────────────

interface BraveImageResult {
  url: string;
  title: string;
  properties?: { url?: string; placeholder?: string };
  thumbnail?: { src: string };
}

interface BraveImageSearchResponse {
  results?: BraveImageResult[];
}

export function normalizeBraveImageResults(data: unknown): SearchResult[] {
  const root = data as BraveImageSearchResponse | null;
  const items = root?.results;
  if (!items || !Array.isArray(items) || items.length === 0) return [];

  const results: SearchResult[] = [];
  for (const item of items) {
    if (!item.url || !isShoppingDomain(item.url)) continue;

    const parsed = parsePrice(item.title ?? null);
    results.push({
      id: `brave_img_${randomUUID().slice(0, 8)}`,
      source: "brave",
      title: item.title ?? "",
      price: parsed.price,
      currency: parsed.currency,
      priceSource: parsed.price !== null ? "provider_snippet" : "none",
      imageUrl: item.thumbnail?.src ?? item.properties?.placeholder ?? item.properties?.url ?? null,
      productUrl: item.url,
      marketplace: extractMarketplace(item.url),
      snippet: null,
      structuredData: null,
      raw: { braveImageResult: item },
    });
  }
  return results;
}

export async function searchImages(queries: string[]): Promise<ProviderSearchOutcome> {
  const outcomes = await Promise.allSettled(
    queries.map(async (query) => {
      const url = new URL(BRAVE_IMAGE_API_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("count", "20");
      url.searchParams.set("safesearch", "strict");
      url.searchParams.set("search_lang", "en");
      url.searchParams.set("country", "US");

      const res = await fetch(url.toString(), {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": BRAVE_API_KEY,
        },
        signal: AbortSignal.timeout(PER_QUERY_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`Brave image search failed: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      const imageResults = normalizeBraveImageResults(data);
      console.log(`[brave-img] Query "${query.slice(0, 80)}": ${(data as BraveImageSearchResponse).results?.length ?? 0} raw images, ${imageResults.length} shopping domain hits`);
      return imageResults;
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
      console.error(`[brave-img] Error for "${queries[i]}":`, outcome.reason);
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
