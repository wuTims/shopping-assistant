# Phase 1: Backend API Implementation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement and curl-test all backend endpoints — Gemini product identification, grounded search, Brave search, ranking, search pipeline, and text chat.

**Architecture:** Hono server with three services (Gemini, Brave, ranking) wired into two REST endpoints (POST /search, POST /chat). Each service is independently testable. The search pipeline orchestrates: identify → parallel search → merge/dedup → rank.

**Tech Stack:** TypeScript, Hono 4, `@google/genai` SDK, Brave Web Search API, pnpm workspaces

**Prerequisites:** API keys for Gemini (https://aistudio.google.com/apikey) and Brave (https://api-dashboard.search.brave.com/app/keys)

**Validation gate:** Phase is complete when `curl POST /search` and `curl POST /chat` return real results from live APIs.

---

### Task 1: Install Backend Dependencies and Configure Environment

**Files:**
- Modify: `packages/backend/package.json`
- Create: `packages/backend/.env.example`
- Create: `packages/backend/.env`

**Step 1: Add @google/genai to backend dependencies**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend add @google/genai`
Expected: Package installed, pnpm-lock.yaml updated.

**Step 2: Create .env.example**

```
GEMINI_API_KEY=your-gemini-api-key-here
BRAVE_API_KEY=your-brave-api-key-here
PORT=8080
```

**Step 3: Create .env with actual API keys**

```
GEMINI_API_KEY=<your-actual-key>
BRAVE_API_KEY=<your-actual-key>
PORT=8080
```

**Step 4: Update dev script for env loading**

In `packages/backend/package.json`, change the `dev` script from:
```json
"dev": "tsx watch src/index.ts"
```
to:
```json
"dev": "tsx watch --env-file=.env src/index.ts"
```

**Step 5: Verify backend starts**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && timeout 5 pnpm dev:backend 2>&1 || true`
Expected: Logs "Backend running on http://localhost:8080".

**Step 6: Commit**

```bash
git add packages/backend/package.json packages/backend/.env.example pnpm-lock.yaml
git commit -m "chore: add @google/genai dependency and env config"
```

---

### Task 2: Implement Gemini Client — Product Identification

**Files:**
- Rewrite: `packages/backend/src/services/gemini.ts`

**Step 1: Implement identifyProduct function**

Replace the entire contents of `packages/backend/src/services/gemini.ts` with:

```typescript
import { GoogleGenAI, Type } from "@google/genai";
import type { ProductIdentification } from "@shopping-assistant/shared";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

/**
 * Send a product image to Gemini Flash and get structured identification.
 * Returns category, description, brand, attributes, and search queries.
 */
export async function identifyProduct(
  imageUrl: string,
  title: string | null,
): Promise<ProductIdentification> {
  // Fetch the image and convert to base64 (Gemini requires inline data)
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch image: ${imageResponse.status} ${imageUrl}`);
  }
  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Data = Buffer.from(imageBuffer).toString("base64");
  const mimeType = imageResponse.headers.get("content-type") ?? "image/jpeg";

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      {
        inlineData: { mimeType, data: base64Data },
      },
      {
        text: `Analyze this product image and identify the product.${title ? ` The listing title is: "${title}".` : ""}

Return a structured identification with:
- category: specific product type (e.g. "wireless noise-cancelling headphones", "leather crossbody bag")
- description: concise natural language description suitable for search queries
- brand: brand name if visible/identifiable, null otherwise
- attributes: color, material, style, size (null if not determinable)
- searchQueries: exactly 3 search query strings optimized to find this product on shopping marketplaces like Amazon, eBay, AliExpress, Temu. Include the product type and key distinguishing features. Do NOT include the brand in at least one query (to find alternatives).
- estimatedPriceRange: your estimate of the typical retail price range for this type of product in USD`,
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING },
          description: { type: Type.STRING },
          brand: { type: Type.STRING, nullable: true },
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
          },
          estimatedPriceRange: {
            type: Type.OBJECT,
            nullable: true,
            properties: {
              low: { type: Type.NUMBER },
              high: { type: Type.NUMBER },
              currency: { type: Type.STRING },
            },
            required: ["low", "high", "currency"],
          },
        },
        required: [
          "category",
          "description",
          "searchQueries",
          "attributes",
        ],
      },
    },
  });

  return JSON.parse(response.text!) as ProductIdentification;
}

