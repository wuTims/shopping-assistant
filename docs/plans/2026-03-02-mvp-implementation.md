# MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the full Shopping Source Discovery Agent MVP — product detection on Amazon/eBay, search pipeline (Gemini + Brave), results UI, text chat, and voice via Gemini Live API.

**Architecture:** Backend-first approach. Build and curl-test all API endpoints before touching the extension. The backend is a stateless Hono server with three responsibilities: search orchestration (identify → parallel search → rank), text chat, and Live API WebSocket proxy. The extension detects products via DOM heuristics, displays results in a side panel, and connects to the backend for search/chat/voice.

**Tech Stack:** TypeScript 5.x, pnpm workspaces, Hono 4, `@google/genai` SDK, Brave Web Search API, React 19, Vite 6 + CRXJS, Web Audio API

---

### Task 1: Install Backend Dependencies and Configure Environment

**Files:**
- Modify: `packages/backend/package.json`
- Create: `packages/backend/.env.example`
- Create: `packages/backend/.env`
- Modify: `packages/backend/src/index.ts`

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

The user must provision these:
- Gemini: https://aistudio.google.com/apikey
- Brave: https://api-dashboard.search.brave.com/app/keys

**Step 4: Add dotenv loading to backend entry**

Modify `packages/backend/src/index.ts` — add at the very top, before all other imports:

```typescript
import "dotenv/config";
```

Wait — Hono on Node.js with tsx already reads `.env` if you use `--env-file`. Instead, use Node's native `--env-file` flag. Modify the dev script in `packages/backend/package.json`:

Change the `dev` script from:
```json
"dev": "tsx watch src/index.ts"
```
to:
```json
"dev": "tsx watch --env-file=.env src/index.ts"
```

**Step 5: Verify .env is in .gitignore**

Check the root `.gitignore` already includes `.env` and `.env.local`. It does (from scaffolding).

**Step 6: Verify backend starts with env vars**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && timeout 5 pnpm dev:backend 2>&1 || true`
Expected: Logs "Backend running on http://localhost:8080" (or env var errors if keys not set yet — that's fine).

**Step 7: Commit**

```bash
git add packages/backend/package.json packages/backend/.env.example pnpm-lock.yaml .gitignore
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

**Step 2: Quick smoke test with curl**

Start the backend, then create a temporary test script. We'll test identification by calling it directly in a one-off Node script.

Create `packages/backend/test-identify.ts` (temporary, delete after):

```typescript
import "dotenv/config";
import { identifyProduct } from "./src/services/gemini.js";

const testImageUrl = "https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg";

async function main() {
  console.log("Testing identifyProduct...");
  const result = await identifyProduct(testImageUrl, "Sony WH-1000XM5 Headphones");
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
```

Run: `cd /workspaces/web-dev-playground/shopping-assistant/packages/backend && npx tsx test-identify.ts`
Expected: Structured JSON with category, description, brand, attributes, searchQueries.

**Step 3: Clean up test file and commit**

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

In `packages/backend/src/services/gemini.ts`, replace the `groundedSearch` stub with:

```typescript
import type {
  ProductIdentification,
  SearchResult,
} from "@shopping-assistant/shared";

/**
 * Use Gemini with google_search tool to find product listings.
 * Returns raw SearchResult[] from grounding chunks.
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
      price: null, // Grounding doesn't give structured prices
      currency: null,
      imageUrl: null,
      productUrl: chunk.web!.uri!,
      marketplace: extractMarketplace(chunk.web!.uri!),
      snippet: findSupportingText(i, groundingSupports),
      structuredData: null,
      raw: { chunk, responseText: response.text },
    }));
}

function extractMarketplace(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    // Map known domains to clean names
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

Note: The `extractMarketplace` and `findSupportingText` helpers are module-level functions at the bottom of the file.

**Step 2: Smoke test**

Create `packages/backend/test-grounded.ts` (temporary):

```typescript
import "dotenv/config";
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

Run: `cd /workspaces/web-dev-playground/shopping-assistant/packages/backend && npx tsx test-grounded.ts`
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
  meta_url?: {
    hostname?: string;
  };
  thumbnail?: {
    src?: string;
    original?: string;
  } | null;
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
    rating?: {
      ratingValue?: number;
      reviewCount?: number;
    } | null;
    thumbnail?: { src?: string } | null;
  }> | null;
}

interface BraveSearchResponse {
  query?: { original?: string };
  web?: { results?: BraveWebResult[] };
}

/**
 * Search Brave Web Search API for product listings.
 * Sends multiple queries and merges results.
 */
export async function searchProducts(
  queries: string[],
): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error("BRAVE_API_KEY not set");

  // Run all queries in parallel
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

    // Check for product cluster data (structured product info)
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
      // Regular web result — try to extract price from snippets
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

function parsePrice(value: string | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractPriceFromText(text: string): string | null {
  // Match patterns like $29.99, $1,299.00, €49.99
  const match = text.match(/[\$\€\£]\s?[\d,]+\.?\d{0,2}/);
  return match ? match[0] : null;
}
```

**Step 2: Smoke test**

Create `packages/backend/test-brave.ts` (temporary):

```typescript
import "dotenv/config";
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

Run: `cd /workspaces/web-dev-playground/shopping-assistant/packages/backend && npx tsx test-brave.ts`
Expected: Multiple SearchResult objects with prices from shopping sites.

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
      // Keep the one with more data (prefer Brave's structured data)
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
      rank: 0, // Set after sorting
    };
  });

  // Sort: highest confidence first, then most savings
  ranked.sort((a, b) => {
    if (b.confidenceScore !== a.confidenceScore) {
      return b.confidenceScore - a.confidenceScore;
    }
    // Among equal confidence, prefer bigger savings
    return (b.savingsPercent ?? -Infinity) - (a.savingsPercent ?? -Infinity);
  });

  // Assign rank numbers
  ranked.forEach((r, i) => {
    r.rank = i + 1;
  });

  return ranked;
}

