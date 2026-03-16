import { createHmac, randomUUID } from "node:crypto";
import type { SearchResult } from "@shopping-assistant/shared";
import type { FetchedImage } from "./gemini.js";
import type { ProviderSearchOutcome, SplitProviderSearchOutcome } from "./provider-outcome.js";
import { resolveProviderStatus } from "./provider-outcome.js";
import { isLikelyTimeoutError } from "../utils/errors.js";

const BASE_URL = "https://api-sg.aliexpress.com/sync";
const APP_KEY = process.env.ALIEXPRESS_APP_KEY ?? "";
const APP_SECRET = process.env.ALIEXPRESS_API_KEY ?? "";
const PER_QUERY_TIMEOUT_MS = 8_000;

// Token state — bootstrap from env, refresh via setAccessToken()
let accessToken = process.env.ALIEXPRESS_ACCESS_TOKEN ?? "";
let tokenExpiry = Number(process.env.ALIEXPRESS_TOKEN_EXPIRY) || 0;

export function setAccessToken(token: string, expiresInSeconds: number): void {
  accessToken = token;
  tokenExpiry = Date.now() + expiresInSeconds * 1000;
}

export function hasValidToken(): boolean {
  return accessToken !== "" && Date.now() < tokenExpiry;
}

export function getAccessToken(): string {
  return accessToken;
}

// ── Request Signing (TOP API) ────────────────────────────────────────────────

interface SigningOverrides {
  appKey: string;
  appSecret: string;
  accessToken: string;
  _timestamp?: string; // for deterministic tests
}

export function buildSignedParams(
  method: string,
  extraParams: Record<string, string>,
  overrides?: SigningOverrides,
): Record<string, string> {
  const appKey = overrides?.appKey ?? APP_KEY;
  const secret = overrides?.appSecret ?? APP_SECRET;
  const session = overrides?.accessToken ?? accessToken;

  const params: Record<string, string> = {
    app_key: appKey,
    sign_method: "sha256",
    timestamp: overrides?._timestamp ?? Date.now().toString(),
    session,
    method,
    format: "json",
    v: "2.0",
    ...extraParams,
  };

  // TOP API signing: HMAC-SHA256(secret, sorted param pairs) — no path prefix
  const sortedKeys = Object.keys(params).sort();
  const signString = sortedKeys.map((k) => k + params[k]).join("");
  const sign = createHmac("sha256", secret)
    .update(signString)
    .digest("hex")
    .toUpperCase();

  params.sign = sign;
  return params;
}

function buildQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

// ── Text Search ──────────────────────────────────────────────────────────────