// Placeholders — implemented in later tasks
export async function groundedSearch(
  _queries: string[],
  _imageUrl: string,
): Promise<unknown[]> {
  throw new Error("Not implemented: groundedSearch");
}

export async function rankResults(
  _originalImageUrl: string,
  _results: unknown[],
  _identification: ProductIdentification,
): Promise<Record<string, { score: number; notes: string }>> {
  throw new Error("Not implemented: rankResults");
}
```

**Step 2: Smoke test**

Create `packages/backend/test-identify.ts` (temporary, delete after):

```typescript
import { identifyProduct } from "./src/services/gemini.js";

const testImageUrl = "https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg";

async function main() {
  console.log("Testing identifyProduct...");
  const result = await identifyProduct(testImageUrl, "Sony WH-1000XM5 Headphones");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
```

Run: `cd /workspaces/web-dev-playground/shopping-assistant/packages/backend && npx tsx --env-file=.env test-identify.ts`
Expected: Structured JSON with category, description, brand, attributes, searchQueries.

**Step 3: Clean up and commit**

```bash
rm packages/backend/test-identify.ts
git add packages/backend/src/services/gemini.ts
git commit -m "feat: implement Gemini product identification with structured output"
```

---

### Task 3: Implement Gemini Client — Grounded Search

**Files:**
- Modify: `packages/backend/src/services/gemini.ts`

**Step 1: Replace the groundedSearch placeholder**

In `packages/backend/src/services/gemini.ts`, replace the `groundedSearch` stub with the real implementation. Also update the import to include `SearchResult`:

```typescript
import type {
  ProductIdentification,
  SearchResult,
} from "@shopping-assistant/shared";
```

Replace the `groundedSearch` function:

```typescript
/**
 * Use Gemini with google_search tool to find product listings.
 * Returns SearchResult[] from grounding chunks.
 */
export async function groundedSearch(
  queries: string[],
  imageUrl: string,
): Promise<SearchResult[]> {
  const combinedQuery = queries.join("; ");

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: `Find online shopping listings for the following product across marketplaces like Amazon, eBay, AliExpress, Temu, Walmart, and Target. Return as many product listings as possible with prices.

Search queries: ${combinedQuery}

For each product listing found, include the store name, product title, price, and URL.`,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });

  const metadata = response.candidates?.[0]?.groundingMetadata;
  if (!metadata?.groundingChunks?.length) {
    console.warn("[gemini] No grounding chunks returned");
    return [];
  }

  const groundingChunks = metadata.groundingChunks;
  const groundingSupports = metadata.groundingSupports ?? [];

  return groundingChunks
    .filter((chunk) => chunk.web?.uri)
    .map((chunk, i) => ({
      id: `grounding-${i}-${Date.now()}`,
      source: "gemini_grounding" as const,
      title: chunk.web?.title ?? "Unknown Product",
      price: null,
      currency: null,
      imageUrl: null,
      productUrl: chunk.web!.uri!,
      marketplace: extractMarketplace(chunk.web!.uri!),
      snippet: findSupportingText(i, groundingSupports),
      structuredData: null,
      raw: { chunk, responseText: response.text },
    }));
}
```

Add these module-level helpers at the bottom of the file:

```typescript
function extractMarketplace(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    const domainMap: Record<string, string> = {
      "amazon.com": "Amazon",
      "ebay.com": "eBay",
      "aliexpress.com": "AliExpress",
      "temu.com": "Temu",
      "walmart.com": "Walmart",
      "target.com": "Target",
      "dhgate.com": "DHgate",
      "etsy.com": "Etsy",
    };
    for (const [domain, name] of Object.entries(domainMap)) {
      if (hostname.includes(domain)) return name;
    }
    return hostname.split(".")[0];
  } catch {
    return "Unknown";
  }
}

