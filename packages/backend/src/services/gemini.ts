import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "@google/genai";
import type { ProductIdentification, SearchResult } from "@shopping-assistant/shared";
import { extractMarketplace } from "../utils/marketplace.js";
import { isLikelyTimeoutError } from "../utils/errors.js";
import { ai, geminiModel as model } from "./ai-client.js";
import type { ProviderSearchOutcome } from "./provider-outcome.js";
import { resolveProviderStatus } from "./provider-outcome.js";

// ── identifyProduct ──────────────────────────────────────────────────────────

export interface IdentifyProductResult {
  identification: ProductIdentification;
  originalImage: FetchedImage;
}

export async function identifyProduct(
  imageSource: string | FetchedImage,
  title: string | null,
): Promise<IdentifyProductResult> {
  const prompt = [
    "You are a product identification expert for a shopping comparison tool.",
    "Analyze the product image and any provided title.",
    "Identify the product category, brand, key attributes, and generate 2-3 SHOPPING search queries.",
    "Search queries MUST include shopping intent words like 'buy', 'price', 'shop', or 'for sale'.",
    "Queries should find this exact product or very similar alternatives on shopping sites like Amazon, eBay, Walmart, AliExpress.",
    "Example good queries: 'buy Nike Air Max 90 white men', 'Nike Air Max 90 price comparison'",
    title ? `Product title from the page: "${title}"` : "No product title available — rely on the image.",
  ].join("\n");

  const productImage = typeof imageSource === "string"
    ? await fetchImage(imageSource)
    : imageSource;

  const response = await ai.models.generateContent({
    model,
    contents: [
      { inlineData: { mimeType: productImage.mimeType, data: productImage.data } },
      prompt,
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING, description: "Product category" },
          description: { type: Type.STRING, description: "Brief product description" },
          brand: { type: Type.STRING, description: "Brand name if identifiable", nullable: true },
          attributes: {
            type: Type.OBJECT,
            properties: {
              color: { type: Type.STRING, nullable: true },
              material: { type: Type.STRING, nullable: true },
              style: { type: Type.STRING, nullable: true },
              size: { type: Type.STRING, nullable: true },
            },
          },
          searchQueries: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            minItems: 2,
            maxItems: 4,
            description: "2-3 marketplace search queries to find this product",
          },
          estimatedPriceRange: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              low: { type: Type.NUMBER },
              high: { type: Type.NUMBER },
              currency: { type: Type.STRING },
            },
          },
        },
        required: ["category", "description", "searchQueries", "attributes"],
      },
    },
  });

  const identification = JSON.parse(response.text!) as ProductIdentification;
  return { identification, originalImage: productImage };
}

// ── identifyFromScreenshot ───────────────────────────────────────────────

export interface SanitizedImageQueries {
  acceptedQueries: string[];
  rejectedQueries: string[];
}

const LOW_SIGNAL_IMAGE_QUERY_PATTERNS = new Set([
  "tool cart",
  "rolling cart",
  "storage cart",
  "utility cart",
  "metal cart",
]);

export function sanitizeImageSearchQueries(
  rawQueries: string[],
  titleHint: string | null = null,
): SanitizedImageQueries {
  const unique: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const rawQuery of rawQueries) {
    const normalized = rawQuery.trim().replace(/\s+/g, " ");
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isLowSignalImageQuery(normalized)) {
      rejected.push(normalized);
      continue;
    }
    unique.push(normalized);
    if (unique.length >= 5) break;
  }

  if (unique.length > 0) {
    return { acceptedQueries: unique, rejectedQueries: rejected };
  }

  const fallback = buildImageQueryFallback(titleHint);
  return {
    acceptedQueries: fallback ? [fallback] : [],
    rejectedQueries: rejected,
  };
}

export function normalizeImageSearchQueries(rawQueries: string[], titleHint: string | null = null): string[] {
  return sanitizeImageSearchQueries(rawQueries, titleHint).acceptedQueries;
}

