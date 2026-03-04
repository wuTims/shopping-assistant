import { Hono } from "hono";
import type { SearchRequest, SearchResponse } from "@shopping-assistant/shared";
import { SEARCH_TIMEOUT_MS } from "@shopping-assistant/shared";
import {
  identifyProduct,
  groundedSearch,
  rankResults,
  RankingOutputValidationError,
} from "../services/gemini.js";
import { searchProducts } from "../services/brave.js";
import type { ProviderSearchOutcome, ProviderStatus } from "../services/provider-outcome.js";
import { mergeAndDedup, applyRanking, buildFallbackScores } from "../services/ranking.js";

export const searchRoute = new Hono();

searchRoute.post("/", async (c) => {
  let body: SearchRequest;
  try {
    body = await c.req.json<SearchRequest>();
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }

  if (!body.imageUrl || typeof body.imageUrl !== "string") {
    return c.json({ error: "bad_request", message: "imageUrl is required and must be a string" }, 400);
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

  console.log(`[search:${requestId}] Request for: ${body.title ?? body.imageUrl}`);

  // Step 1: Identify product
  let identification;
  try {
    identification = await identifyProduct(body.imageUrl, body.title);
  } catch (err) {
    console.error(`[search:${requestId}] Product identification failed:`, err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "product_identification_failed", message, requestId }, 422);
  }
  console.log(`[search:${requestId}] Identified: ${identification.category} — ${identification.description}`);

  // Step 2: Parallel source search with bounded timeouts
  const sourceTimeout = Math.max(SEARCH_TIMEOUT_MS - (Date.now() - searchStart) - 1000, 3000);

  const [groundingResult, braveResult] = await Promise.allSettled([
    withTimeout(groundedSearch(identification.searchQueries), sourceTimeout),
    withTimeout(searchProducts(identification.searchQueries), sourceTimeout),
  ]);

  const groundingOutcome = groundingResult.status === "fulfilled"
    ? groundingResult.value
    : rejectedProviderOutcome(identification.searchQueries.length, groundingResult.reason);
  const braveOutcome = braveResult.status === "fulfilled"
    ? braveResult.value
    : rejectedProviderOutcome(identification.searchQueries.length, braveResult.reason);

  if (groundingResult.status === "rejected") {
    console.error(`[search:${requestId}] Grounding failed:`, groundingResult.reason);
  }
  if (braveResult.status === "rejected") {
    console.error(`[search:${requestId}] Brave failed:`, braveResult.reason);
  }

  // Step 3: Merge and dedup
  const allResults = [...groundingOutcome.results, ...braveOutcome.results];
  const deduped = mergeAndDedup(allResults);
  console.log(`[search:${requestId}] Results: ${allResults.length} raw → ${deduped.length} deduped`);

  // Step 4: Rank
  const rankStart = Date.now();
  let scores: Record<string, number> = {};
  let rankingStatus: "ok" | "fallback" = "ok";
  let rankingFailureReason: string | null = null;
  try {
    scores = await rankResults(body.imageUrl, deduped, identification);
  } catch (err) {
    rankingStatus = "fallback";
    rankingFailureReason = getRankingFailureReason(err);
    console.error(`[search:${requestId}] Ranking failed (${rankingFailureReason}), using heuristic fallback:`, err);
    scores = buildFallbackScores(deduped, identification);
  }
  const rankingDurationMs = Date.now() - rankStart;

  const ranked = applyRanking(deduped, scores, body.price);

  // Step 5: Build response
  const response: SearchResponse = {
    requestId,
    originalProduct: {
      title: body.title,
      price: body.price,
      currency: body.currency,
      imageUrl: body.imageUrl,
      identification,
    },
    results: ranked,
    searchMeta: {
      totalFound: deduped.length,
      braveResultCount: braveOutcome.results.length,
      groundingResultCount: groundingOutcome.results.length,
      sourceStatus: {
        brave: braveOutcome.status,
        grounding: groundingOutcome.status,
      },
      sourceDiagnostics: {
        brave: {
          totalQueries: braveOutcome.totalQueries,
          successfulQueries: braveOutcome.successfulQueries,
          failedQueries: braveOutcome.failedQueries,
          timedOutQueries: braveOutcome.timedOutQueries,
        },
        grounding: {
          totalQueries: groundingOutcome.totalQueries,
          successfulQueries: groundingOutcome.successfulQueries,
          failedQueries: groundingOutcome.failedQueries,
          timedOutQueries: groundingOutcome.timedOutQueries,
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
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function getRankingFailureReason(err: unknown): string {
  if (err instanceof RankingOutputValidationError) {
    if (err.details.length > 0) {
      return `${err.message} (${err.details.join("; ")})`;
    }
    return err.message;
  }

  if (err instanceof Error) {
    return err.message;
  }

  return "Unknown ranking error";
}