function findSupportingText(
  chunkIndex: number,
  supports: Array<{
    segment?: { text?: string };
    groundingChunkIndices?: number[];
  }>,
): string | null {
  const relevant = supports.filter((s) =>
    s.groundingChunkIndices?.includes(chunkIndex),
  );
  return relevant.map((s) => s.segment?.text).join(" ").trim() || null;
}
```

**Step 2: Smoke test**

Create `packages/backend/test-grounded.ts` (temporary):

```typescript
import { groundedSearch } from "./src/services/gemini.js";

async function main() {
  console.log("Testing groundedSearch...");
  const results = await groundedSearch(
    ["Sony WH-1000XM5 headphones buy", "wireless noise cancelling headphones over-ear"],
    "https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg",
  );
  console.log(`Found ${results.length} results:`);
  for (const r of results) {
    console.log(`  ${r.marketplace}: ${r.title} — ${r.productUrl}`);
  }
}

main().catch(console.error);
```

Run: `cd /workspaces/web-dev-playground/shopping-assistant/packages/backend && npx tsx --env-file=.env test-grounded.ts`
Expected: Multiple SearchResult objects with real URLs from shopping sites.

**Step 3: Clean up and commit**

```bash
rm packages/backend/test-grounded.ts
git add packages/backend/src/services/gemini.ts
git commit -m "feat: implement Gemini grounded search with google_search tool"
```

---

### Task 4: Implement Brave Search Client

**Files:**
- Rewrite: `packages/backend/src/services/brave.ts`

**Step 1: Implement the Brave Web Search client**

Replace the entire contents of `packages/backend/src/services/brave.ts` with:

```typescript
import type { SearchResult } from "@shopping-assistant/shared";

const BRAVE_API_BASE = "https://api.search.brave.com/res/v1/web/search";

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  meta_url?: { hostname?: string };
  thumbnail?: { src?: string; original?: string } | null;
  rating?: {
    ratingValue?: number;
    bestRating?: number;
    reviewCount?: number;
  } | null;
  extra_snippets?: string[] | null;
  product_cluster?: Array<{
    name?: string;
    price?: string;
    description?: string;
    offers?: Array<{
      url?: string;
      price?: string;
      priceCurrency?: string;
    }>;
    rating?: { ratingValue?: number; reviewCount?: number } | null;
    thumbnail?: { src?: string } | null;
  }> | null;
}

interface BraveSearchResponse {
  query?: { original?: string };
  web?: { results?: BraveWebResult[] };
}

/**
 * Search Brave Web Search API for product listings.
 * Sends multiple queries in parallel and merges results.
 */
export async function searchProducts(
  queries: string[],
): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error("BRAVE_API_KEY not set");

  const allResults = await Promise.all(
    queries.map((q) => singleSearch(q, apiKey)),
  );

  return allResults.flat();
}

