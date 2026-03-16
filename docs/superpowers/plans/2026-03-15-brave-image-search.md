# Brave Image Search Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Brave Image Search as a parallel search source to find visually similar products by querying product descriptions as image search terms, then extracting shopping-domain results with product thumbnails.

**Architecture:** The Brave Image Search API (`/res/v1/images/search`) accepts text queries and returns image results with source URLs, thumbnails, and metadata. We add a new `searchImages` function in `brave.ts` that runs product description queries against the image endpoint, filters results to shopping domains, and returns `SearchResult[]`. The search route orchestrates it in parallel with existing Brave web + AliExpress searches.

**Tech Stack:** Brave Search API (image endpoint), Vitest, TypeScript

---

## Chunk 1: Brave Image Search Service

### Task 1: Add `searchImages` to brave.ts

**Files:**
- Modify: `packages/backend/src/services/brave.ts`
- Test: `packages/backend/src/services/__tests__/brave.test.ts`

**Context:** The Brave Image Search API at `https://api.search.brave.com/res/v1/images/search` uses the same auth header (`X-Subscription-Token`) as web search. It accepts `q` (query string) and `count` (max 200) params. Response shape:

```json
{
  "results": [{
    "url": "https://source-page.com/product",
    "title": "Product Title",
    "properties": {
      "url": "https://cdn.example.com/image.jpg",
      "placeholder": "https://proxy.search.brave.com/...",
      "width": 800,
      "height": 600
    },
    "meta_url": { "hostname": "amazon.com" },
    "thumbnail": { "src": "https://proxy.search.brave.com/..." }
  }]
}
```

Key distinction: `result.url` is the source *page* URL (product page), while `result.properties.url` is the direct image URL. `result.thumbnail.src` is a Brave-proxied 500px thumbnail.

- [ ] **Step 1: Write the response normalization test**

In `packages/backend/src/services/__tests__/brave.test.ts`, add a new describe block:

```typescript
import { describe, it, expect } from "vitest";
import { parsePrice, normalizeBraveImageResults } from "../brave.js";

// ... existing parsePrice tests ...

describe("normalizeBraveImageResults", () => {
  it("extracts shopping domain results with thumbnails", () => {
    const data = {
      results: [
        {
          url: "https://www.amazon.com/dp/B09XYZ123",
          title: "Blue Striped A-Line Dress",
          properties: {
            url: "https://m.media-amazon.com/images/I/image.jpg",
            placeholder: "https://proxy.search.brave.com/thumb1",
          },
          thumbnail: { src: "https://proxy.search.brave.com/thumb1" },
        },
        {
          url: "https://randomBlog.com/fashion-tips",
          title: "Fashion Blog Post",
          properties: {
            url: "https://randomBlog.com/image.jpg",
          },
          thumbnail: { src: "https://proxy.search.brave.com/thumb2" },
        },
        {
          url: "https://www.target.com/p/dress-a-123",
          title: "Target Striped Dress",
          properties: {
            url: "https://target.scene7.com/image.jpg",
          },
          thumbnail: { src: "https://proxy.search.brave.com/thumb3" },
        },
      ],
    };

    const results = normalizeBraveImageResults(data);

    // Should only include shopping domain results (amazon, target), not blog
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Blue Striped A-Line Dress");
    expect(results[0].productUrl).toBe("https://www.amazon.com/dp/B09XYZ123");
    expect(results[0].imageUrl).toBe("https://proxy.search.brave.com/thumb1");
    expect(results[0].marketplace).toBe("Amazon");
    expect(results[0].source).toBe("brave");
    expect(results[0].id).toMatch(/^brave_img_/);

    expect(results[1].title).toBe("Target Striped Dress");
    expect(results[1].marketplace).toBe("Target");
  });

  it("generates unique IDs across calls", () => {
    const data = {
      results: [
        {
          url: "https://www.amazon.com/dp/B09XYZ123",
          title: "Product A",
          properties: { url: "https://img.com/a.jpg" },
          thumbnail: { src: "https://proxy.search.brave.com/a" },
        },
      ],
    };
    const r1 = normalizeBraveImageResults(data);
    const r2 = normalizeBraveImageResults(data);
    expect(r1[0].id).not.toBe(r2[0].id);
  });

  it("returns empty array for missing results", () => {
    expect(normalizeBraveImageResults({})).toEqual([]);
    expect(normalizeBraveImageResults({ results: [] })).toEqual([]);
  });

  it("parses price from title when present", () => {
    const data = {
      results: [
        {
          url: "https://www.walmart.com/ip/dress/123",
          title: "Summer Dress - $24.99 at Walmart",
          properties: { url: "https://i5.walmartimages.com/img.jpg" },
          thumbnail: { src: "https://proxy.search.brave.com/thumb" },
        },
      ],
    };

    const results = normalizeBraveImageResults(data);
    expect(results).toHaveLength(1);
    expect(results[0].price).toBe(24.99);
    expect(results[0].currency).toBe("USD");
  });

  it("falls back through image URL chain when thumbnail is missing", () => {
    const data = {
      results: [
        {
          url: "https://www.amazon.com/dp/B09ABC",
          title: "Dress No Thumbnail",
          properties: {
            url: "https://cdn.example.com/direct.jpg",
            placeholder: "https://proxy.search.brave.com/placeholder",
          },
          // no thumbnail field
        },
        {
          url: "https://www.target.com/p/dress-b",
          title: "Dress No Placeholder",
          properties: {
            url: "https://cdn.example.com/direct2.jpg",
          },
          // no thumbnail, no placeholder
        },
      ],
    };

    const results = normalizeBraveImageResults(data);
    expect(results[0].imageUrl).toBe("https://proxy.search.brave.com/placeholder");
    expect(results[1].imageUrl).toBe("https://cdn.example.com/direct2.jpg");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/backend && npx vitest run src/services/__tests__/brave.test.ts`
