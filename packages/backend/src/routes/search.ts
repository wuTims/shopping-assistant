import { Hono } from "hono";
import type { SearchRequest, SearchResponse, ProductIdentification } from "@shopping-assistant/shared";
import {
  SEARCH_TIMEOUT_MS,
  MAX_RESULTS_FOR_RANKING,
  MAX_PRICE_FALLBACK_RESULTS,
  PRICE_FALLBACK_TIMEOUT_MS,
} from "@shopping-assistant/shared";
import {
  identifyProduct,
} from "../services/gemini.js";
import type { FetchedImage } from "../services/gemini.js";
import { searchProducts } from "../services/brave.js";
import { fillMissingPrices } from "../services/price-fallback.js";
import { generateMarketplaceQueries } from "../utils/marketplace-queries.js";
import type { ProviderSearchOutcome, ProviderStatus } from "../services/provider-outcome.js";
import {
  mergeAndDedup,
  applyRanking,
  buildFallbackScores,
  heuristicPreSort,
} from "../services/ranking.js";

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

  const requestId = crypto.randomUUID();
  const searchStart = Date.now();
  const remaining = () => SEARCH_TIMEOUT_MS - (Date.now() - searchStart);

  console.log(`[search:${requestId}] Request for: ${body.title ?? body.imageUrl ?? "(base64 image)"}`);

  // Hard request-level timeout — safety net to prevent unbounded latency
  const abortController = new AbortController();
  const requestTimer = setTimeout(() => abortController.abort(), SEARCH_TIMEOUT_MS);

  try {

  // ── Phase 1: identify product + brave(title queries) in parallel ──────────

  const imageSource = body.imageUrl
    ? body.imageUrl
    : { data: body.imageBase64!, mimeType: "image/png" } as FetchedImage;

  const titleQueries = buildTitleQueries(body.title, body.sourceUrl);

  // Always kick off title Brave search in parallel
  const titleBravePromise = titleQueries.length > 0
    ? withTimeout(searchProducts(titleQueries), Math.max(remaining() - 1000, 5000))
    : Promise.resolve(emptyProviderOutcome());

  let identification: ProductIdentification;

  if (
    body.identification &&
    typeof body.identification.category === "string" &&
    typeof body.identification.description === "string" &&
    Array.isArray(body.identification.searchQueries) &&
    body.identification.searchQueries.length > 0
  ) {
    // Use pre-computed identification from /identify — skip redundant Gemini call
    identification = body.identification;
    console.log(`[search:${requestId}] Using provided identification: ${identification.category} — ${identification.description}`);
  } else {
    // No identification provided — identify from scratch (overlay click path)
    try {
      const result = await identifyProduct(imageSource, body.title);
      identification = result.identification;
      console.log(`[search:${requestId}] Identified: ${identification.category} — ${identification.description}`);
    } catch (err) {
      console.error(`[search:${requestId}] Product identification failed:`, err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: "product_identification_failed", message, requestId }, 422);
    }
  }

  // Check if request was aborted during Phase 1
  if (abortController.signal.aborted) {
    console.warn(`[search:${requestId}] Aborted after Phase 1 (${Date.now() - searchStart}ms)`);
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
  const marketplaceQueries = generateMarketplaceQueries(
    identification.description || body.title || "",
  );
  const phase2Deadline = Math.max(remaining() - 4000, 3000);

  const skipAiBrave = !hasNewQueries(aiQueries, titleQueries);

  const [aiBraveResult, marketplaceBraveResult] =
    await Promise.allSettled([
      skipAiBrave
        ? Promise.resolve(emptyProviderOutcome())
        : withTimeout(searchProducts(aiQueries), phase2Deadline),
      marketplaceQueries.length > 0
        ? withTimeout(searchProducts(marketplaceQueries), phase2Deadline)
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

  // Combine brave outcomes
  const braveOutcome = combineBraveOutcomes(
    combineBraveOutcomes(titleBraveOutcome, aiBraveOutcome),
    marketplaceBraveOutcome,
  );

  // Check if request was aborted during Phase 2
  if (abortController.signal.aborted) {
    console.warn(`[search:${requestId}] Aborted after Phase 2 (${Date.now() - searchStart}ms)`);
    return c.json({ error: "timeout", message: "Search request timed out", requestId }, 504);
  }

  // ── Phase 3: merge → dedup → heuristicPreSort → cap ────────────────────

  const allResults = [...braveOutcome.results];
  const deduped = mergeAndDedup(allResults);
  const preSorted = heuristicPreSort(deduped, identification, body.price);
  const capped = preSorted.slice(0, MAX_RESULTS_FOR_RANKING);

  console.log(`[search:${requestId}] Results: ${allResults.length} raw → ${deduped.length} deduped → ${capped.length} capped`);

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
        }
      }
      console.log(`[search:${requestId}] Price fallback filled ${extractedPrices.size} prices`);
    } catch (err) {
      console.warn("[search] Price fallback timed out or failed:", err);
    }
  } else {
    console.log("[search] Skipping price fallback — insufficient time remaining");
  }

  // ── Phase 4: ranking ─────────────────────────────────────────────────────

  const rankStart = Date.now();
  const scores = buildFallbackScores(capped, identification);
  const rankingDurationMs = Date.now() - rankStart;
  const rankingStatus: "ok" | "fallback" = "ok";
  const rankingFailureReason: string | null = null;

  const ranked = applyRanking(capped, scores, body.price);

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
      totalFound: deduped.length,
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
      searchDurationMs: Date.now() - searchStart,
      rankingDurationMs,
      rankingStatus,
      rankingFailureReason,
    },
  };

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