export async function textSearch(
  keyword: string,
  options: { pageSize?: number; sort?: string } = {},
): Promise<SearchResult[]> {
  const params = buildSignedParams("aliexpress.ds.text.search", {
    keyword,
    countryCode: "US",
    currency: "USD",
    local: "en_US",
    page_size: String(options.pageSize ?? 10),
    ...(options.sort ? { sort: options.sort } : {}),
  });

  const res = await fetch(`${BASE_URL}?${buildQueryString(params)}`, {
    signal: AbortSignal.timeout(PER_QUERY_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`AliExpress text search failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return normalizeTextSearchResults(data);
}

// ── Image Search ─────────────────────────────────────────────────────────────

export async function imageSearch(
  image: FetchedImage,
  options: { productCount?: number } = {},
): Promise<SearchResult[]> {
  const params = buildSignedParams("aliexpress.ds.image.search", {
    target_currency: "USD",
    target_language: "EN",
    shpt_to: "US",
    product_cnt: String(options.productCount ?? 10),
  });

  // Image search requires multipart upload
  const imageBuffer = Buffer.from(image.data, "base64");
  const boundary = "----FormBoundary" + randomUUID();
  let textParts = "";
  for (const [k, v] of Object.entries(params)) {
    textParts += `--${boundary}\r\n`;
    textParts += `Content-Disposition: form-data; name="${k}"\r\n\r\n`;
    textParts += `${v}\r\n`;
  }
  textParts += `--${boundary}\r\n`;
  textParts += `Content-Disposition: form-data; name="image_file_bytes"; filename="image.jpg"\r\n`;
  textParts += `Content-Type: ${image.mimeType}\r\n\r\n`;

  const bodyBuffer = Buffer.concat([
    Buffer.from(textParts),
    imageBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: bodyBuffer,
    signal: AbortSignal.timeout(PER_QUERY_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`AliExpress image search failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return normalizeImageSearchResults(data);
}

// ── Combined Search (for pipeline integration) ──────────────────────────────

export async function searchAliExpress(
  queries: string[],
  image: FetchedImage | null,
): Promise<ProviderSearchOutcome> {
  const outcomes = await searchAliExpressSplit(queries, image);
  return outcomes.combinedOutcome;
}

export async function searchAliExpressSplit(
  queries: string[],
  image: FetchedImage | null,
): Promise<SplitProviderSearchOutcome> {
  if (!hasValidToken()) {
    const hasKey = APP_KEY !== "";
    const hasSecret = APP_SECRET !== "";
    const hasToken = accessToken !== "";
    const expired = accessToken !== "" && Date.now() >= tokenExpiry;
    console.warn(
      `[aliexpress] No valid token — skipping AliExpress search. ` +
      `APP_KEY=${hasKey ? "set" : "MISSING"}, APP_SECRET=${hasSecret ? "set" : "MISSING"}, ` +
      `ACCESS_TOKEN=${hasToken ? (expired ? "EXPIRED" : "set") : "MISSING"}` +
      (expired ? `, expired ${Math.round((Date.now() - tokenExpiry) / 1000)}s ago` : ""),
    );
    return {
      textOutcome: emptyProviderOutcome(),
      imageOutcome: emptyProviderOutcome(),
      combinedOutcome: emptyProviderOutcome(),
    };
  }

  const textCount = queries.length;
  const imageCount = image ? 1 : 0;
  console.log(`[aliexpress] Starting search: ${textCount} text queries + ${imageCount} image search`);
  for (const q of queries) {
    console.log(`[aliexpress]   Text query: "${q.slice(0, 100)}"`);
  }

  const textPromises: Promise<SearchResult[]>[] = [];

  // Text searches
  for (const query of queries) {
    textPromises.push(textSearch(query));
  }

  // Image search (if image available)
  const imagePromises = image ? [imageSearch(image)] : [];

  const [textOutcomes, imageOutcomes] = await Promise.all([
    Promise.allSettled(textPromises),
    Promise.allSettled(imagePromises),
  ]);

  const textOutcome = collectOutcomeResults(
    textOutcomes,
    queries.map((query) => `text("${query.slice(0, 60)}")`),
  );
  const imageOutcome = collectOutcomeResults(
    imageOutcomes,
    image ? ["image"] : [],
  );

  console.log(
    `[aliexpress] Total: ${textOutcome.results.length + imageOutcome.results.length} results ` +
    `(${textOutcome.successfulQueries + imageOutcome.successfulQueries} succeeded, ` +
    `${textOutcome.failedQueries + imageOutcome.failedQueries} failed)`,
  );

  return {
    textOutcome,
    imageOutcome,
    combinedOutcome: combineProviderOutcomes(textOutcome, imageOutcome),
  };
}

function collectOutcomeResults(
  outcomes: PromiseSettledResult<SearchResult[]>[],
  labels: string[],
): ProviderSearchOutcome {
  const results: SearchResult[] = [];
  let successfulQueries = 0;
  let failedQueries = 0;
  let timedOutQueries = 0;

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const queryType = labels[i] ?? `query_${i}`;
    if (outcome.status === "fulfilled") {
      console.log(`[aliexpress] ${queryType}: ${outcome.value.length} results`);
      results.push(...outcome.value);
      successfulQueries++;
    } else {
      console.error(`[aliexpress] ${queryType} failed:`, outcome.reason);
      failedQueries++;
      if (isLikelyTimeoutError(outcome.reason)) {
        timedOutQueries++;
      }
    }
  }

  return {
    results,
    status: resolveProviderStatus(successfulQueries, failedQueries, timedOutQueries),
    totalQueries: outcomes.length,
    successfulQueries,
    failedQueries,
    timedOutQueries,
  };
}

function combineProviderOutcomes(a: ProviderSearchOutcome, b: ProviderSearchOutcome): ProviderSearchOutcome {
  return {
    results: [...a.results, ...b.results],
    status: resolveProviderStatus(
      a.successfulQueries + b.successfulQueries,
      a.failedQueries + b.failedQueries,
      a.timedOutQueries + b.timedOutQueries,
    ),
    totalQueries: a.totalQueries + b.totalQueries,
    successfulQueries: a.successfulQueries + b.successfulQueries,
    failedQueries: a.failedQueries + b.failedQueries,
    timedOutQueries: a.timedOutQueries + b.timedOutQueries,
  };
}

function emptyProviderOutcome(): ProviderSearchOutcome {
  return {
    results: [],
    status: "ok",
    totalQueries: 0,
    successfulQueries: 0,
    failedQueries: 0,
    timedOutQueries: 0,
  };
}

// ── Response Normalization ───────────────────────────────────────────────────

// No module-level counter — use randomUUID per result for unique IDs

function prependHttps(url: string): string {
  if (url.startsWith("//")) return `https:${url}`;
  if (!url.startsWith("http")) return `https://${url}`;
  return url;
}

export function normalizeTextSearchResults(data: unknown): SearchResult[] {
  const root = data as Record<string, unknown> | null;
  const response = root?.["aliexpress_ds_text_search_response"] as Record<string, unknown> | undefined;
  const responseData = response?.["data"] as Record<string, unknown> | undefined;
  const products = responseData?.["products"] as Record<string, unknown> | undefined;
  const items = products?.["selection_search_product"] as Array<Record<string, unknown>> | undefined;

  if (!items || !Array.isArray(items)) return [];

  return items.map((item) => {
    const price = typeof item.targetSalePrice === "string"
      ? parseFloat(item.targetSalePrice)
      : null;

    return {
      id: `ali_${randomUUID().slice(0, 8)}`,
      source: "aliexpress" as const,
      title: String(item.title ?? ""),
      price: price !== null && !isNaN(price) ? price : null,
      currency: typeof item.targetOriginalPriceCurrency === "string"
        ? item.targetOriginalPriceCurrency
        : "USD",
      priceSource: price !== null && !isNaN(price) ? "provider_structured" : "none",
      imageUrl: item.itemMainPic ? prependHttps(String(item.itemMainPic)) : null,
      productUrl: item.itemUrl ? prependHttps(String(item.itemUrl)) : "",
      marketplace: "AliExpress",
      snippet: null,
      structuredData: {
        brand: null,
        availability: null,
        rating: typeof item.score === "string" ? parseFloat(item.score) || null : null,
        reviewCount: null,
      },
      raw: { aliexpressProduct: item },
    };
  });
}

export function normalizeImageSearchResults(data: unknown): SearchResult[] {
  const root = data as Record<string, unknown> | null;
  const response = root?.["aliexpress_ds_image_search_response"] as Record<string, unknown> | undefined;
  const responseData = response?.["data"] as Record<string, unknown> | undefined;
  const products = responseData?.["products"] as Record<string, unknown> | undefined;
  const items = products?.["traffic_image_product_d_t_o"] as Array<Record<string, unknown>> | undefined;

  if (!items || !Array.isArray(items)) return [];

  return items.map((item) => {
    const price = typeof item.target_sale_price === "string"
      ? parseFloat(item.target_sale_price)
      : null;

    return {
      id: `ali_img_${randomUUID().slice(0, 8)}`,
      source: "aliexpress" as const,
      title: String(item.product_title ?? ""),
      price: price !== null && !isNaN(price) ? price : null,
      currency: typeof item.target_sale_price_currency === "string"
        ? item.target_sale_price_currency
        : "USD",
      priceSource: price !== null && !isNaN(price) ? "provider_structured" : "none",
      imageUrl: typeof item.product_main_image_url === "string"
        ? item.product_main_image_url
        : null,
      productUrl: typeof item.product_detail_url === "string"
        ? item.product_detail_url
        : "",
      marketplace: "AliExpress",
      snippet: null,
      structuredData: {
        brand: null,
        availability: null,
        rating: null,
        reviewCount: null,
      },
      raw: { aliexpressImageProduct: item },
    };
  });
}