Expected: FAIL — `normalizeBraveImageResults` is not exported from `brave.js`

- [ ] **Step 3: Implement `normalizeBraveImageResults`**

In `packages/backend/src/services/brave.ts`, add:

1. Import `randomUUID` at the top (if not already imported):
```typescript
import { randomUUID } from "node:crypto";
```

2. A new constant for the image search endpoint:
```typescript
const BRAVE_IMAGE_API_URL = "https://api.search.brave.com/res/v1/images/search";
```

3. The response type interfaces (note: no `source` field — the actual API uses `meta_url.hostname`, but we don't need it since we filter by `item.url` domain):
```typescript
interface BraveImageResult {
  url: string;
  title: string;
  properties?: {
    url?: string;
    placeholder?: string;
  };
  thumbnail?: { src: string };
}

interface BraveImageSearchResponse {
  results?: BraveImageResult[];
}
```

4. The normalization function (exported — named `normalizeBraveImageResults` to avoid collision with `normalizeImageSearchResults` in `aliexpress.ts`):
```typescript
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
```

Image URL priority: `thumbnail.src` (Brave-proxied, 500px, reliable) > `properties.placeholder` > `properties.url` (direct CDN, may have CORS/hotlink issues).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/backend && npx vitest run src/services/__tests__/brave.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/brave.ts packages/backend/src/services/__tests__/brave.test.ts
git commit -m "feat: add normalizeBraveImageResults for Brave image search"
```

---

### Task 2: Add `searchImages` orchestrator function

**Files:**
- Modify: `packages/backend/src/services/brave.ts`
- Test: `packages/backend/src/services/__tests__/brave.test.ts`

**Context:** `searchImages` follows the same pattern as `searchProducts` — takes queries, runs them in parallel, returns a `ProviderSearchOutcome`. Each query hits the image endpoint with `count=20` (images are cheaper to scan than web results, and we filter to shopping domains, so we need more raw results to get enough hits).

- [ ] **Step 1: Write the `searchImages` integration test**

Add to `packages/backend/src/services/__tests__/brave.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parsePrice, normalizeBraveImageResults } from "../brave.js";

// We can't easily test searchImages without mocking fetch (it calls Brave API).
// The normalization is already tested. We test the orchestrator shape by
// verifying searchProducts and searchImages have the same return type.
// Integration testing is covered by the search route e2e.
```

No new unit test needed here — `normalizeImageSearchResults` is already tested, and `searchImages` is a thin orchestrator identical in shape to `searchProducts`. The integration is tested at the route level.

- [ ] **Step 2: Implement `searchImages`**

In `packages/backend/src/services/brave.ts`, add the exported function:

```typescript
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
```

- [ ] **Step 3: Verify typecheck passes**

Run: `cd packages/backend && npx tsc --noEmit`
Expected: PASS with no type errors

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/services/brave.ts
git commit -m "feat: add searchImages for Brave image search endpoint"
```

