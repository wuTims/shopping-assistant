import { Hono } from "hono";
import type { SearchRequest, SearchResponse, ProductIdentification, SearchResult } from "@shopping-assistant/shared";
import {
  SEARCH_TIMEOUT_MS,
  MAX_RESULTS_FOR_RANKING,
  MAX_PRICE_FALLBACK_RESULTS,
  PRICE_FALLBACK_TIMEOUT_MS,
  EMBEDDING_TIMEOUT_MS,
  MIN_CONFIDENCE_SCORE,
} from "@shopping-assistant/shared";
import {
  identifyProduct,
  generateImageSearchQueries,
  sanitizeImageSearchQueries,
} from "../services/gemini.js";
import type { FetchedImage } from "../services/gemini.js";
import { searchProducts, searchImages } from "../services/brave.js";
import { searchAliExpressSplit } from "../services/aliexpress.js";
import { fillMissingPrices } from "../services/price-fallback.js";
import { generateMarketplaceQueries } from "../utils/marketplace-queries.js";
import { extractMarketplace } from "../utils/marketplace.js";
import type { ProviderSearchOutcome, ProviderStatus } from "../services/provider-outcome.js";
import {
  mergeAndDedup,
  applyRanking,
  buildFallbackScores,
  heuristicPreSort,
  diversityCap,
} from "../services/ranking.js";
import { computeVisualSimilarityScores, blendScores } from "../services/embedding.js";
import {
  annotateResultValidation,
  isDisplayableCandidate,
} from "../services/result-validation.js";

export const searchRoute = new Hono();

