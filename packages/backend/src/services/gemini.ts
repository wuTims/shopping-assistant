import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Type } from "@google/genai";
import type { ProductIdentification, SearchResult } from "@shopping-assistant/shared";
import { extractMarketplace } from "../utils/marketplace.js";
import { isLikelyTimeoutError } from "../utils/errors.js";
import { ai, geminiModel as model } from "./ai-client.js";
import type { ProviderSearchOutcome } from "./provider-outcome.js";
import { resolveProviderStatus } from "./provider-outcome.js";

export class RankingOutputValidationError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "RankingOutputValidationError";
    this.details = details;
  }
}

// ── identifyProduct ──────────────────────────────────────────────────────────

export interface IdentifyProductResult {
  identification: ProductIdentification;
  originalImage: FetchedImage;
}

export async function identifyProduct(
  imageUrl: string,
  title: string | null,
): Promise<IdentifyProductResult> {
  const prompt = [
    "You are a product identification expert.",
    "Analyze the product image and any provided title.",
    "Identify the product category, brand, key attributes, and generate 2-3 marketplace search queries.",
    "Search queries should be specific enough to find this exact product or very similar alternatives on shopping sites.",
    title ? `Product title from the page: "${title}"` : "No product title available — rely on the image.",
  ].join("\n");

  const productImage = await fetchImage(imageUrl);

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

// ── rankResults ──────────────────────────────────────────────────────────────

export interface RankResultsInput {
  originalImage: FetchedImage;
  results: SearchResult[];
  resultImages: Map<string, FetchedImage>;
  identification: ProductIdentification;
}

export async function rankResults(input: RankResultsInput): Promise<Record<string, number>> {
  const { originalImage, results, resultImages, identification } = input;
  if (results.length === 0) return {};
  const resultIds = results.map((r) => r.id);

  // Build content parts: original image + text descriptions of results (with images when available)
  const contentParts: Array<
    string | { inlineData: { mimeType: string; data: string } }
  > = [];

  contentParts.push({
    inlineData: originalImage,
  });

  // Add result images inline
  const resultIdsWithImages = new Set<string>();
  for (const [id, img] of resultImages) {
    contentParts.push({
      inlineData: { mimeType: img.mimeType, data: img.data },
    });
    resultIdsWithImages.add(id);
  }

  // Build descriptions
  const resultDescriptions: string[] = [];
  for (const r of results) {
    const hasImage = resultIdsWithImages.has(r.id);
    const imageNote = hasImage
      ? "(image provided above for visual comparison)"
      : "(no image available — rank based on text similarity only)";

    resultDescriptions.push(
      `Result ${r.id}: "${r.title}" from ${r.marketplace}${r.price !== null ? ` — ${r.currency ?? "$"}${r.price}` : ""} ${imageNote}`,
    );
  }

  const prompt = [
    "You are a product comparison expert.",
    `Original product: ${identification.description} (category: ${identification.category}, brand: ${identification.brand ?? "unknown"})`,
    "The first image above is the original product. Any subsequent images are search results.",
    "",
    "Search results to rank:",
    ...resultDescriptions,
    "",
    "Score each result from 0.0 to 1.0 based on how well it matches the original product.",
    "Consider visual similarity (when images available), title relevance, brand match, and category match.",
    "Return a JSON object mapping result IDs to scores.",
  ].join("\n");

  contentParts.push(prompt);

  const response = await ai.models.generateContent({
    model,
    contents: contentParts,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: Type.OBJECT,
        description: "Map of result IDs to confidence scores (0.0 to 1.0)",
        properties: Object.fromEntries(
          resultIds.map((id) => [id, { type: Type.NUMBER }]),
        ),
        required: resultIds,
      },
    },
  });

  return parseAndValidateScores(response.text, resultIds);
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

function parseAndValidateScores(
  rawResponse: string | undefined,
  expectedIds: string[],
): Record<string, number> {
  if (!rawResponse || rawResponse.trim().length === 0) {
    throw new RankingOutputValidationError("Ranking model returned an empty response body.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch (err) {
    throw new RankingOutputValidationError("Ranking model returned invalid JSON.", [String(err)]);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RankingOutputValidationError("Ranking response is not a JSON object.");
  }

  const scoreMap = parsed as Record<string, unknown>;
  const expected = new Set(expectedIds);
  const missing: string[] = [];
  const invalid: string[] = [];
  const extra = Object.keys(scoreMap).filter((key) => !expected.has(key));
  const validatedScores: Record<string, number> = {};

  for (const id of expectedIds) {
    if (!(id in scoreMap)) {
      missing.push(id);
      continue;
    }

    const value = scoreMap[id];
    if (
      typeof value !== "number" ||
      Number.isNaN(value) ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      invalid.push(`${id}:${String(value)}`);
      continue;
    }

    validatedScores[id] = value;
  }

  if (missing.length > 0 || invalid.length > 0 || extra.length > 0) {
    const details: string[] = [];
    if (missing.length > 0) details.push(`missing IDs: ${missing.join(", ")}`);
    if (invalid.length > 0) details.push(`invalid scores: ${invalid.join(", ")}`);
    if (extra.length > 0) details.push(`unexpected IDs: ${extra.join(", ")}`);
    throw new RankingOutputValidationError("Ranking response failed score-map validation.", details);
  }

  return validatedScores;
}