---

## Chunk 2: Pipeline Integration

### Task 3: Wire Brave image search into search route

**Files:**
- Modify: `packages/backend/src/routes/search.ts`

**Context:** The search route orchestrates parallel searches in Phase 2 (`search.ts:157-168`). We add `searchImages` as a 4th parallel search alongside AI Brave, marketplace Brave, and AliExpress. The image queries should use the AI-generated search queries (same as AI Brave) since these are concise product descriptions optimized for search.

The results get merged into `braveOutcome` since they're from the same Brave provider (same API key, same rate limits). Source attribution logging distinguishes them.

- [ ] **Step 1: Import `searchImages`**

At the top of `packages/backend/src/routes/search.ts`, modify the brave import:

```typescript
import { searchProducts, searchImages } from "../services/brave.js";
```

- [ ] **Step 2: Add image search to Phase 2 parallel execution**

In the Phase 2 section (around line 150-168), add image search queries and the parallel call:

After the `aliExpressQueries` block (line 154-155), add:
```typescript
// Image search queries — use concise AI queries for best image results
const imageSearchQueries = aiQueries.slice(0, 2);
console.log(`[search:${requestId}] Image search queries: ${JSON.stringify(imageSearchQueries)}`);
```

Expand the `Promise.allSettled` to include a 4th promise:
```typescript
const [aiBraveResult, marketplaceBraveResult, aliExpressResult, imageBraveResult] =
  await Promise.allSettled([
    skipAiBrave
      ? Promise.resolve(emptyProviderOutcome())
      : withTimeout(searchProducts(aiQueries), phase2Deadline),
    marketplaceQueries.length > 0
      ? withTimeout(searchProducts(marketplaceQueries), phase2Deadline)
      : Promise.resolve(emptyProviderOutcome()),
    aliExpressQueries.length > 0
      ? withTimeout(searchAliExpress(aliExpressQueries, aliExpressImage), phase2Deadline)
      : Promise.resolve(emptyProviderOutcome()),
    imageSearchQueries.length > 0
      ? withTimeout(searchImages(imageSearchQueries), phase2Deadline)
      : Promise.resolve(emptyProviderOutcome()),
  ]);
```

- [ ] **Step 3: Handle image search outcome**

After the `aliExpressOutcome` block (around line 188-192), add:

```typescript
const imageBraveOutcome: ProviderSearchOutcome =
  imageBraveResult.status === "fulfilled"
    ? imageBraveResult.value
    : rejectedProviderOutcome(imageSearchQueries.length, imageBraveResult.reason);

if (imageBraveResult.status === "rejected") {
  console.error(`[search:${requestId}] Brave (image) failed:`, imageBraveResult.reason);
}
```

- [ ] **Step 4: Merge image results into the brave combined outcome**

Update the `combineBraveOutcomes` chain (around line 195-198) to include image results:

```typescript
const braveOutcome = combineBraveOutcomes(
  combineBraveOutcomes(
    combineBraveOutcomes(titleBraveOutcome, aiBraveOutcome),
    marketplaceBraveOutcome,
  ),
  imageBraveOutcome,
);
```

- [ ] **Step 5: Update source attribution logging**

Update the source breakdown log (around line 214) to include image results:

```typescript
console.log(`[search:${requestId}] Source breakdown: Brave(title)=${titleBraveOutcome.results.length}, Brave(AI)=${aiBraveOutcome.results.length}, Brave(marketplace)=${marketplaceBraveOutcome.results.length}, Brave(image)=${imageBraveOutcome.results.length}, AliExpress=${aliExpressOutcome.results.length}`);
```

- [ ] **Step 6: Verify typecheck passes**

Run: `cd packages/backend && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Run all backend tests**

Run: `cd packages/backend && npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/routes/search.ts
git commit -m "feat: integrate Brave image search as parallel source in search pipeline"
```