export async function generateImageSearchQueries(
  imageSource: string | FetchedImage,
  titleHint: string | null,
): Promise<string[]> {
  const prompt = [
    "You generate image-first shopping search queries for a shopping comparison tool.",
    "Look at the product image first and use any title hint only as secondary context.",
    "Return 3 to 5 concise shopping queries for exact or near-match products.",
    "Queries must stay short, concrete, and suitable for marketplace or image search.",
    "Prefer visible attributes like category, material, color, silhouette, hardware, pattern, and style.",
    titleHint ? `Optional title hint: \"${titleHint}\"` : "No title hint is available.",
  ].join("\n");

  const productImage = typeof imageSource === "string"
    ? await fetchImage(imageSource)
    : imageSource;

  const response = await ai.models.generateContent({
    model,
    contents: [
      { inlineData: { mimeType: productImage.mimeType, data: productImage.data } },
      prompt,
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: Type.OBJECT,
        properties: {
          queries: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            minItems: 3,
            maxItems: 5,
          },
        },
        required: ["queries"],
      },
    },
  });

  const parsed = JSON.parse(response.text ?? "{}") as { queries?: string[] };
  return parsed.queries ?? [];
}

function isLowSignalImageQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (LOW_SIGNAL_IMAGE_QUERY_PATTERNS.has(normalized)) return true;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) return false;
  if (tokens.some((token) => /\d/.test(token) && /[a-z]/i.test(token))) return false;
  return true;
}

function buildImageQueryFallback(titleHint: string | null): string | null {
  const fallback = titleHint
    ?.replace(/\s*[-|]\s*(Amazon|eBay|Walmart|Target|Best Buy|AliExpress).*$/i, "")
    .trim()
    .replace(/\s+/g, " ");
  return fallback ? `buy ${fallback}` : null;
}

export async function identifyFromScreenshot(
  screenshotBase64: string,
): Promise<{ products: Array<{ name: string; price: number | null; currency: string | null; boundingBox: { x: number; y: number; width: number; height: number } | null }>; pageType: "product_detail" | "product_listing" | "unknown" }> {
  const prompt = `You are analyzing a screenshot of a web page. Identify all products visible in this screenshot.

For each product, extract:
- name: the product name/title
- price: the CURRENT selling price as a number. If multiple prices are shown (e.g. a strikethrough original price and a sale price), always use the LOWEST/SALE price that the customer would actually pay. Ignore "was" prices, "list" prices, or crossed-out prices. Return null only if no price is visible at all.
- currency: the currency code (USD, GBP, EUR, CNY, etc.) or null
- boundingBox: approximate pixel coordinates {x, y, width, height} of the product in the image, or null if unclear

Also determine the page type:
- "product_detail" if this is a single product page (one main product)
- "product_listing" if this shows multiple products (search results, category page)
- "unknown" if uncertain

Return JSON only.`;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "image/png", data: screenshotBase64 } },
          { text: prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object" as const,
        properties: {
          products: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                name: { type: "string" as const },
                price: { type: "number" as const, nullable: true },
                currency: { type: "string" as const, nullable: true },
                boundingBox: {
                  type: "object" as const,
                  nullable: true,
                  properties: {
                    x: { type: "number" as const },
                    y: { type: "number" as const },
                    width: { type: "number" as const },
                    height: { type: "number" as const },
                  },
                  required: ["x", "y", "width", "height"],
                },
              },
              required: ["name", "price", "currency", "boundingBox"],
            },
          },
          pageType: {
            type: "string" as const,
            enum: ["product_detail", "product_listing", "unknown"],
          },
        },
        required: ["products", "pageType"],
      },
    },
  });

  const text = response.text ?? "{}";
  return JSON.parse(text);
}

// ── groundedSearch ───────────────────────────────────────────────────────────