async function singleSearch(
  query: string,
  apiKey: string,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: "10",
    extra_snippets: "true",
    result_filter: "web",
    country: "us",
  });

  const response = await fetch(`${BRAVE_API_BASE}?${params}`, {
    headers: {
      "X-Subscription-Token": apiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    console.error(`[brave] API error ${response.status}: ${await response.text()}`);
    return [];
  }

  const data = (await response.json()) as BraveSearchResponse;
  const webResults = data.web?.results ?? [];
  const results: SearchResult[] = [];

  for (let i = 0; i < webResults.length; i++) {
    const r = webResults[i];

    if (r.product_cluster?.length) {
      for (const product of r.product_cluster) {
        const offer = product.offers?.[0];
        const price = parsePrice(offer?.price ?? product.price ?? null);
        results.push({
          id: `brave-cluster-${i}-${results.length}-${Date.now()}`,
          source: "brave",
          title: product.name ?? r.title,
          price,
          currency: offer?.priceCurrency ?? (price !== null ? "USD" : null),
          imageUrl: product.thumbnail?.src ?? r.thumbnail?.original ?? r.thumbnail?.src ?? null,
          productUrl: offer?.url ?? r.url,
          marketplace: extractMarketplace(offer?.url ?? r.url),
          snippet: product.description ?? r.description,
          structuredData: {
            brand: null,
            availability: null,
            rating: product.rating?.ratingValue ?? r.rating?.ratingValue ?? null,
            reviewCount: product.rating?.reviewCount ?? r.rating?.reviewCount ?? null,
          },
          raw: { webResult: r, product },
        });
      }
    } else {
      const snippetText = [r.description, ...(r.extra_snippets ?? [])].join(" ");
      const price = parsePrice(extractPriceFromText(snippetText));

      results.push({
        id: `brave-web-${i}-${Date.now()}`,
        source: "brave",
        title: r.title,
        price,
        currency: price !== null ? "USD" : null,
        imageUrl: r.thumbnail?.original ?? r.thumbnail?.src ?? null,
        productUrl: r.url,
        marketplace: extractMarketplace(r.url),
        snippet: r.description,
        structuredData: r.rating
          ? {
              brand: null,
              availability: null,
              rating: r.rating.ratingValue ?? null,
              reviewCount: r.rating.reviewCount ?? null,
            }
          : null,
        raw: { webResult: r },
      });
    }
  }

  return results;
}

function extractMarketplace(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    const domainMap: Record<string, string> = {
      "amazon.com": "Amazon", "ebay.com": "eBay", "aliexpress.com": "AliExpress",
      "temu.com": "Temu", "walmart.com": "Walmart", "target.com": "Target",
      "dhgate.com": "DHgate", "etsy.com": "Etsy",
    };
    for (const [domain, name] of Object.entries(domainMap)) {
      if (hostname.includes(domain)) return name;
    }
    return hostname.split(".")[0];
  } catch {
    return "Unknown";
  }
}

function parsePrice(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractPriceFromText(text: string): string | null {
  const match = text.match(/[\$\€\£]\s?[\d,]+\.?\d{0,2}/);
  return match ? match[0] : null;
}
```

**Step 2: Smoke test**

Create `packages/backend/test-brave.ts` (temporary):

```typescript
import { searchProducts } from "./src/services/brave.js";

async function main() {
  console.log("Testing Brave searchProducts...");
  const results = await searchProducts([
    "Sony WH-1000XM5 headphones buy",
    "wireless noise cancelling headphones over-ear",
  ]);
  console.log(`Found ${results.length} results:`);
  for (const r of results) {
    console.log(`  ${r.marketplace}: ${r.title} — $${r.price} — ${r.productUrl}`);
  }
}

main().catch(console.error);
```

Run: `cd /workspaces/web-dev-playground/shopping-assistant/packages/backend && npx tsx --env-file=.env test-brave.ts`
Expected: Multiple SearchResult objects with prices.

**Step 3: Clean up and commit**

```bash
rm packages/backend/test-brave.ts
git add packages/backend/src/services/brave.ts
git commit -m "feat: implement Brave Web Search client with product extraction"
```

---

### Task 5: Implement Ranking Service

**Files:**
- Rewrite: `packages/backend/src/services/ranking.ts`

**Step 1: Implement merge, dedup, and ranking logic**

Replace the entire contents of `packages/backend/src/services/ranking.ts` with:

```typescript
import type { SearchResult, RankedResult } from "@shopping-assistant/shared";
import { CONFIDENCE_THRESHOLDS } from "@shopping-assistant/shared";

/**
 * Merge results from both sources and deduplicate by URL.
 */
export function mergeAndDedup(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();

  for (const result of results) {
    const normalizedUrl = normalizeUrl(result.productUrl);

    if (!seen.has(normalizedUrl)) {
      seen.set(normalizedUrl, result);
    } else {
      const existing = seen.get(normalizedUrl)!;
      if (result.price !== null && existing.price === null) {
        seen.set(normalizedUrl, result);
      }
      if (result.imageUrl !== null && existing.imageUrl === null) {
        seen.set(normalizedUrl, { ...existing, imageUrl: result.imageUrl });
      }
    }
  }

  return Array.from(seen.values());
}

/**
 * Apply Gemini visual ranking scores to produce final RankedResult[].
 */
export function applyRanking(
  results: SearchResult[],
  scores: Record<string, { score: number; notes: string }>,
  originalPrice: number | null,
): RankedResult[] {
  const ranked: RankedResult[] = results.map((result) => {
    const scoreData = scores[result.id] ?? { score: 0.5, notes: "No ranking data" };
    const confidenceScore = scoreData.score;

    let confidence: "high" | "medium" | "low";
    if (confidenceScore >= CONFIDENCE_THRESHOLDS.high) {
      confidence = "high";
    } else if (confidenceScore >= CONFIDENCE_THRESHOLDS.medium) {
      confidence = "medium";
    } else {
      confidence = "low";
    }

    let priceDelta: number | null = null;
    let savingsPercent: number | null = null;
    if (originalPrice !== null && result.price !== null) {
      priceDelta = result.price - originalPrice;
      savingsPercent = Math.round(((originalPrice - result.price) / originalPrice) * 100);
    }

    return {
      result,
      confidence,
      confidenceScore,
      priceDelta,
      savingsPercent,
      comparisonNotes: scoreData.notes,
      rank: 0,
    };
  });

  ranked.sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) {
      return b.confidenceScore - a.confidenceScore;
    }
    return (b.savingsPercent ?? -Infinity) - (a.savingsPercent ?? -Infinity);
  });

  ranked.forEach((r, i) => { r.rank = i + 1; });

  return ranked;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "tag", "linkCode", "linkId", "camp", "creative",
      "fbclid", "gclid", "dclid", "msclkid",
    ];
    for (const param of trackingParams) {
      u.searchParams.delete(param);
    }
    return `${u.hostname.toLowerCase()}${u.pathname}${u.search}`;
  } catch {
    return url.toLowerCase();
  }
}
```

**Step 2: Commit**

```bash
git add packages/backend/src/services/ranking.ts
git commit -m "feat: implement result merge, dedup, and ranking logic"
```

---

### Task 6: Implement Gemini Client — Visual Ranking

**Files:**
- Modify: `packages/backend/src/services/gemini.ts`

**Step 1: Replace the rankResults placeholder**

In `packages/backend/src/services/gemini.ts`, replace the `rankResults` stub with:

```typescript
/**
 * Use Gemini Flash to visually compare search results against the original product.
 * Returns a map of result ID → { score, notes }.
 */