/**
 * Normalize URL for deduplication — remove tracking params, normalize scheme.
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove common tracking parameters
    const trackingParams = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "tag", "linkCode", "linkId", "camp", "creative",
      "fbclid", "gclid", "dclid", "msclkid",
    ];
    for (const param of trackingParams) {
      u.searchParams.delete(param);
    }
    // Normalize to lowercase hostname
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

In `packages/backend/src/services/gemini.ts`, replace the `rankResults` stub with the real implementation:

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

  // Build comparison data — include results that have images
  const resultsWithImages = results.filter((r) => r.imageUrl);
  const resultsWithoutImages = results.filter((r) => !r.imageUrl);

  // Fetch original image
  const origResponse = await fetch(originalImageUrl);
  if (!origResponse.ok) {
    throw new Error(`Failed to fetch original image: ${origResponse.status}`);
  }
  const origBuffer = await origResponse.arrayBuffer();
  const origBase64 = Buffer.from(origBuffer).toString("base64");
  const origMimeType = origResponse.headers.get("content-type") ?? "image/jpeg";

  // Build the content parts: original image + descriptions of results
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

Be generous with similar products — alternatives from other brands that serve the same purpose should score 0.4-0.6. Only score below 0.3 if the product is clearly unrelated.
Results without images should be scored based on title/description similarity only.`,
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

Also add the `SearchResult` import at the top of the file (alongside `ProductIdentification`):

```typescript
import type {
  ProductIdentification,
  SearchResult,
} from "@shopping-assistant/shared";
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

  // === Step 1: Identify the product ===
  let identification;
  try {
    identification = await identifyProduct(body.imageUrl, body.title);
    console.log("[search] Identified:", identification.category, "-", identification.description);
  } catch (err) {
    console.error("[search] Identification failed:", err);
    return c.json(
      { error: "Failed to identify product", details: String(err) },
      500,
    );
  }

  // === Step 2: Parallel search (Gemini Grounding + Brave) ===
  const searchQueries = identification.searchQueries;
  const perSourceTimeout = SEARCH_TIMEOUT_MS - 5000; // Leave room for ranking

  const [groundingResult, braveResult] = await Promise.allSettled([
    withTimeout(
      groundedSearch(searchQueries, body.imageUrl),
      perSourceTimeout,
    ),
    withTimeout(searchProducts(searchQueries), perSourceTimeout),
  ]);

  const groundingResults: SearchResult[] =
    groundingResult.status === "fulfilled" ? groundingResult.value : [];
  const braveResults: SearchResult[] =
    braveResult.status === "fulfilled" ? braveResult.value : [];

  const groundingStatus =
    groundingResult.status === "fulfilled"
      ? "ok"
      : String(groundingResult.reason).includes("timeout")
        ? "timeout"
        : "error";
  const braveStatus =
    braveResult.status === "fulfilled"
      ? "ok"
      : String(braveResult.reason).includes("timeout")
        ? "timeout"
        : "error";

  console.log(
    `[search] Sources: grounding=${groundingResults.length} (${groundingStatus}), brave=${braveResults.length} (${braveStatus})`,
  );

  // === Step 3: Merge, dedup, and rank ===
  const allResults = mergeAndDedup([...groundingResults, ...braveResults]);
  const searchDurationMs = Date.now() - startTime;

  let rankedResults;
  const rankStart = Date.now();
  try {
    const scores = await rankResults(body.imageUrl, allResults, identification);
    rankedResults = applyRanking(allResults, scores, body.price);
  } catch (err) {
    console.error("[search] Ranking failed, returning unranked results:", err);
    // Fallback: return results with default scores
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

  console.log(
    `[search] Complete: ${rankedResults.length} ranked results in ${searchDurationMs + rankingDurationMs}ms`,
  );

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

Start the backend, then test:

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

**Step 3: Kill the dev server and commit**

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

  // Build system context from product and results
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

  // Build conversation history
  const contents = body.history.map((msg) => ({
    role: msg.role === "user" ? ("user" as const) : ("model" as const),
    parts: [{ text: msg.content }],
  }));

  // Add current message
  contents.push({
    role: "user" as const,
    parts: [{ text: body.message }],
  });

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents,
      config: {
        systemInstruction: systemParts.join("\n"),
      },
    });

    const reply = response.text ?? "Sorry, I couldn't generate a response.";
    console.log("[chat] Reply:", reply.substring(0, 100) + "...");

    const chatResponse: ChatResponse = { reply };
    return c.json(chatResponse);
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
  -d '{
    "message": "Is the AliExpress option likely the same quality?",
    "context": {
      "product": null,
      "results": null
    },
    "history": []
  }'
```

Expected: `{ "reply": "..." }` with a real Gemini response.

**Step 3: Commit**

```bash
git add packages/backend/src/routes/chat.ts
git commit -m "feat: implement Gemini-powered chat endpoint with product context"
```

---

### Task 9: Implement Content Script — Product Detection

**Files:**
- Rewrite: `packages/extension/src/content/index.ts`

**Step 1: Implement DOM heuristics for product detection**

Replace the entire contents of `packages/extension/src/content/index.ts` with:

```typescript
import type { DetectedProduct } from "@shopping-assistant/shared";
import {
  MAX_OVERLAYS_PER_PAGE,
  MIN_IMAGE_SIZE_PX,
  OVERLAY_ICON_SIZE_PX,
  OVERLAY_ICON_HOVER_SIZE_PX,
} from "@shopping-assistant/shared";

console.log("[Shopping Assistant] Content script loaded");

// ===== Detection Heuristics =====

function detectProducts(): DetectedProduct[] {
  const products: DetectedProduct[] = [];

  // Strategy 1: JSON-LD / schema.org Product markup
  const jsonLdProducts = detectFromJsonLd();
  products.push(...jsonLdProducts);

  // Strategy 2: Open Graph product tags
  if (products.length === 0) {
    const ogProducts = detectFromOpenGraph();
    products.push(...ogProducts);
  }

  // Strategy 3: Amazon-specific selectors
  if (products.length === 0 && isAmazon()) {
    const amazonProducts = detectFromAmazon();
    products.push(...amazonProducts);
  }

  // Strategy 4: eBay-specific selectors
  if (products.length === 0 && isEbay()) {
    const ebayProducts = detectFromEbay();
    products.push(...ebayProducts);
  }

  return products.slice(0, MAX_OVERLAYS_PER_PAGE);
}

function detectFromJsonLd(): DetectedProduct[] {
  const products: DetectedProduct[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (item["@type"] === "Product" || item["@type"]?.includes?.("Product")) {
          const imageUrl = extractImageUrl(item.image);
          if (!imageUrl) continue;

          const imageEl = findImageElement(imageUrl);
          if (!imageEl) continue;

          const price = extractSchemaPrice(item);

          products.push({
            id: hashString(imageUrl + window.location.href),
            imageUrl,
            title: item.name ?? null,
            price: price?.value ?? null,
            currency: price?.currency ?? null,
            pageUrl: window.location.href,
            marketplace: window.location.hostname.replace("www.", ""),
            schemaData: item,
            boundingRect: imageEl.getBoundingClientRect(),
            detectedAt: Date.now(),
          });
        }
      }
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  return products;
}

function detectFromOpenGraph(): DetectedProduct[] {
  const ogImage = getMeta("og:image");
  const ogTitle = getMeta("og:title");
  const ogPrice =
    getMeta("og:price:amount") ??
    getMeta("product:price:amount");
  const ogCurrency =
    getMeta("og:price:currency") ??
    getMeta("product:price:currency");

  if (!ogImage) return [];

  const imageEl = findImageElement(ogImage);
  if (!imageEl) return [];

  return [
    {
      id: hashString(ogImage + window.location.href),
      imageUrl: ogImage,
      title: ogTitle,
      price: ogPrice ? parseFloat(ogPrice) : null,
      currency: ogCurrency,
      pageUrl: window.location.href,
      marketplace: window.location.hostname.replace("www.", ""),
      schemaData: null,
      boundingRect: imageEl.getBoundingClientRect(),
      detectedAt: Date.now(),
    },
  ];
}

function detectFromAmazon(): DetectedProduct[] {
  const titleEl = document.getElementById("productTitle");
  const title = titleEl?.textContent?.trim() ?? null;

  const priceEl =
    document.querySelector(".a-price .a-offscreen") ??
    document.getElementById("priceblock_ourprice") ??
    document.querySelector("#corePrice_feature_div .a-offscreen");
  const priceText = priceEl?.textContent?.trim();
  const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, "")) : null;

  const imageEl =
    (document.getElementById("landingImage") as HTMLImageElement) ??
    (document.getElementById("imgBlkFront") as HTMLImageElement) ??
    (document.querySelector("#imageBlock img") as HTMLImageElement);

  if (!imageEl?.src) return [];

  return [
    {
      id: hashString(imageEl.src + window.location.href),
      imageUrl: imageEl.src,
      title,
      price: price && !isNaN(price) ? price : null,
      currency: price !== null ? "USD" : null,
      pageUrl: window.location.href,
      marketplace: "amazon.com",
      schemaData: null,
      boundingRect: imageEl.getBoundingClientRect(),
      detectedAt: Date.now(),
    },
  ];
}

function detectFromEbay(): DetectedProduct[] {
  const titleEl = document.querySelector(".x-item-title__mainTitle span");
  const title = titleEl?.textContent?.trim() ?? null;

  const priceEl = document.querySelector(".x-price-primary span");
  const priceText = priceEl?.textContent?.trim();
  const price = priceText ? parseFloat(priceText.replace(/[^0-9.]/g, "")) : null;

  const imageEl = document.querySelector(
    ".ux-image-carousel-item img, .image-treatment img",
  ) as HTMLImageElement | null;

  if (!imageEl?.src) return [];

  return [
    {
      id: hashString(imageEl.src + window.location.href),
      imageUrl: imageEl.src,
      title,
      price: price && !isNaN(price) ? price : null,
      currency: price !== null ? "USD" : null,
      pageUrl: window.location.href,
      marketplace: "ebay.com",
      schemaData: null,
      boundingRect: imageEl.getBoundingClientRect(),
      detectedAt: Date.now(),
    },
  ];
}

// ===== Overlay Injection =====

function injectOverlays(products: DetectedProduct[]): void {
  for (const product of products) {
    const imageEl = findImageElement(product.imageUrl);
    if (!imageEl) continue;

    // Don't inject twice
    if (imageEl.dataset.shoppingAssistant) continue;
    imageEl.dataset.shoppingAssistant = "true";

    const container = imageEl.parentElement;
    if (!container) continue;

    // Ensure parent is positioned
    const containerStyle = getComputedStyle(container);
    if (containerStyle.position === "static") {
      container.style.position = "relative";
    }

    const overlay = document.createElement("button");
    overlay.className = "shopping-assistant-overlay";
    overlay.setAttribute("aria-label", "Find cheaper alternatives");
    overlay.title = "Find cheaper alternatives";
    overlay.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`;

    Object.assign(overlay.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      width: `${OVERLAY_ICON_SIZE_PX}px`,
      height: `${OVERLAY_ICON_SIZE_PX}px`,
      borderRadius: "50%",
      border: "1px solid #e5e7eb",
      background: "rgba(255, 255, 255, 0.9)",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "999999",
      padding: "0",
      color: "#1f2937",
      boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
      transition: "all 0.15s ease",
    });

    overlay.addEventListener("mouseenter", () => {
      overlay.style.width = `${OVERLAY_ICON_HOVER_SIZE_PX}px`;
      overlay.style.height = `${OVERLAY_ICON_HOVER_SIZE_PX}px`;
      overlay.style.background = "rgba(255, 255, 255, 1)";
      overlay.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    });

    overlay.addEventListener("mouseleave", () => {
      overlay.style.width = `${OVERLAY_ICON_SIZE_PX}px`;
      overlay.style.height = `${OVERLAY_ICON_SIZE_PX}px`;
      overlay.style.background = "rgba(255, 255, 255, 0.9)";
      overlay.style.boxShadow = "0 1px 3px rgba(0,0,0,0.12)";
    });

    overlay.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({
        type: "PRODUCT_CLICKED",
        product,
      });
    });

    container.appendChild(overlay);
  }
}

// ===== Helpers =====

function isAmazon(): boolean {
  return window.location.hostname.includes("amazon.");
}

function isEbay(): boolean {
  return window.location.hostname.includes("ebay.");
}

function getMeta(property: string): string | null {
  const el = document.querySelector(
    `meta[property="${property}"], meta[name="${property}"]`,
  );
  return el?.getAttribute("content") ?? null;
}

function extractImageUrl(image: unknown): string | null {
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return extractImageUrl(image[0]);
  if (typeof image === "object" && image !== null && "url" in image) {
    return (image as { url: string }).url;
  }
  return null;
}

function extractSchemaPrice(
  item: Record<string, unknown>,
): { value: number; currency: string } | null {
  const offers = item.offers as Record<string, unknown> | undefined;
  if (!offers) return null;

  const offerList = Array.isArray(offers) ? offers : [offers];
  for (const offer of offerList) {
    const price = parseFloat(String(offer.price ?? offer.lowPrice ?? ""));
    const currency = String(offer.priceCurrency ?? "USD");
    if (!isNaN(price)) return { value: price, currency };
  }
  return null;
}

function findImageElement(imageUrl: string): HTMLImageElement | null {
  const images = document.querySelectorAll("img");
  for (const img of images) {
    if (
      img.src === imageUrl ||
      img.currentSrc === imageUrl ||
      img.dataset.src === imageUrl
    ) {
      const rect = img.getBoundingClientRect();
      if (rect.width >= MIN_IMAGE_SIZE_PX && rect.height >= MIN_IMAGE_SIZE_PX) {
        return img;
      }
    }
  }
  return null;
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `product-${Math.abs(hash).toString(36)}`;
}

// ===== Init =====

function init(): void {
  const products = detectProducts();
  if (products.length > 0) {
    console.log(`[Shopping Assistant] Detected ${products.length} product(s)`);
    injectOverlays(products);

    // Notify service worker of detection count
    chrome.runtime.sendMessage({
      type: "PRODUCTS_DETECTED",
      count: products.length,
      products,
    });
  }
}

// Run on page load
init();

// Re-detect on SPA navigation
let lastUrl = window.location.href;
const observer = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    // Remove old overlays
    document.querySelectorAll(".shopping-assistant-overlay").forEach((el) => el.remove());
    document.querySelectorAll("[data-shopping-assistant]").forEach((el) => {
      delete (el as HTMLElement).dataset.shoppingAssistant;
    });
    // Re-detect after DOM settles
    setTimeout(init, 1000);
  }
});
observer.observe(document.body, { childList: true, subtree: true });
```

**Step 2: Commit**

```bash
git add packages/extension/src/content/index.ts
git commit -m "feat: implement product detection with Amazon/eBay heuristics and overlay injection"
```

---

### Task 10: Implement Service Worker — Message Routing and Cache

**Files:**
- Rewrite: `packages/extension/src/background/index.ts`

**Step 1: Implement service worker with cache and message routing**

Replace the entire contents of `packages/extension/src/background/index.ts` with:

```typescript
import type {
  DetectedProduct,
  SearchRequest,
  SearchResponse,
  CachedSearch,
} from "@shopping-assistant/shared";
import {
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  CACHE_SESSION_THRESHOLD_MS,
} from "@shopping-assistant/shared";

console.log("[Shopping Assistant] Service worker started");

// Backend URL — default to localhost for development
const BACKEND_URL = "http://localhost:8080";

// ===== Extension Icon Click =====

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id });
  }
});

// ===== Message Handling =====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRODUCT_CLICKED") {
    handleProductClick(message.product, sender.tab?.id);
    sendResponse({ status: "ok" });
  } else if (message.type === "PRODUCTS_DETECTED") {
    console.log(
      `[SW] Detected ${message.count} products on tab ${sender.tab?.id}`,
    );
    // Update badge with product count
    if (sender.tab?.id) {
      chrome.action.setBadgeText({
        text: String(message.count),
        tabId: sender.tab.id,
      });
      chrome.action.setBadgeBackgroundColor({
        color: "#6366f1",
        tabId: sender.tab.id,
      });
    }
    sendResponse({ status: "ok" });
  } else if (message.type === "CHAT_REQUEST") {
    handleChatRequest(message.payload).then(sendResponse);
    return true; // Keep message channel open for async response
  } else if (message.type === "GET_BACKEND_URL") {
    sendResponse({ url: BACKEND_URL });
    return false;
  }
  return true;
});

// ===== Product Click Handler =====

async function handleProductClick(
  product: DetectedProduct,
  tabId?: number,
): Promise<void> {
  // Open side panel
  if (tabId) {
    chrome.sidePanel.open({ tabId });
  }

  // Notify side panel: loading started
  broadcastToSidePanel({
    type: "SEARCH_STARTED",
    product,
  });

  // Check cache
  const cached = await getCachedSearch(product.id);
  if (cached) {
    console.log("[SW] Cache hit for product:", product.id);
    broadcastToSidePanel({
      type: "SEARCH_COMPLETE",
      product,
      response: cached.response,
      fromCache: true,
    });
    return;
  }

  // Cache miss — make API request
  console.log("[SW] Cache miss, searching for:", product.title ?? product.imageUrl);

  const searchRequest: SearchRequest = {
    imageUrl: product.imageUrl,
    imageBase64: null,
    title: product.title,
    price: product.price,
    currency: product.currency,
    sourceUrl: product.pageUrl,
  };

  try {
    const response = await fetch(`${BACKEND_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchRequest),
    });

    if (!response.ok) {
      throw new Error(`Search failed: ${response.status}`);
    }

    const searchResponse = (await response.json()) as SearchResponse;

    // Cache the result
    await cacheSearch(product.id, searchResponse);

    // Send to side panel
    broadcastToSidePanel({
      type: "SEARCH_COMPLETE",
      product,
      response: searchResponse,
      fromCache: false,
    });
  } catch (err) {
    console.error("[SW] Search error:", err);
    broadcastToSidePanel({
      type: "SEARCH_ERROR",
      product,
      error: String(err),
    });
  }
}

// ===== Chat Handler =====

async function handleChatRequest(payload: unknown): Promise<unknown> {
  try {
    const response = await fetch(`${BACKEND_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Chat failed: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    console.error("[SW] Chat error:", err);
    return { reply: "Sorry, something went wrong. Please try again." };
  }
}

// ===== Cache Operations =====

async function getCachedSearch(
  productId: string,
): Promise<CachedSearch | null> {
  const key = `search_${productId}`;
  const result = await chrome.storage.local.get(key);
  const cached = result[key] as CachedSearch | undefined;

  if (!cached) return null;

  // Check TTL
  if (Date.now() - cached.cachedAt > cached.ttl) {
    await chrome.storage.local.remove(key);
    return null;
  }

  return cached;
}

async function cacheSearch(
  productId: string,
  response: SearchResponse,
): Promise<void> {
  const entry: CachedSearch = {
    productId,
    response,
    cachedAt: Date.now(),
    ttl: CACHE_TTL_MS,
  };

  await chrome.storage.local.set({ [`search_${productId}`]: entry });

  // Enforce max entries (LRU eviction)
  await evictOldEntries();
}

async function evictOldEntries(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const cacheEntries: Array<[string, CachedSearch]> = Object.entries(all)
    .filter(([key]) => key.startsWith("search_"))
    .map(([key, value]) => [key, value as CachedSearch]);

  if (cacheEntries.length <= CACHE_MAX_ENTRIES) return;

  // Sort by cachedAt ascending (oldest first)
  cacheEntries.sort((a, b) => a[1].cachedAt - b[1].cachedAt);

  // Remove oldest entries
  const toRemove = cacheEntries.slice(
    0,
    cacheEntries.length - CACHE_MAX_ENTRIES,
  );
  await chrome.storage.local.remove(toRemove.map(([key]) => key));
}

// ===== Broadcast to Side Panel =====

function broadcastToSidePanel(message: unknown): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Side panel may not be open yet — that's fine
  });
}

// ===== Startup Cleanup =====

chrome.runtime.onInstalled.addListener(async () => {
  // Clean expired entries
  const all = await chrome.storage.local.get(null);
  const keysToRemove: string[] = [];

  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("search_")) continue;
    const entry = value as CachedSearch;
    if (Date.now() - entry.cachedAt > CACHE_SESSION_THRESHOLD_MS) {
      keysToRemove.push(key);
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
    console.log(`[SW] Cleaned ${keysToRemove.length} expired cache entries`);
  }
});
```

**Step 2: Commit**

```bash
git add packages/extension/src/background/index.ts
git commit -m "feat: implement service worker with cache management and message routing"
```

---

### Task 11: Implement Side Panel UI — Results View

**Files:**
- Rewrite: `packages/extension/src/sidepanel/App.tsx`
- Rewrite: `packages/extension/src/sidepanel/App.css`

**Step 1: Build the full side panel React app**

Replace the entire contents of `packages/extension/src/sidepanel/App.tsx` with:

```tsx
import { useState, useEffect, useRef } from "react";
import type {
  DetectedProduct,
  SearchResponse,
  RankedResult,
  ChatMessage,
  ChatRequest,
  ChatResponse,
} from "@shopping-assistant/shared";
import { MAX_CHAT_HISTORY } from "@shopping-assistant/shared";

type View = "empty" | "loading" | "results" | "chat" | "error";
type LoadingPhase =
  | "identifying"
  | "searching"
  | "comparing"
  | "complete";

interface AppState {
  view: View;
  loadingPhase: LoadingPhase;
  product: DetectedProduct | null;
  response: SearchResponse | null;
  fromCache: boolean;
  error: string | null;
  chatMessages: ChatMessage[];
  chatInput: string;
  chatLoading: boolean;
}

export default function App() {
  const [state, setState] = useState<AppState>({
    view: "empty",
    loadingPhase: "identifying",
    product: null,
    response: null,
    fromCache: false,
    error: null,
    chatMessages: [],
    chatInput: "",
    chatLoading: false,
  });

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Listen for messages from service worker
  useEffect(() => {
    const listener = (message: Record<string, unknown>) => {
      if (message.type === "SEARCH_STARTED") {
        setState((prev) => ({
          ...prev,
          view: "loading",
          loadingPhase: "identifying",
          product: message.product as DetectedProduct,
          response: null,
          error: null,
          chatMessages: [],
        }));

        // Simulate phase progression
        setTimeout(
          () =>
            setState((prev) =>
              prev.view === "loading"
                ? { ...prev, loadingPhase: "searching" }
                : prev,
            ),
          1500,
        );
        setTimeout(
          () =>
            setState((prev) =>
              prev.view === "loading"
                ? { ...prev, loadingPhase: "comparing" }
                : prev,
            ),
          4000,
        );
      } else if (message.type === "SEARCH_COMPLETE") {
        setState((prev) => ({
          ...prev,
          view: "results",
          loadingPhase: "complete",
          response: message.response as SearchResponse,
          fromCache: message.fromCache as boolean,
        }));
      } else if (message.type === "SEARCH_ERROR") {
        setState((prev) => ({
          ...prev,
          view: "error",
          error: message.error as string,
        }));
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.chatMessages]);

  const handleSendChat = async () => {
    const text = state.chatInput.trim();
    if (!text || state.chatLoading) return;

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: text,
      inputMode: "text",
      timestamp: Date.now(),
      context: null,
    };

    const updatedMessages = [...state.chatMessages, userMessage];
    setState((prev) => ({
      ...prev,
      chatMessages: updatedMessages,
      chatInput: "",
      chatLoading: true,
    }));

    const chatRequest: ChatRequest = {
      message: text,
      context: {
        product: state.product,
        results: state.response?.results ?? null,
      },
      history: updatedMessages.slice(-MAX_CHAT_HISTORY),
    };

    try {
      const response = await chrome.runtime.sendMessage({
        type: "CHAT_REQUEST",
        payload: chatRequest,
      }) as ChatResponse;

      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: response.reply,
        inputMode: "text",
        timestamp: Date.now(),
        context: null,
      };

      setState((prev) => ({
        ...prev,
        chatMessages: [...prev.chatMessages, assistantMessage],
        chatLoading: false,
      }));
    } catch {
      setState((prev) => ({
        ...prev,
        chatLoading: false,
      }));
    }
  };

  return (
    <div className="panel">
      <header className="header">
        {state.view === "chat" ? (
          <>
            <button
              className="back-btn"
              onClick={() =>
                setState((prev) => ({ ...prev, view: "results" }))
              }
            >
              ← Back
            </button>
            <h1>Shopping Assistant</h1>
          </>
        ) : (
          <h1>Shopping Assistant</h1>
        )}
      </header>

      <main className="main">
        {state.view === "empty" && <EmptyState />}
        {state.view === "loading" && (
          <LoadingState product={state.product} phase={state.loadingPhase} />
        )}
        {state.view === "results" && state.response && (
          <ResultsView
            product={state.product}
            response={state.response}
            fromCache={state.fromCache}
            onOpenChat={() =>
              setState((prev) => ({ ...prev, view: "chat" }))
            }
          />
        )}
        {state.view === "chat" && (
          <ChatView
            messages={state.chatMessages}
            input={state.chatInput}
            loading={state.chatLoading}
            onInputChange={(v) =>
              setState((prev) => ({ ...prev, chatInput: v }))
            }
            onSend={handleSendChat}
            chatEndRef={chatEndRef}
          />
        )}
        {state.view === "error" && (
          <ErrorState
            error={state.error}
            onRetry={() => {
              if (state.product) {
                chrome.runtime.sendMessage({
                  type: "PRODUCT_CLICKED",
                  product: state.product,
                });
              }
            }}
          />
        )}
      </main>
    </div>
  );
}

// ===== Sub-components =====

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-icon">🔍</div>
      <p>Click a product overlay to search for cheaper alternatives.</p>
    </div>
  );
}

function LoadingState({
  product,
  phase,
}: {
  product: DetectedProduct | null;
  phase: LoadingPhase;
}) {
  const phaseText: Record<LoadingPhase, string> = {
    identifying: "Identifying product...",
    searching: "Searching across marketplaces...",
    comparing: "Comparing results...",
    complete: "Done!",
  };

  return (
    <div className="loading-state">
      {product && (
        <div className="original-product-mini">
          <img src={product.imageUrl} alt="" className="product-thumb" />
          <div>
            <p className="product-title-small">
              {product.title ?? "Detected product"}
            </p>
            {product.price !== null && (
              <p className="product-price-small">
                {product.currency ?? "$"}
                {product.price.toFixed(2)}
              </p>
            )}
          </div>
        </div>
      )}
      <div className="spinner" />
      <p className="loading-text">{phaseText[phase]}</p>
    </div>
  );
}

function ResultsView({
  product,
  response,
  fromCache,
  onOpenChat,
}: {
  product: DetectedProduct | null;
  response: SearchResponse;
  fromCache: boolean;
  onOpenChat: () => void;
}) {
  const { results, originalProduct, searchMeta } = response;
  const bestPrice =
    results.length > 0
      ? Math.min(
          ...results
            .filter((r) => r.result.price !== null)
            .map((r) => r.result.price!),
        )
      : null;
  const worstPrice =
    results.length > 0
      ? Math.max(
          ...results
            .filter((r) => r.result.price !== null)
            .map((r) => r.result.price!),
        )
      : null;

  return (
    <div className="results-view">
      {/* Original Product */}
      <div className="original-product">
        <img
          src={originalProduct.imageUrl}
          alt=""
          className="product-thumb"
        />
        <div className="original-info">
          <p className="product-title">
            {originalProduct.title ?? "Original product"}
          </p>
          {originalProduct.price !== null && (
            <p className="product-price">
              {originalProduct.currency ?? "$"}
              {originalProduct.price.toFixed(2)}
            </p>
          )}
          <p className="product-meta">
            {originalProduct.identification.category}
            {fromCache && <span className="cache-badge">Cached</span>}
          </p>
        </div>
      </div>

      {/* Price Context Bar */}
      {originalProduct.price !== null &&
        bestPrice !== null &&
        worstPrice !== null && (
          <PriceBar
            originalPrice={originalProduct.price}
            low={bestPrice}
            high={Math.max(worstPrice, originalProduct.price)}
          />
        )}

      {/* Results */}
      <div className="results-header">
        <h2>
          Top results ({results.length})
        </h2>
        <span className="search-time">
          {(searchMeta.searchDurationMs / 1000).toFixed(1)}s
        </span>
      </div>

      {results.length === 0 ? (
        <p className="no-results">No alternatives found for this product.</p>
      ) : (
        <div className="results-list">
          {results.map((r) => (
            <ProductCard key={r.result.id} ranked={r} />
          ))}
        </div>
      )}

      {/* Partial results notice */}
      {(searchMeta.sourceStatus.brave !== "ok" ||
        searchMeta.sourceStatus.grounding !== "ok") && (
        <p className="partial-notice">
          Some sources didn't respond — results may be incomplete.
        </p>
      )}

      {/* Chat button */}
      <button className="chat-btn" onClick={onOpenChat}>
        Chat Now
      </button>
    </div>
  );
}