export async function groundedSearch(queries: string[]): Promise<ProviderSearchOutcome> {
  let idCounter = 0;

  const outcomes = await Promise.allSettled(
    queries.map(async (query) => {
      const response = await ai.models.generateContent({
        model,
        contents: `Find shopping results for: ${query}. List products with their titles, prices, URLs, and image URLs.`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const metadata = response.candidates?.[0]?.groundingMetadata;
      const chunks = metadata?.groundingChunks ?? [];
      const queryResults: SearchResult[] = [];

      for (const chunk of chunks) {
        if (!chunk.web?.uri) continue;

        const uri = chunk.web.uri;
        const title = chunk.web.title ?? query;
        const id = `gemini_${idCounter++}`;

        queryResults.push({
          id,
          source: "gemini_grounding",
          title,
          price: null,
          currency: null,
          imageUrl: null,
          productUrl: uri,
          marketplace: extractMarketplace(uri),
          snippet: null,
          structuredData: null,
          raw: { groundingChunk: chunk },
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
      console.error(`Gemini grounded search failed for query "${queries[i]}":`, outcome.reason);
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

// ── Helpers ──────────────────────────────────────────────────────────────────

export interface FetchedImage {
  data: string;
  mimeType: string;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const IMAGE_FETCH_TIMEOUT_MS = 8_000;

const PRIVATE_IP_PATTERNS = [
  // IPv4 private/reserved
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^0\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // IPv6 loopback, link-local, ULA (fc00::/7 covers both fc and fd)
  // Only match actual IPv6 addresses (must contain ':') to avoid blocking
  // public hostnames like fd-example.com
  /^::1$/, /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, /^fe80:/,
  // IPv4-mapped IPv6 with private IPv4
  /^::ffff:(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/,
];

const MAX_REDIRECTS = 5;

function assertIsPrivateIp(ip: string): void {
  if (ip === "localhost" || PRIVATE_IP_PATTERNS.some((p) => p.test(ip))) {
    throw new Error(`Blocked request to private/internal address: ${ip}`);
  }
}

function assertNotPrivateHost(urlStr: string): void {
  const parsed = new URL(urlStr);

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Blocked non-HTTP protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || PRIVATE_IP_PATTERNS.some((p) => p.test(host))) {
    throw new Error(`Blocked request to private/internal host: ${host}`);
  }
}

/** Resolve hostname and verify the IP is not private/internal. */
async function assertResolvedAddressPublic(urlStr: string): Promise<void> {
  const { hostname } = new URL(urlStr);
  const host = hostname.replace(/^\[|\]$/g, "");

  // If host is already an IP literal, the hostname check in assertNotPrivateHost
  // already covers it. For domain names, resolve and check the IP.
  if (isIP(host) !== 0) return;

  const { address } = await lookup(host);
  assertIsPrivateIp(address);
}

export async function fetchImage(url: string, timeoutMs = IMAGE_FETCH_TIMEOUT_MS): Promise<FetchedImage> {
  assertNotPrivateHost(url);
  await assertResolvedAddressPublic(url);

  // Follow redirects manually so we can validate each hop
  let currentUrl = url;
  let res: Response | undefined;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    res = await fetch(currentUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Redirect with no Location header from ${currentUrl}`);
      currentUrl = new URL(location, currentUrl).toString();
      assertNotPrivateHost(currentUrl);
      await assertResolvedAddressPublic(currentUrl);
      continue;
    }
    break;
  }

  if (!res || (res.status >= 300 && res.status < 400)) {
    throw new Error(`Too many redirects fetching image: ${url}`);
  }
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${url}`);

  // Size cap check via Content-Length (fast reject before reading body)
  const contentLength = res.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large: ${contentLength} bytes (max ${MAX_IMAGE_BYTES})`);
  }

  // Stream body with incremental size check to avoid buffering oversized chunked responses
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`No response body for image: ${url}`);

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_IMAGE_BYTES) {
      reader.cancel();
      throw new Error(`Image too large: exceeded ${MAX_IMAGE_BYTES} bytes (max) while streaming`);
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks);

  // Derive MIME type from Content-Type header, fall back to sniffing magic bytes
  const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
  const mimeType = contentType && contentType.startsWith("image/")
    ? contentType
    : sniffImageMime(buffer);

  return { data: buffer.toString("base64"), mimeType };
}

function sniffImageMime(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString() === "PNG") return "image/png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  return "image/jpeg"; // last resort
}