searchRoute.post("/", async (c) => {
  let body: SearchRequest;
  try {
    body = await c.req.json<SearchRequest>();
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }

  if (!body.imageUrl && !body.imageBase64) {
    return c.json({ error: "bad_request", message: "imageUrl or imageBase64 is required" }, 400);
  }
  if (body.title !== undefined && body.title !== null && typeof body.title !== "string") {
    return c.json({ error: "bad_request", message: "title must be a string or null" }, 400);
  }
  if (body.price !== undefined && body.price !== null && typeof body.price !== "number") {
    return c.json({ error: "bad_request", message: "price must be a number or null" }, 400);
  }
  if (!body.sourceUrl || typeof body.sourceUrl !== "string") {
    return c.json({ error: "bad_request", message: "sourceUrl is required and must be a string" }, 400);
  }

  const sourceMarketplace = extractMarketplace(body.sourceUrl);

  const requestId = crypto.randomUUID();
  const searchStart = Date.now();
  const remaining = () => SEARCH_TIMEOUT_MS - (Date.now() - searchStart);

  console.log(`[search:${requestId}] Request for: ${body.title ?? body.imageUrl ?? "(base64 image)"}`);
  console.log(`[search:${requestId}] Source URL: ${body.sourceUrl}`);
  console.log(`[search:${requestId}] Source marketplace: ${sourceMarketplace}`);
  console.log(`[search:${requestId}] Has image: base64=${!!body.imageBase64}, url=${!!body.imageUrl}`);
  console.log(`[search:${requestId}] Original price: ${body.price != null ? `${body.currency ?? "USD"}${body.price}` : "not provided"}`);

  // Hard request-level timeout — safety net to prevent unbounded latency
  const abortController = new AbortController();
  const requestTimer = setTimeout(() => abortController.abort(), SEARCH_TIMEOUT_MS);

  try {

  // ── Phase 1: identify product + brave(title queries) in parallel ──────────

  // Prefer base64 when available — server-side fetch of imageUrl often fails
  // (CDN anti-hotlinking, CORS, data: URLs, etc.)
  const imageSource: string | FetchedImage = body.imageBase64
    ? { data: body.imageBase64, mimeType: "image/png" }
    : body.imageUrl!;

  const titleQueries = buildTitleQueries(body.title, body.sourceUrl);
  console.log(`[search:${requestId}] Title queries: ${JSON.stringify(titleQueries)}`);

  // Always kick off title Brave search in parallel
  const titleBravePromise = titleQueries.length > 0
    ? withTimeout(
        searchProviderByQuery(titleQueries, searchProducts, "text", "brave"),
        Math.max(remaining() - 1000, 5000),
      )
    : Promise.resolve(emptyProviderOutcome());

  let identification: ProductIdentification;
  let originalImage: FetchedImage | null = null;

  if (
    body.identification &&
    typeof body.identification.category === "string" &&
    typeof body.identification.description === "string" &&
    Array.isArray(body.identification.searchQueries) &&
    body.identification.searchQueries.length > 0
  ) {
    // Use pre-computed identification from /identify — skip redundant Gemini call
    identification = body.identification;
    if (body.imageBase64) {
      originalImage = { data: body.imageBase64, mimeType: "image/png" };
    }
    console.log(`[search:${requestId}] Using provided identification: ${identification.category} — ${identification.description}`);
  } else {
    // No identification provided — identify from scratch (overlay click path)
    try {
      const result = await identifyProduct(imageSource, body.title);
      identification = result.identification;
      originalImage = result.originalImage;
      console.log(`[search:${requestId}] Identified: ${identification.category} — ${identification.description}`);
    } catch (err) {
      console.error(`[search:${requestId}] Product identification failed:`, err);
      // Suppress the dangling Brave promise so it doesn't consume quota for a failed request
      titleBravePromise.catch(() => {});
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: "product_identification_failed", message, requestId }, 422);
    }
  }

  // Check if request was aborted during Phase 1
  if (abortController.signal.aborted) {
    console.warn(`[search:${requestId}] Aborted after Phase 1 (${Date.now() - searchStart}ms)`);
    titleBravePromise.catch(() => {});
    return c.json({ error: "timeout", message: "Search request timed out", requestId }, 504);
  }

  const titleBraveResult = await titleBravePromise.then(
    (v) => ({ status: "fulfilled" as const, value: v }),
    (e) => ({ status: "rejected" as const, reason: e }),
  );

  const titleBraveOutcome = titleBraveResult.status === "fulfilled"
    ? titleBraveResult.value
    : rejectedProviderOutcome(titleQueries.length, titleBraveResult.reason);

  if (titleBraveResult.status === "rejected") {
    console.error(`[search:${requestId}] Brave (title) failed:`, titleBraveResult.reason);
  }

  // ── Phase 2: parallel search — brave(AI) + brave(marketplace) ────────────
  // NOTE: Gemini Grounding was removed — 100% timeout rate, 0 results returned.
  // Grounding fields kept in response for backward compatibility.

  const aiQueries = identification.searchQueries;
  // Use a concise product name for marketplace queries — the full Gemini
  // description is too verbose (200+ chars) and produces poor results when
  // appended with site:domain operators. AI queries are search-optimized.
  const marketplaceName = (aiQueries[0] || identification.description || body.title || "")
    .replace(/^(buy|shop|purchase|find|get|search\s+for)\s+/i, "")
    .trim()
    .slice(0, 80);
  const marketplaceQueries = generateMarketplaceQueries(marketplaceName);
  const phase2Deadline = Math.max(remaining() - 4000, 3000);

  const skipAiBrave = !hasNewQueries(aiQueries, titleQueries);

  console.log(`[search:${requestId}] AI queries: ${JSON.stringify(aiQueries)}`);
  console.log(`[search:${requestId}] Marketplace queries: ${JSON.stringify(marketplaceQueries)}`);
  console.log(`[search:${requestId}] Skip AI Brave (same as title): ${skipAiBrave}`);

  // Prepare AliExpress search — use AI queries + image for visual search
  const aliExpressImage: FetchedImage | null = body.imageBase64
    ? { data: body.imageBase64, mimeType: "image/png" }
    : originalImage;
  // Use concise AI-generated keywords — the full description is too verbose
  // for AliExpress's text search API and returns irrelevant results.
  const aliExpressQueries = aiQueries.length > 0
    ? aiQueries.slice(0, 2).map((q) =>
        q.replace(/^(buy|shop|purchase|find|get|search\s+for)\s+/i, "").trim(),
      )
    : [identification.category || body.title || ""].filter(Boolean);
  console.log(`[search:${requestId}] AliExpress queries: ${JSON.stringify(aliExpressQueries)}, hasImage: ${!!aliExpressImage}`);

  // Image search queries — use concise AI queries for best image results
  let rawImageSearchQueries: string[] = [];
  let imageSearchQueries: string[] = [];
  let rejectedImageSearchQueries: string[] = [];
  try {
    rawImageSearchQueries = await generateImageSearchQueries(imageSource, body.title);
    const sanitizedImageQueries = sanitizeImageSearchQueries(rawImageSearchQueries, body.title);
    imageSearchQueries = sanitizedImageQueries.acceptedQueries;
    rejectedImageSearchQueries = sanitizedImageQueries.rejectedQueries;
  } catch (err) {
    console.warn(`[search:${requestId}] Gemini image query generation failed:`, err);
  }
  console.log(`[search:${requestId}] Image search queries: ${JSON.stringify(imageSearchQueries)}`);
  if (rejectedImageSearchQueries.length > 0) {
    console.log(`[search:${requestId}] Rejected image queries: ${JSON.stringify(rejectedImageSearchQueries)}`);
  }

  const [aiBraveResult, marketplaceBraveResult, aliExpressTextResult, aliExpressImageResult, imageBraveWebResult, imageBraveResult] =
    await Promise.allSettled([
      skipAiBrave
        ? Promise.resolve(emptyProviderOutcome())
        : withTimeout(searchProviderByQuery(aiQueries, searchProducts, "text", "brave"), phase2Deadline),
      marketplaceQueries.length > 0
        ? withTimeout(searchProviderByQuery(marketplaceQueries, searchProducts, "text", "brave"), phase2Deadline)
        : Promise.resolve(emptyProviderOutcome()),
      aliExpressQueries.length > 0
        ? withTimeout(searchAliExpressTextByQuery(aliExpressQueries), phase2Deadline)
        : Promise.resolve(emptyProviderOutcome()),
      aliExpressImage
        ? withTimeout(searchAliExpressImage(aliExpressImage), phase2Deadline)
        : Promise.resolve(emptyProviderOutcome()),
      imageSearchQueries.length > 0
        ? withTimeout(searchProviderByQuery(imageSearchQueries, searchProducts, "image", "brave"), phase2Deadline)
        : Promise.resolve(emptyProviderOutcome()),
      imageSearchQueries.length > 0
        ? withTimeout(searchProviderByQuery(imageSearchQueries, searchImages, "image", "brave"), phase2Deadline)
        : Promise.resolve(emptyProviderOutcome()),
    ]);

  const aiBraveOutcome = aiBraveResult.status === "fulfilled"
    ? aiBraveResult.value
    : rejectedProviderOutcome(aiQueries.length, aiBraveResult.reason);
  const marketplaceBraveOutcome: ProviderSearchOutcome =
    marketplaceBraveResult.status === "fulfilled"
      ? marketplaceBraveResult.value
      : rejectedProviderOutcome(marketplaceQueries.length, marketplaceBraveResult.reason);

  if (aiBraveResult.status === "rejected") {
    console.error(`[search:${requestId}] Brave (AI) failed:`, aiBraveResult.reason);
  }
  if (marketplaceBraveResult.status === "rejected") {
    console.error(`[search:${requestId}] Brave (marketplace) failed:`, marketplaceBraveResult.reason);
  }

  const aliExpressTextOutcome: ProviderSearchOutcome =
    aliExpressTextResult.status === "fulfilled"
      ? aliExpressTextResult.value
      : rejectedProviderOutcome(aliExpressQueries.length, aliExpressTextResult.reason);

  if (aliExpressTextResult.status === "rejected") {
    console.error(`[search:${requestId}] AliExpress (text) failed:`, aliExpressTextResult.reason);
  }

  const aliExpressImageOutcome: ProviderSearchOutcome =
    aliExpressImageResult.status === "fulfilled"
      ? aliExpressImageResult.value
      : aliExpressImage
        ? rejectedProviderOutcome(1, aliExpressImageResult.reason)
        : emptyProviderOutcome();

  if (aliExpressImageResult.status === "rejected") {
    console.error(`[search:${requestId}] AliExpress (image) failed:`, aliExpressImageResult.reason);
  }

  const imageBraveWebOutcome: ProviderSearchOutcome =
    imageBraveWebResult.status === "fulfilled"
      ? imageBraveWebResult.value
      : rejectedProviderOutcome(imageSearchQueries.length, imageBraveWebResult.reason);

  if (imageBraveWebResult.status === "rejected") {
    console.error(`[search:${requestId}] Brave (image-web) failed:`, imageBraveWebResult.reason);
  }

  const imageBraveOutcome: ProviderSearchOutcome =
    imageBraveResult.status === "fulfilled"
      ? imageBraveResult.value
      : rejectedProviderOutcome(imageSearchQueries.length, imageBraveResult.reason);

  if (imageBraveResult.status === "rejected") {
    console.error(`[search:${requestId}] Brave (image) failed:`, imageBraveResult.reason);
  }

  // Combine brave outcomes
  const titleBraveTagged = titleBraveOutcome;
  const aiBraveTagged = aiBraveOutcome;
  const marketplaceBraveTagged = marketplaceBraveOutcome;
  const imageBraveWebTagged = imageBraveWebOutcome;
  const imageBraveTagged = imageBraveOutcome;
  const aliExpressTextTagged = aliExpressTextOutcome;
  const aliExpressImageTagged = aliExpressImageOutcome;

  const braveOutcome = combineBraveOutcomes(
    combineBraveOutcomes(
      combineBraveOutcomes(titleBraveTagged, aiBraveTagged),
      marketplaceBraveTagged,
    ),
    combineBraveOutcomes(imageBraveWebTagged, imageBraveTagged),
  );

  // Check if request was aborted during Phase 2
  if (abortController.signal.aborted) {
    console.warn(`[search:${requestId}] Aborted after Phase 2 (${Date.now() - searchStart}ms)`);
    return c.json({ error: "timeout", message: "Search request timed out", requestId }, 504);
  }

  // ── Phase 3: merge → dedup → filter source URL → heuristicPreSort → cap ──

  const allResults = [
    ...braveOutcome.results,
    ...aliExpressTextTagged.results,
    ...aliExpressImageTagged.results,
  ];
  const deduped = mergeAndDedup(allResults).map(annotateResultValidation);

  // Filter out the exact source product URL — users don't want to see the item they're already viewing.
  // Intentionally strips ALL query params (not just tracking params like normalizeUrl does) for
  // aggressive matching — false positives are acceptable since users never want their own product.
  const sourceNormalized = body.sourceUrl.split("?")[0].toLowerCase().replace(/\/$/, "");
  const filtered = deduped.filter((r) => {
    const normalized = r.productUrl.split("?")[0].toLowerCase().replace(/\/$/, "");
    return normalized !== sourceNormalized;
  }).filter(isDisplayableCandidate);
  const laneDiagnostics = countResultsByLane(filtered);

  const preSorted = heuristicPreSort(filtered, identification, body.price, sourceMarketplace);
  const capped = diversityCap(preSorted, MAX_RESULTS_FOR_RANKING, sourceMarketplace);

  // ── Source attribution logging ──────────────────────────────────────────
  console.log(
    `[search:${requestId}] Source breakdown: ` +
    `Brave(title)=${titleBraveOutcome.results.length}, ` +
    `Brave(AI)=${aiBraveOutcome.results.length}, ` +
    `Brave(marketplace)=${marketplaceBraveOutcome.results.length}, ` +
    `Brave(image-web)=${imageBraveWebOutcome.results.length}, ` +
    `Brave(image)=${imageBraveOutcome.results.length}, ` +
    `AliExpress(text)=${aliExpressTextOutcome.results.length}, ` +
    `AliExpress(image)=${aliExpressImageOutcome.results.length}`,
  );

  // Marketplace breakdown for deduped and capped results
  const mpCount = (arr: typeof deduped) => {
    const counts: Record<string, number> = {};
    for (const r of arr) counts[r.marketplace] = (counts[r.marketplace] ?? 0) + 1;
    return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ");
  };
  console.log(`[search:${requestId}] Marketplace breakdown (deduped): ${mpCount(deduped)}`);
  console.log(`[search:${requestId}] Marketplace breakdown (capped): ${mpCount(capped)}`);

  console.log(`[search:${requestId}] Results: ${allResults.length} raw → ${deduped.length} deduped → ${capped.length} capped`);

  // Log top capped results for debugging
  for (const r of capped.slice(0, 10)) {
    console.log(`[search:${requestId}]   [${r.source}] "${r.title.slice(0, 80)}" price=${r.price ?? "N/A"} url=${r.productUrl.slice(0, 100)}`);
  }

  // ── Phase 3.5: price fallback — screenshot + Gemini Vision for top results missing prices ──
  if (remaining() > PRICE_FALLBACK_TIMEOUT_MS + 2000) {
    try {
      const extractedPrices = await withTimeout(
        fillMissingPrices(capped, MAX_PRICE_FALLBACK_RESULTS),
        PRICE_FALLBACK_TIMEOUT_MS,
      );
      for (const [id, { price, currency }] of extractedPrices) {
        const result = capped.find((r) => r.id === id);
        if (result) {
          result.price = price;
          result.currency = currency;
          result.priceSource = "fallback_screenshot";
        }
      }
      console.log(`[search:${requestId}] Price fallback filled ${extractedPrices.size} prices`);
    } catch (err) {
      console.warn("[search] Price fallback timed out or failed:", err);
    }
  } else {
    console.log("[search] Skipping price fallback — insufficient time remaining");
  }

  if (abortController.signal.aborted) {
    console.warn(`[search:${requestId}] Aborted after price fallback (${Date.now() - searchStart}ms)`);
    return c.json({ error: "timeout", message: "Search request timed out", requestId }, 504);
  }

  // ── Phase 3.75: embedding-based visual similarity ─────────────────────────
  let visualScores: Record<string, number> = {};
  if (originalImage && remaining() > EMBEDDING_TIMEOUT_MS + 1000) {
    try {
      visualScores = await withTimeout(
        computeVisualSimilarityScores(originalImage, capped),
        EMBEDDING_TIMEOUT_MS,
      );
      console.log(`[search:${requestId}] Embedding scored ${Object.keys(visualScores).length} results`);
    } catch (err) {
      console.warn(`[search:${requestId}] Embedding scoring failed:`, err);
    }
  } else {
    console.log(`[search:${requestId}] Skipping embedding — ${originalImage ? "insufficient time" : "no original image"}`);
  }

  // ── Phase 4: ranking ─────────────────────────────────────────────────────

  const rankStart = Date.now();
  const textScores = buildFallbackScores(capped, identification, sourceMarketplace);
  const scores = Object.keys(visualScores).length > 0
    ? blendScores(textScores, visualScores)
    : textScores;
  const rankingDurationMs = Date.now() - rankStart;
  // Heuristic scoring is the sole ranking path (AI ranking removed in 362f16e).
  // "ok" means ranking completed successfully — the heuristic is the baseline.
  const rankingStatus: "ok" | "fallback" = "ok";
  const rankingFailureReason: string | null = null;

  // Log score breakdown for ALL capped results
  const hasVisual = Object.keys(visualScores).length > 0;
  console.log(`[search:${requestId}] Scoring: mode=${hasVisual ? "blended (text+visual)" : "text-only"}, weights=text:${0.6}/visual:${0.4}`);
  for (const r of capped) {
    const ts = textScores[r.id] ?? 0;
    const vs = visualScores[r.id];
    const final = scores[r.id] ?? 0;
    const parts = [`text=${ts.toFixed(3)}`];
    if (vs !== undefined) parts.push(`visual=${vs.toFixed(3)}`);
    parts.push(`final=${final.toFixed(3)}`);
    const priceTag = r.price != null ? ` $${r.price}` : " no-price";
    const imgTag = r.imageUrl ? " +img" : " -img";
    console.log(`[search:${requestId}]   Score [${r.id}] "${r.title.slice(0, 60)}":${priceTag}${imgTag} ${parts.join(", ")}`);
  }

  const ranked = applyRanking(capped, scores, body.price);

  // Log filtered/backfilled results
  const belowThreshold = capped.filter((r) => (scores[r.id] ?? 0) < MIN_CONFIDENCE_SCORE);
  const backfilled = ranked.filter((r) => r.confidenceScore < MIN_CONFIDENCE_SCORE);
  if (belowThreshold.length > 0) {
    console.log(
      `[search:${requestId}] ${belowThreshold.length} results below MIN_CONFIDENCE_SCORE (${MIN_CONFIDENCE_SCORE})` +
      (backfilled.length > 0 ? `, ${backfilled.length} backfilled to meet MIN_DISPLAY_RESULTS (10)` : `, all filtered`),
    );
  }

  // ── Build response ────────────────────────────────────────────────────────

  const response: SearchResponse = {
    requestId,
    originalProduct: {
      title: body.title,
      price: body.price,
      currency: body.currency,
      imageUrl: body.imageUrl ?? "",
      identification,
    },
    results: ranked,
    searchMeta: {
      totalFound: filtered.length,
      braveResultCount: braveOutcome.results.length,
      groundingResultCount: 0,
      sourceStatus: {
        brave: braveOutcome.status,
        grounding: "ok" as const,
      },
      sourceDiagnostics: {
        brave: {
          totalQueries: braveOutcome.totalQueries,
          successfulQueries: braveOutcome.successfulQueries,
          failedQueries: braveOutcome.failedQueries,
          timedOutQueries: braveOutcome.timedOutQueries,
        },
        grounding: {
          totalQueries: 0,
          successfulQueries: 0,
          failedQueries: 0,
          timedOutQueries: 0,
        },
      },
      laneDiagnostics,
      imageQueryDiagnostics: {
        rawQueryCount: rawImageSearchQueries.length,
        acceptedQueries: imageSearchQueries,
        rejectedQueries: rejectedImageSearchQueries,
      },
      searchDurationMs: Date.now() - searchStart,
      rankingDurationMs,
      rankingStatus,
      rankingFailureReason,
    },
  };

  // Log ALL final ranked results
  console.log(`[search:${requestId}] Final ranked results (${ranked.length}):`);
  for (const r of ranked) {
    console.log(
      `[search:${requestId}]   #${r.rank} [${r.confidence}/${(r.confidenceScore * 100).toFixed(0)}%] ` +
      `"${r.result.title.slice(0, 60)}" ${r.result.price != null ? `${r.result.currency ?? "$"}${r.result.price}` : "no price"} ` +
      `(${r.result.marketplace}) ${r.comparisonNotes}`,
    );
  }

  console.log(`[search:${requestId}] Complete: ${ranked.length} results in ${response.searchMeta.searchDurationMs}ms`);
  return c.json(response);

  } finally {
    clearTimeout(requestTimer);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTitleQueries(title: string | null, sourceUrl: string): string[] {
  if (!title) return [];
  // Build 1-2 queries from the page title
  const queries = [title];
  // Add a shorter query stripping common suffixes like "- Amazon.com"
  const cleaned = title.replace(/\s*[-|]\s*(Amazon|eBay|Walmart|Target|Best Buy).*$/i, "").trim();
  if (cleaned !== title && cleaned.length > 10) {
    queries.push(`${cleaned} buy online`);
  }
  return queries;
}

function hasNewQueries(aiQueries: string[], titleQueries: string[]): boolean {
  if (titleQueries.length === 0) return true;
  const titleSet = new Set(titleQueries.map((q) => q.toLowerCase().trim()));
  return aiQueries.some((q) => !titleSet.has(q.toLowerCase().trim()));
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

function combineBraveOutcomes(a: ProviderSearchOutcome, b: ProviderSearchOutcome): ProviderSearchOutcome {
  const combined: ProviderSearchOutcome = {
    results: [...a.results, ...b.results],
    status: worstStatus(a.status, b.status),
    totalQueries: a.totalQueries + b.totalQueries,
    successfulQueries: a.successfulQueries + b.successfulQueries,
    failedQueries: a.failedQueries + b.failedQueries,
    timedOutQueries: a.timedOutQueries + b.timedOutQueries,
  };
  // If both have 0 queries, status is ok
  if (combined.totalQueries === 0) combined.status = "ok";
  return combined;
}

function worstStatus(a: ProviderStatus, b: ProviderStatus): ProviderStatus {
  if (a === "error" || b === "error") return "error";
  if (a === "timeout" || b === "timeout") return "timeout";
  return "ok";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof TimeoutError || (err instanceof Error && err.name === "TimeoutError");
}

function rejectedProviderOutcome(totalQueries: number, err: unknown): ProviderSearchOutcome {
  const status: ProviderStatus = isTimeoutError(err) ? "timeout" : "error";
  return {
    results: [],
    status,
    totalQueries,
    successfulQueries: 0,
    failedQueries: totalQueries,
    timedOutQueries: status === "timeout" ? totalQueries : 0,
  };
}

function tagOutcomeResults(
  outcome: ProviderSearchOutcome,
  lane: "text" | "image" | "hybrid",
  provider: "brave" | "aliexpress",
  query?: string,
): ProviderSearchOutcome {
  return {
    ...outcome,
    results: outcome.results.map((result) => ({
      ...result,
      retrievalLane: lane,
      ...(query
        ? {
            matchedQueries: [
              { query, lane: lane === "hybrid" ? "image" : lane, provider },
            ],
          }
        : {}),
    })),
  };
}

async function searchProviderByQuery(
  queries: string[],
  runner: (queries: string[]) => Promise<ProviderSearchOutcome>,
  lane: "text" | "image",
  provider: "brave" | "aliexpress",
): Promise<ProviderSearchOutcome> {
  const outcomes = await Promise.allSettled(
    queries.map(async (query) => {
      const outcome = await runner([query]);
      return tagOutcomeResults(outcome, lane, provider, query);
    }),
  );

  let combined = emptyProviderOutcome();
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome.status === "fulfilled") {
      combined = combineBraveOutcomes(combined, outcome.value);
    } else {
      combined = combineBraveOutcomes(combined, rejectedProviderOutcome(1, outcome.reason));
    }
  }
  return combined;
}