function PriceBar({
  originalPrice,
  low,
  high,
}: {
  originalPrice: number;
  low: number;
  high: number;
}) {
  const range = high - low || 1;
  const position = ((originalPrice - low) / range) * 100;
  const clamped = Math.max(0, Math.min(100, position));

  let label: string;
  if (clamped > 66) label = "This price is high";
  else if (clamped > 33) label = "This price is fair";
  else label = "This price is low";

  return (
    <div className="price-bar-container">
      <p className="price-label">{label}</p>
      <div className="price-bar">
        <div className="price-marker" style={{ left: `${clamped}%` }} />
      </div>
      <div className="price-range">
        <span>${low.toFixed(0)}</span>
        <span>${high.toFixed(0)}</span>
      </div>
    </div>
  );
}

function ProductCard({ ranked }: { ranked: RankedResult }) {
  const { result, confidence, savingsPercent, comparisonNotes } = ranked;

  return (
    <a
      href={result.productUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="product-card"
    >
      {result.imageUrl ? (
        <img src={result.imageUrl} alt="" className="card-thumb" />
      ) : (
        <div className="card-thumb card-thumb-placeholder">📦</div>
      )}
      <div className="card-info">
        <p className="card-title">{result.title}</p>
        <div className="card-price-row">
          {result.price !== null && (
            <span className="card-price">
              {result.currency ?? "$"}
              {result.price.toFixed(2)}
            </span>
          )}
          {savingsPercent !== null && savingsPercent > 0 && (
            <span className="savings-badge">{savingsPercent}% less</span>
          )}
        </div>
        <div className="card-meta-row">
          <span className="marketplace-label">{result.marketplace}</span>
          {confidence !== "high" && (
            <span
              className={`confidence-label confidence-${confidence}`}
            >
              {confidence === "medium" ? "Similar" : "May differ"}
            </span>
          )}
        </div>
        {comparisonNotes && (
          <p className="card-notes">{comparisonNotes}</p>
        )}
      </div>
    </a>
  );
}

function ChatView({
  messages,
  input,
  loading,
  onInputChange,
  onSend,
  chatEndRef,
}: {
  messages: ChatMessage[];
  input: string;
  loading: boolean;
  onInputChange: (v: string) => void;
  onSend: () => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="chat-view">
      <div className="chat-thread">
        {messages.length === 0 && (
          <div className="chat-greeting">
            <p>Hi! Ask me anything about these products.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-bubble chat-${msg.role}`}
          >
            {msg.content}
          </div>
        ))}
        {loading && (
          <div className="chat-bubble chat-assistant">
            <span className="typing-indicator">...</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      <div className="chat-input-area">
        <input
          type="text"
          className="chat-input"
          placeholder="Ask about these products..."
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSend()}
          disabled={loading}
        />
        <button
          className="send-btn"
          onClick={onSend}
          disabled={loading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function ErrorState({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="error-state">
      <p>Couldn't find alternatives for this product.</p>
      {error && <p className="error-detail">{error}</p>}
      <button className="retry-btn" onClick={onRetry}>
        Try Again
      </button>
    </div>
  );
}
```

**Step 2: Replace the CSS**

Replace the entire contents of `packages/extension/src/sidepanel/App.css` with:

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1f2937;
  background: #ffffff;
  width: 360px;
}

.panel {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* Header */
.header {
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  gap: 8px;
}

.header h1 {
  font-size: 16px;
  font-weight: 600;
}

.back-btn {
  background: none;
  border: none;
  color: #6366f1;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  padding: 0;
}

/* Main */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

/* Empty State */
.empty-state {
  text-align: center;
  padding: 60px 24px;
  color: #6b7280;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-state p {
  font-size: 14px;
  line-height: 1.5;
}

/* Loading State */
.loading-state {
  padding: 24px 16px;
  text-align: center;
}

.original-product-mini {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: #f8f9fa;
  border-radius: 8px;
  margin-bottom: 24px;
  text-align: left;
}

.product-thumb {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
}

.product-title-small {
  font-size: 13px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.product-price-small {
  font-size: 14px;
  font-weight: 700;
  margin-top: 2px;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #e5e7eb;
  border-top-color: #6366f1;
  border-radius: 50%;
  margin: 0 auto 12px;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-text {
  font-size: 14px;
  color: #6b7280;
}

/* Results View */
.results-view {
  padding: 16px;
}

.original-product {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #f8f9fa;
  border-radius: 8px;
  margin-bottom: 16px;
}

.original-info {
  flex: 1;
  min-width: 0;
}

.product-title {
  font-size: 14px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.product-price {
  font-size: 16px;
  font-weight: 700;
  margin-top: 4px;
}

.product-meta {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
}

.cache-badge {
  display: inline-block;
  background: #dcfce7;
  color: #16a34a;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  margin-left: 6px;
}

/* Price Bar */
.price-bar-container {
  margin-bottom: 16px;
}

.price-label {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
}

.price-bar {
  height: 6px;
  background: linear-gradient(to right, #22c55e, #eab308, #ef4444);
  border-radius: 3px;
  position: relative;
}

.price-marker {
  position: absolute;
  top: -4px;
  width: 14px;
  height: 14px;
  background: #1f2937;
  border: 2px solid white;
  border-radius: 50%;
  transform: translateX(-50%);
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}

.price-range {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #6b7280;
  margin-top: 4px;
}

/* Results List */
.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.results-header h2 {
  font-size: 14px;
  font-weight: 600;
}

.search-time {
  font-size: 12px;
  color: #6b7280;
}

.no-results {
  text-align: center;
  color: #6b7280;
  font-size: 14px;
  padding: 24px 0;
}

.partial-notice {
  font-size: 12px;
  color: #d97706;
  text-align: center;
  margin-top: 12px;
}

.results-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Product Card */
.product-card {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #f8f9fa;
  border-radius: 8px;
  text-decoration: none;
  color: inherit;
  transition: box-shadow 0.15s ease;
}

.product-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.product-card:active {
  transform: scale(0.99);
}

.card-thumb {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}

.card-thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e5e7eb;
  font-size: 20px;
}

.card-info {
  flex: 1;
  min-width: 0;
}

.card-title {
  font-size: 13px;
  font-weight: 500;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-price-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.card-price {
  font-size: 15px;
  font-weight: 700;
}

.savings-badge {
  font-size: 11px;
  font-weight: 600;
  color: #16a34a;
  background: #dcfce7;
  padding: 1px 6px;
  border-radius: 4px;
}

.card-meta-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.marketplace-label {
  font-size: 12px;
  color: #6b7280;
}

.confidence-label {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 3px;
}

.confidence-medium {
  color: #d97706;
  background: #fef3c7;
}

.confidence-low {
  color: #6b7280;
  background: #f3f4f6;
}

.card-notes {
  font-size: 11px;
  color: #6b7280;
  margin-top: 4px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Chat Button */
.chat-btn {
  width: 100%;
  padding: 12px;
  margin-top: 16px;
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.chat-btn:hover {
  background: #4f46e5;
}

/* Chat View */
.chat-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: calc(100vh - 49px); /* minus header */
}

.chat-thread {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.chat-greeting {
  text-align: center;
  color: #6b7280;
  font-size: 14px;
  padding: 24px 0;
}

.chat-bubble {
  max-width: 85%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.4;
  margin-bottom: 8px;
  word-wrap: break-word;
}

.chat-user {
  background: #6366f1;
  color: white;
  margin-left: auto;
  border-bottom-right-radius: 4px;
}

.chat-assistant {
  background: #f3f4f6;
  color: #1f2937;
  margin-right: auto;
  border-bottom-left-radius: 4px;
}

.typing-indicator {
  display: inline-block;
  animation: blink 1.2s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

.chat-input-area {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #e5e7eb;
  background: white;
}

.chat-input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
}

.chat-input:focus {
  border-color: #6366f1;
}

.send-btn {
  padding: 10px 16px;
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Error State */
.error-state {
  text-align: center;
  padding: 40px 24px;
  color: #6b7280;
}

.error-detail {
  font-size: 12px;
  color: #ef4444;
  margin-top: 8px;
}

.retry-btn {
  margin-top: 16px;
  padding: 10px 24px;
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
```

**Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/App.tsx packages/extension/src/sidepanel/App.css
git commit -m "feat: implement side panel UI with results, loading states, and chat views"
```

---

### Task 12: Implement WebSocket Voice Proxy — Backend

**Files:**
- Rewrite: `packages/backend/src/ws/live.ts`

**Step 1: Implement the Gemini Live API proxy**

Replace the entire contents of `packages/backend/src/ws/live.ts` with:

```typescript
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";
import type { WSContext } from "hono/ws";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

type GeminiSession = Awaited<ReturnType<typeof ai.live.connect>>;

export function liveWebSocket(_c: unknown) {
  let geminiSession: GeminiSession | null = null;

  return {
    async onOpen(_evt: Event, ws: WSContext) {
      console.log("[ws] Client connected, opening Gemini Live session");

      try {
        geminiSession = await ai.live.connect({
          model: "gemini-live-2.5-flash-preview",
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction:
              "You are a helpful shopping assistant. Help users compare products, find deals, and make purchasing decisions. Be concise, friendly, and specific when referencing products and prices.",
          },
          callbacks: {
            onopen: () => {
              console.log("[gemini] Live session opened");
            },

            onmessage: (message: LiveServerMessage) => {
              // Audio output from Gemini
              const parts = message.serverContent?.modelTurn?.parts;
              if (parts) {
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    const audioMsg: WsServerMessage = {
                      type: "audio",
                      encoding: "pcm_s16le",
                      sampleRateHz: 24000,
                      data: part.inlineData.data,
                    };
                    ws.send(JSON.stringify(audioMsg));
                  }
                  if (part.text) {
                    const textMsg: WsServerMessage = {
                      type: "transcript",
                      content: part.text,
                    };
                    ws.send(JSON.stringify(textMsg));
                  }
                }
              }

              // Output transcription (text of what Gemini said)
              if (message.serverContent?.outputTranscription?.text) {
                const transcriptMsg: WsServerMessage = {
                  type: "transcript",
                  content: message.serverContent.outputTranscription.text,
                };
                ws.send(JSON.stringify(transcriptMsg));
              }

              // Turn complete
              if (message.serverContent?.turnComplete) {
                const completeMsg: WsServerMessage = { type: "turn_complete" };
                ws.send(JSON.stringify(completeMsg));
              }
            },

            onerror: (e: ErrorEvent) => {
              console.error("[gemini] Live session error:", e.message);
            },

            onclose: (_e: CloseEvent) => {
              console.log("[gemini] Live session closed");
              geminiSession = null;
            },
          },
        });
      } catch (err) {
        console.error("[gemini] Failed to connect Live API:", err);
        ws.close(1011, "Failed to connect to Gemini Live API");
      }
    },

    onMessage(evt: MessageEvent, _ws: WSContext) {
      if (!geminiSession) {
        console.warn("[ws] No active Gemini session, dropping message");
        return;
      }

      const message = JSON.parse(String(evt.data)) as WsClientMessage;

      switch (message.type) {
        case "audio":
          // Forward audio: browser → Gemini (16kHz PCM)
          geminiSession.sendRealtimeInput({
            audio: {
              data: message.data,
              mimeType: "audio/pcm;rate=16000",
            },
          });
          break;

        case "text":
          // Send text as client content
          geminiSession.sendClientContent({
            turns: message.content,
            turnComplete: true,
          });
          break;

        case "config":
          // Inject product context as text instruction
          console.log("[ws] Config update received");
          geminiSession.sendClientContent({
            turns: `Product context update: ${JSON.stringify(message.context)}`,
            turnComplete: true,
          });
          break;
      }
    },

    onClose() {
      console.log("[ws] Client disconnected");
      if (geminiSession) {
        geminiSession.close();
        geminiSession = null;
      }
    },
  };
}
```

**Step 2: Commit**

```bash
git add packages/backend/src/ws/live.ts
git commit -m "feat: implement Gemini Live API WebSocket proxy for voice"
```

---

### Task 13: Add Voice UI to Side Panel

**Files:**
- Modify: `packages/extension/src/sidepanel/App.tsx`

**Step 1: Add voice recording and playback to the chat view**

Add a new `useVoice` hook and mic button to the chat view. Insert these additions into `App.tsx`:

Add this hook function before the `export default function App()`:

```typescript
function useVoice(onTranscript: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackQueue = useRef<Float32Array[]>([]);
  const isPlaying = useRef(false);

  const startRecording = async () => {
    try {
      // Get backend URL
      const response = await chrome.runtime.sendMessage({ type: "GET_BACKEND_URL" });
      const wsUrl = (response as { url: string }).url.replace("http", "ws") + "/live";

      // Connect WebSocket
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data) as WsServerMessage;
        if (msg.type === "audio") {
          playAudioChunk(msg.data);
        } else if (msg.type === "transcript") {
          onTranscript(msg.content);
        }
      };

      ws.onopen = () => {
        console.log("[voice] WebSocket connected");
      };

      ws.onerror = (e) => {
        console.error("[voice] WebSocket error:", e);
        stopRecording();
      };

      ws.onclose = () => {
        console.log("[voice] WebSocket closed");
      };

      // Get microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // Set up AudioContext and ScriptProcessor for PCM capture
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        // Convert float32 to PCM16
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(inputData[i] * 32767)));
        }
        // Base64 encode
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        const audioMsg: WsClientMessage = {
          type: "audio",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
          data: base64,
        };
        wsRef.current.send(JSON.stringify(audioMsg));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      setRecording(true);
    } catch (err) {
      console.error("[voice] Failed to start recording:", err);
    }
  };

  const stopRecording = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    wsRef.current?.close();
    wsRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
    setRecording(false);
  };

  const playAudioChunk = (base64Data: string) => {
    // Decode base64 to PCM16 bytes
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer);

    // Convert to float32
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }

    playbackQueue.current.push(float32);
    if (!isPlaying.current) {
      drainPlaybackQueue();
    }
  };

  const drainPlaybackQueue = async () => {
    if (!playbackCtxRef.current) {
      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
    }
    isPlaying.current = true;
    const ctx = playbackCtxRef.current;

    while (playbackQueue.current.length > 0) {
      const chunk = playbackQueue.current.shift()!;
      const buffer = ctx.createBuffer(1, chunk.length, 24000);
      buffer.getChannelData(0).set(chunk);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
      await new Promise((resolve) => {
        source.onended = resolve;
      });
    }

    isPlaying.current = false;
  };

  const toggle = () => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return { recording, toggle };
}
```

Then modify the `ChatView` component to accept and use voice:

Add the `useVoice` hook inside the `ChatView` function, and add a mic button to the input area. The mic button goes left of the text input:

```tsx
// Inside ChatView, add before the return:
const voice = useVoice((transcript) => {
  // When we get a transcript from Gemini, add it as an assistant message
  const msg: ChatMessage = {
    id: `msg-voice-${Date.now()}`,
    role: "assistant",
    content: transcript,
    inputMode: "voice",
    timestamp: Date.now(),
    context: null,
  };
  // We need to lift this up — but for simplicity, we dispatch a custom event
  // Actually, let's pass onVoiceTranscript as a prop
});
```

Since wiring the voice hook cleanly into the existing component structure requires changes to the ChatView props and the parent state, here is the updated approach:

Add a `voiceTranscript` callback prop to `ChatView` and a mic button. The full ChatView replacement:

```tsx
function ChatView({
  messages,
  input,
  loading,
  onInputChange,
  onSend,
  onVoiceMessage,
  chatEndRef,
}: {
  messages: ChatMessage[];
  input: string;
  loading: boolean;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onVoiceMessage: (content: string) => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  const voice = useVoice((transcript) => {
    onVoiceMessage(transcript);
  });

  return (
    <div className="chat-view">
      <div className="chat-thread">
        {messages.length === 0 && (
          <div className="chat-greeting">
            <p>Hi! Ask me anything about these products.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble chat-${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {loading && (
          <div className="chat-bubble chat-assistant">
            <span className="typing-indicator">...</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      <div className="chat-input-area">
        <button
          className={`mic-btn ${voice.recording ? "mic-recording" : ""}`}
          onClick={voice.toggle}
          title={voice.recording ? "Stop recording" : "Start voice"}
        >
          🎤
        </button>
        {voice.recording ? (
          <div className="listening-text">Listening...</div>
        ) : (
          <>
            <input
              type="text"
              className="chat-input"
              placeholder="Ask about these products..."
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSend()}
              disabled={loading}
            />
            <button
              className="send-btn"
              onClick={onSend}
              disabled={loading || !input.trim()}
            >
              Send
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

Update the `ChatView` usage in `App` to pass `onVoiceMessage`:

```tsx
<ChatView
  messages={state.chatMessages}
  input={state.chatInput}
  loading={state.chatLoading}
  onInputChange={(v) => setState((prev) => ({ ...prev, chatInput: v }))}
  onSend={handleSendChat}
  onVoiceMessage={(content) => {
    const msg: ChatMessage = {
      id: `msg-voice-${Date.now()}`,
      role: "assistant",
      content,
      inputMode: "voice",
      timestamp: Date.now(),
      context: null,
    };
    setState((prev) => ({
      ...prev,
      chatMessages: [...prev.chatMessages, msg],
    }));
  }}
  chatEndRef={chatEndRef}
/>
```

Add the `WsServerMessage` and `WsClientMessage` imports at the top of `App.tsx`:

```typescript
import type {
  DetectedProduct,
  SearchResponse,
  RankedResult,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  WsServerMessage,
  WsClientMessage,
} from "@shopping-assistant/shared";
```

**Step 2: Add mic button CSS**

Append to `App.css`:

```css
/* Mic Button */
.mic-btn {
  width: 40px;
  height: 40px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: white;
  cursor: pointer;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.mic-btn:hover {
  background: #f3f4f6;
}

.mic-recording {
  background: #fef2f2;
  border-color: #ef4444;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.listening-text {
  flex: 1;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 14px;
  color: #ef4444;
  font-style: italic;
}
```

**Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/App.tsx packages/extension/src/sidepanel/App.css
git commit -m "feat: add voice recording and playback to chat view"
```

---

### Task 14: Build and Verify Full System

**Step 1: Build shared package**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared`
Expected: Clean build.

**Step 2: Typecheck all packages**

Run: `pnpm typecheck`
Expected: No type errors. Fix any that arise.

**Step 3: Build extension**

Run: `pnpm build:ext`
Expected: `packages/extension/dist/` contains the compiled extension.

**Step 4: Build backend**

Run: `pnpm build:backend`
Expected: `packages/backend/dist/index.js` exists.

**Step 5: Start backend and curl-test**

Run: `pnpm dev:backend &`

Health check:
```bash
curl http://localhost:8080/health
```
Expected: `{"status":"ok"}`

Search endpoint (requires valid API keys):
```bash
curl -X POST http://localhost:8080/search \
  -H "Content-Type: application/json" \
  -d '{"imageUrl":"https://m.media-amazon.com/images/I/61SUj2aKoEL._AC_SL1500_.jpg","imageBase64":null,"title":"Sony WH-1000XM5","price":348,"currency":"USD","sourceUrl":"https://amazon.com/dp/B0BX2L8PBT"}'
```
Expected: Full SearchResponse with ranked results.

Chat endpoint:
```bash
curl -X POST http://localhost:8080/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Which headphones are best?","context":{"product":null,"results":null},"history":[]}'
```
Expected: `{"reply":"..."}` with Gemini response.

**Step 6: Kill dev server**

```bash
kill %1 2>/dev/null
```

**Step 7: Fix any typecheck or build errors and commit**

```bash
git add -A
git commit -m "chore: fix build and typecheck issues from full verification"
```

---

### Task 15: Manual Integration Test

This task is manual — load the extension and test the full flow.

**Step 1: Load the extension in Chrome**

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `packages/extension/dist/`
4. Extension should appear with "Shopping Source Discovery" name

**Step 2: Start the backend**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm dev:backend`

**Step 3: Test product detection**

1. Navigate to an Amazon product page
2. Look for the search overlay icon on the product image
3. Should appear within 200ms of page load

**Step 4: Test search flow**

1. Click the overlay icon
2. Side panel should open with loading phases
3. After ~5-10 seconds, results should appear with product cards

**Step 5: Test chat**

1. Click "Chat Now"
2. Type a question about the products
3. Should get a contextual response from Gemini

**Step 6: Test voice (requires HTTPS or localhost)**

1. In chat view, click the mic button
2. Speak a question
3. Should hear audio response and see transcript

**Step 7: Report any issues**

Note any issues encountered for follow-up fixes.