export async function rankResults(
  originalImageUrl: string,
  results: SearchResult[],
  identification: ProductIdentification,
): Promise<Record<string, { score: number; notes: string }>> {
  if (results.length === 0) return {};

  // Fetch original image
  const origResponse = await fetch(originalImageUrl);
  if (!origResponse.ok) {
    throw new Error(`Failed to fetch original image: ${origResponse.status}`);
  }
  const origBuffer = await origResponse.arrayBuffer();
  const origBase64 = Buffer.from(origBuffer).toString("base64");
  const origMimeType = origResponse.headers.get("content-type") ?? "image/jpeg";

  const contents: Array<Record<string, unknown>> = [
    { inlineData: { mimeType: origMimeType, data: origBase64 } },
    {
      text: `The image above is the original product: ${identification.description} (category: ${identification.category}).

Compare this original product against the following search results and rate how likely each is to be the same or very similar product (a real alternative the user could buy instead).

Results to rank:
${results
  .map(
    (r, i) =>
      `${i + 1}. [ID: ${r.id}] "${r.title}" on ${r.marketplace}${r.price !== null ? ` — $${r.price}` : ""}${r.imageUrl ? " (has image)" : " (no image)"}`,
  )
  .join("\n")}

For each result, provide:
- score: 0.0 to 1.0 confidence that this is the same or equivalent product
- notes: brief explanation of why (e.g., "exact same model", "similar style but different brand", "different product category")

Be generous with similar products — alternatives from other brands that serve the same purpose should score 0.4-0.6. Only score below 0.3 if the product is clearly unrelated.`,
    },
  ];

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          rankings: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                score: { type: Type.NUMBER },
                notes: { type: Type.STRING },
              },
              required: ["id", "score", "notes"],
            },
          },
        },
        required: ["rankings"],
      },
    },
  });

  const parsed = JSON.parse(response.text!) as {
    rankings: Array<{ id: string; score: number; notes: string }>;
  };

  const scoreMap: Record<string, { score: number; notes: string }> = {};
  for (const ranking of parsed.rankings) {
    scoreMap[ranking.id] = { score: ranking.score, notes: ranking.notes };
  }

  return scoreMap;
}
```

**Step 2: Commit**

```bash
git add packages/backend/src/services/gemini.ts
git commit -m "feat: implement Gemini visual ranking for search results"
```

---

### Task 7: Wire the Search Pipeline

**Files:**
- Rewrite: `packages/backend/src/routes/search.ts`

**Step 1: Implement the full search pipeline**

Replace the entire contents of `packages/backend/src/routes/search.ts` with:

```typescript
import { Hono } from "hono";
import type { SearchRequest, SearchResponse, SearchResult } from "@shopping-assistant/shared";
import { SEARCH_TIMEOUT_MS } from "@shopping-assistant/shared";
import { identifyProduct, groundedSearch, rankResults } from "../services/gemini.js";
import { searchProducts } from "../services/brave.js";
import { mergeAndDedup, applyRanking } from "../services/ranking.js";

