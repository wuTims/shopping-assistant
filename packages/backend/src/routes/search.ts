import { Hono } from "hono";
import type { SearchRequest, SearchResponse, SearchResult } from "@shopping-assistant/shared";
import {
  SEARCH_TIMEOUT_MS,
  MAX_RESULTS_FOR_RANKING,
  MAX_IMAGES_FOR_RANKING,
  RANKING_IMAGE_TIMEOUT_MS,
} from "@shopping-assistant/shared";
import {
  identifyProduct,
  groundedSearch,
  rankResults,
  fetchImage,
  RankingOutputValidationError,
} from "../services/gemini.js";
import type { FetchedImage } from "../services/gemini.js";
import { searchProducts } from "../services/brave.js";
import type { ProviderSearchOutcome, ProviderStatus } from "../services/provider-outcome.js";
import {
  mergeAndDedup,
  applyRanking,
  buildFallbackScores,
  heuristicPreSort,
  selectImageCandidates,
} from "../services/ranking.js";

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
  const remaining = () => SEARCH_TIMEOUT_MS - (Date.now() - searchStart);

  console.log(`[search:${requestId}] Request for: ${body.title ?? body.imageUrl}`);

  // ── Phase 1: identify product + brave(title queries) in parallel ──────────

  const titleQueries = buildTitleQueries(body.title, body.sourceUrl);

  const [identifyResult, titleBraveResult] = await Promise.allSettled([
    identifyProduct(body.imageUrl, body.title),
    titleQueries.length > 0
      ? withTimeout(searchProducts(titleQueries), Math.max(remaining() - 1000, 5000))
      : Promise.resolve(emptyProviderOutcome()),
  ]);

  // Identification is required
  if (identifyResult.status === "rejected") {
    console.error(`[search:${requestId}] Product identification failed:`, identifyResult.reason);
    const message = identifyResult.reason instanceof Error ? identifyResult.reason.message : "Unknown error";
    return c.json({ error: "product_identification_failed", message, requestId }, 422);
  }

  const { identification, originalImage } = identifyResult.value;
  console.log(`[search:${requestId}] Identified: ${identification.category} — ${identification.description}`);

  const titleBraveOutcome = titleBraveResult.status === "fulfilled"
    ? titleBraveResult.value
    : rejectedProviderOutcome(titleQueries.length, titleBraveResult.reason);

  if (titleBraveResult.status === "rejected") {
    console.error(`[search:${requestId}] Brave (title) failed:`, titleBraveResult.reason);
  }

  // ── Phase 2: grounded search + brave(AI queries) in parallel ──────────────

  const aiQueries = identification.searchQueries;
  const deadline = Math.max(remaining() - 4000, 3000);

  const phase2Promises: [
    Promise<ProviderSearchOutcome>,
    Promise<ProviderSearchOutcome>,
  ] = [
    withTimeout(groundedSearch(aiQueries), deadline),
    hasNewQueries(aiQueries, titleQueries)
      ? withTimeout(searchProducts(aiQueries), deadline)
      : Promise.resolve(emptyProviderOutcome()),
  ];

  const [groundingResult, aiBraveResult] = await Promise.allSettled(phase2Promises);

  const groundingOutcome = groundingResult.status === "fulfilled"
    ? groundingResult.value
    : rejectedProviderOutcome(aiQueries.length, groundingResult.reason);
  const aiBraveOutcome = aiBraveResult.status === "fulfilled"
    ? aiBraveResult.value
    : rejectedProviderOutcome(aiQueries.length, aiBraveResult.reason);

  if (groundingResult.status === "rejected") {
    console.error(`[search:${requestId}] Grounding failed:`, groundingResult.reason);
  }
  if (aiBraveResult.status === "rejected") {
    console.error(`[search:${requestId}] Brave (AI) failed:`, aiBraveResult.reason);
  }

  // Combine brave outcomes
  const braveOutcome = combineBraveOutcomes(titleBraveOutcome, aiBraveOutcome);

  // ── Phase 3: merge → dedup → heuristicPreSort → cap → fetch images ───────

  const allResults = [...groundingOutcome.results, ...braveOutcome.results];
  const deduped = mergeAndDedup(allResults);
  const preSorted = heuristicPreSort(deduped, identification, body.price);
  const capped = preSorted.slice(0, MAX_RESULTS_FOR_RANKING);

  console.log(`[search:${requestId}] Results: ${allResults.length} raw → ${deduped.length} deduped → ${capped.length} capped`);

  // Fetch images for top candidates only
  const imageCandidates = selectImageCandidates(capped, MAX_IMAGES_FOR_RANKING);
  const resultImages = new Map<string, FetchedImage>();

  const imageResults = await Promise.allSettled(
    imageCandidates.map(async (r) => {
      const img = await fetchImage(r.imageUrl!, RANKING_IMAGE_TIMEOUT_MS);
      return { id: r.id, image: img };
    }),
  );
  for (const result of imageResults) {
    if (result.status === "fulfilled") {
      resultImages.set(result.value.id, result.value.image);
    }
  }

  console.log(`[search:${requestId}] Fetched ${resultImages.size}/${imageCandidates.length} result images`);

  // ── Phase 4: AI ranking (with deadline fallback) ──────────────────────────

  const rankStart = Date.now();
  let scores: Record<string, number> = {};
  let rankingStatus: "ok" | "fallback" = "ok";
  let rankingFailureReason: string | null = null;

  if (remaining() < 2000) {
    // Not enough time for AI ranking — use heuristic fallback
    rankingStatus = "fallback";
    rankingFailureReason = "Insufficient time for AI ranking";
    console.log(`[search:${requestId}] Skipping AI ranking (${remaining()}ms left), using fallback`);
    scores = buildFallbackScores(capped, identification);
  } else {
    try {
      scores = await rankResults({
        originalImage,
        results: capped,
        resultImages,
        identification,
      });
    } catch (err) {
      rankingStatus = "fallback";
      rankingFailureReason = getRankingFailureReason(err);
      console.error(`[search:${requestId}] Ranking failed (${rankingFailureReason}), using heuristic fallback:`, err);
      scores = buildFallbackScores(capped, identification);
    }
  }
  const rankingDurationMs = Date.now() - rankStart;

  const ranked = applyRanking(capped, scores, body.price);

  // ── Build response ────────────────────────────────────────────────────────

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