async function searchAliExpressTextByQuery(queries: string[]): Promise<ProviderSearchOutcome> {
  const outcomes = await Promise.allSettled(
    queries.map(async (query) => {
      const outcome = await searchAliExpressSplit([query], null);
      return tagOutcomeResults(outcome.textOutcome, "text", "aliexpress", query);
    }),
  );

  let combined = emptyProviderOutcome();
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome.status === "fulfilled") {
      combined = combineBraveOutcomes(combined, outcome.value);
    } else {
      combined = combineBraveOutcomes(combined, rejectedProviderOutcome(1, outcome.reason));
    }
  }
  return combined;
}

async function searchAliExpressImage(image: FetchedImage): Promise<ProviderSearchOutcome> {
  const outcome = await searchAliExpressSplit([], image);
  return tagOutcomeResults(outcome.imageOutcome, "image", "aliexpress", "[image-search]");
}

function countResultsByLane(results: SearchResult[]): {
  textResultCount: number;
  imageResultCount: number;
  hybridResultCount: number;
} {
  const counts = {
    textResultCount: 0,
    imageResultCount: 0,
    hybridResultCount: 0,
  };

  for (const result of results) {
    if (result.retrievalLane === "text") counts.textResultCount++;
    else if (result.retrievalLane === "image") counts.imageResultCount++;
    else if (result.retrievalLane === "hybrid") counts.hybridResultCount++;
  }

  return counts;
}