export const searchRoute = new Hono();

searchRoute.post("/", async (c) => {
  const body = await c.req.json<SearchRequest>();
  const startTime = Date.now();

  console.log("[search] Received request for:", body.title ?? body.imageUrl);

  // Step 1: Identify the product
  let identification;
  try {
    identification = await identifyProduct(body.imageUrl, body.title);
    console.log("[search] Identified:", identification.category, "-", identification.description);
  } catch (err) {
    console.error("[search] Identification failed:", err);
    return c.json({ error: "Failed to identify product", details: String(err) }, 500);
  }

  // Step 2: Parallel search (Gemini Grounding + Brave)
  const searchQueries = identification.searchQueries;
  const perSourceTimeout = SEARCH_TIMEOUT_MS - 5000;

  const [groundingResult, braveResult] = await Promise.allSettled([
    withTimeout(groundedSearch(searchQueries, body.imageUrl), perSourceTimeout),
    withTimeout(searchProducts(searchQueries), perSourceTimeout),
  ]);

  const groundingResults: SearchResult[] =
    groundingResult.status === "fulfilled" ? groundingResult.value : [];
  const braveResults: SearchResult[] =
    braveResult.status === "fulfilled" ? braveResult.value : [];

  const groundingStatus = groundingResult.status === "fulfilled" ? "ok"
    : String(groundingResult.reason).includes("timeout") ? "timeout" : "error";
  const braveStatus = braveResult.status === "fulfilled" ? "ok"
    : String(braveResult.reason).includes("timeout") ? "timeout" : "error";

  console.log(`[search] Sources: grounding=${groundingResults.length} (${groundingStatus}), brave=${braveResults.length} (${braveStatus})`);

  // Step 3: Merge, dedup, and rank
  const allResults = mergeAndDedup([...groundingResults, ...braveResults]);
  const searchDurationMs = Date.now() - startTime;

  let rankedResults;
  const rankStart = Date.now();
  try {
    const scores = await rankResults(body.imageUrl, allResults, identification);
    rankedResults = applyRanking(allResults, scores, body.price);
  } catch (err) {
    console.error("[search] Ranking failed, returning unranked results:", err);
    rankedResults = applyRanking(allResults, {}, body.price);
  }
  const rankingDurationMs = Date.now() - rankStart;

  const response: SearchResponse = {
    requestId: crypto.randomUUID(),
    originalProduct: {
      title: body.title,
      price: body.price,
      currency: body.currency,
      imageUrl: body.imageUrl,
      identification,
    },
    results: rankedResults,
    searchMeta: {
      totalFound: allResults.length,
      braveResultCount: braveResults.length,
      groundingResultCount: groundingResults.length,
      sourceStatus: {
        brave: braveStatus as "ok" | "timeout" | "error",
        grounding: groundingStatus as "ok" | "timeout" | "error",
      },
      searchDurationMs,
      rankingDurationMs,
    },
  };

  console.log(`[search] Complete: ${rankedResults.length} ranked results in ${searchDurationMs + rankingDurationMs}ms`);
  return c.json(response);
});

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}
```

**Step 2: curl test the full pipeline**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm dev:backend &`

Then:

```bash
curl -X POST http://localhost:8080/search \
  -H "Content-Type: application/json" \
  -d '{
    "imageUrl": "https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg",
    "imageBase64": null,
    "title": "Sony WH-1000XM5 Wireless Noise Cancelling Headphones",
    "price": 348.00,
    "currency": "USD",
    "sourceUrl": "https://www.amazon.com/dp/B0BX2L8PBT"
  }'
```

Expected: Full SearchResponse JSON with ranked results, source metadata, timings.

**Step 3: Kill dev server and commit**

```bash
kill %1 2>/dev/null
git add packages/backend/src/routes/search.ts
git commit -m "feat: wire search pipeline — identify, parallel search, rank"
```

---

### Task 8: Implement Chat Endpoint

**Files:**
- Rewrite: `packages/backend/src/routes/chat.ts`

**Step 1: Implement Gemini-powered chat**

Replace the entire contents of `packages/backend/src/routes/chat.ts` with:

```typescript
import { Hono } from "hono";
import { GoogleGenAI } from "@google/genai";
import type { ChatRequest, ChatResponse } from "@shopping-assistant/shared";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export const chatRoute = new Hono();

chatRoute.post("/", async (c) => {
  const body = await c.req.json<ChatRequest>();

  console.log("[chat] Received message:", body.message);

  // Build system context
  const systemParts: string[] = [
    "You are a helpful shopping assistant. The user is comparing products and may ask about prices, quality, shipping, alternatives, or other buying decisions. Be concise and helpful.",
  ];

  if (body.context.product) {
    const p = body.context.product;
    systemParts.push(
      `\nThe user is currently looking at: "${p.title ?? "Unknown product"}" priced at ${p.price !== null ? `$${p.price}` : "unknown price"} on ${p.marketplace ?? "a shopping site"}.`,
    );
  }

  if (body.context.results?.length) {
    systemParts.push("\nSearch results found for comparison:");
    for (const r of body.context.results) {
      systemParts.push(
        `- "${r.result.title}" on ${r.result.marketplace}: ${r.result.price !== null ? `$${r.result.price}` : "price unknown"} (confidence: ${r.confidence}, ${r.comparisonNotes})`,
      );
    }
  }

  const contents = body.history.map((msg) => ({
    role: msg.role === "user" ? ("user" as const) : ("model" as const),
    parts: [{ text: msg.content }],
  }));

  contents.push({
    role: "user" as const,
    parts: [{ text: body.message }],
  });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents,
      config: { systemInstruction: systemParts.join("\n") },
    });

    const reply = response.text ?? "Sorry, I couldn't generate a response.";
    console.log("[chat] Reply:", reply.substring(0, 100) + "...");

    return c.json({ reply } satisfies ChatResponse);
  } catch (err) {
    console.error("[chat] Gemini error:", err);
    return c.json(
      { reply: "Sorry, something went wrong. Please try again." } satisfies ChatResponse,
      500,
    );
  }
});
```

**Step 2: curl test**

```bash
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Which headphones are best for noise cancellation?","context":{"product":null,"results":null},"history":[]}'
```

Expected: `{"reply":"..."}` with a real Gemini response.

**Step 3: Commit**

```bash
git add packages/backend/src/routes/chat.ts
git commit -m "feat: implement Gemini-powered chat endpoint with product context"
```

---

### Task 9: Backend Verification

**Step 1: Typecheck**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm --filter @shopping-assistant/backend typecheck`
Expected: No type errors.

**Step 2: Build**

Run: `pnpm build:backend`
Expected: `packages/backend/dist/index.js` exists.

**Step 3: Full endpoint test**

Start backend: `pnpm dev:backend &`

Test health: `curl http://localhost:8080/health`
Test search: (use the curl from Task 7)
Test chat: (use the curl from Task 8)

Kill: `kill %1 2>/dev/null`

**Step 4: Fix any issues and commit**

```bash
git add -A
git commit -m "chore: fix backend typecheck and build issues"
```

Phase 1 is complete when all three endpoints return real data from live APIs.

---

**Next phase:** `docs/plans/2026-03-02-phase2-extension.md` — Content script detection, service worker, side panel UI.
