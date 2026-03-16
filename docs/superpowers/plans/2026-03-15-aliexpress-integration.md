# AliExpress Native API Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate AliExpress Dropship API as a native search source alongside Brave, providing structured pricing, image search, and direct product data from AliExpress's index.

**Architecture:** New `aliexpress.ts` service handles OAuth token management (HMAC-SHA256 signing, auto-refresh) and exposes text search + image search. Results normalize to the existing `SearchResult` type. The search pipeline adds AliExpress as a 4th parallel search source in Phase 2, replacing the `site:aliexpress.com` Brave query. The `SearchResult.source` union type expands to include `"aliexpress"`.

**Tech Stack:** Node.js crypto (HMAC-SHA256), fetch API, `@shopping-assistant/shared` types. Credentials from env vars (`ALIEXPRESS_API_KEY`, `ALIEXPRESS_APP_KEY`) — already configured in `.env`.

**Reference:** Full API docs at `docs/aliexpress-api.md`. Key endpoints: `aliexpress.ds.text.search`, `aliexpress.ds.image.search`, `aliexpress.ds.product.get`.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/backend/src/services/aliexpress.ts` | AliExpress API client: signing, text search, image search, response normalization |
| Create | `packages/backend/src/services/__tests__/aliexpress.test.ts` | Unit tests for signing, response normalization |
| Modify | `packages/shared/src/types.ts` | Add `"aliexpress"` to `SearchResult.source` union |
| Modify | `packages/backend/src/routes/search.ts` | Add AliExpress as Phase 2 parallel search source |
| Modify | `packages/backend/src/utils/marketplace-queries.ts` | Remove `aliexpress.com` from `TARGET_MARKETPLACES` (native API replaces it) |

---

## Chunk 1: AliExpress API Client

### Task 1: Update shared types

**Files:**
- Modify: `packages/shared/src/types.ts:85`

- [ ] **Step 1: Add "aliexpress" to SearchResult.source**

In `packages/shared/src/types.ts`, change line 85:

```typescript
  source: "gemini_grounding" | "brave" | "aliexpress";
```

- [ ] **Step 2: Build shared package**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/shared/src/types.ts
git commit -m "feat: add aliexpress to SearchResult source union type"
```

---

### Task 2: Implement AliExpress API client with signing

**Files:**
- Create: `packages/backend/src/services/aliexpress.ts`
- Create: `packages/backend/src/services/__tests__/aliexpress.test.ts`

- [ ] **Step 1: Write failing tests for request signing and response normalization**

```typescript
// packages/backend/src/services/__tests__/aliexpress.test.ts
import { describe, it, expect } from "vitest";
import { buildSignedParams, normalizeTextSearchResults, normalizeImageSearchResults } from "../aliexpress.js";

describe("buildSignedParams", () => {
  it("produces deterministic sign for given inputs", () => {
    const params = buildSignedParams(
      "aliexpress.ds.text.search",
      { keyword: "test", countryCode: "US", currency: "USD", local: "en_US" },
      {
        appKey: "test_app_key",
        appSecret: "test_secret",
        accessToken: "test_token",
        // Override timestamp for deterministic test
        _timestamp: "1700000000000",
      },
    );

    expect(params.app_key).toBe("test_app_key");
    expect(params.method).toBe("aliexpress.ds.text.search");
    expect(params.session).toBe("test_token");
    expect(params.sign).toBeDefined();
    expect(typeof params.sign).toBe("string");
    expect(params.sign.length).toBe(64); // SHA-256 hex = 64 chars
    expect(params.sign).toBe(params.sign.toUpperCase()); // must be uppercase
  });

  it("sorts params alphabetically for signing", () => {
    // Two calls with same params in different order should produce same sign
    const params1 = buildSignedParams(
      "aliexpress.ds.text.search",
      { keyword: "a", countryCode: "US", currency: "USD", local: "en_US" },
      { appKey: "k", appSecret: "s", accessToken: "t", _timestamp: "123" },
    );
    const params2 = buildSignedParams(
      "aliexpress.ds.text.search",
      { local: "en_US", currency: "USD", countryCode: "US", keyword: "a" },
      { appKey: "k", appSecret: "s", accessToken: "t", _timestamp: "123" },
    );
    expect(params1.sign).toBe(params2.sign);
  });
});

describe("normalizeTextSearchResults", () => {
  it("normalizes text search response to SearchResult[]", () => {
    const apiResponse = {
      aliexpress_ds_text_search_response: {
        data: {
          products: {
            selection_search_product: [
              {
                itemId: "1005008148860952",
                title: "TWS Wireless Bluetooth Headset",
                itemMainPic: "//ae04.alicdn.com/kf/test.jpg",
                targetSalePrice: "1.83",
                targetOriginalPrice: "4.35",
                targetOriginalPriceCurrency: "USD",
                discount: "58%",
                score: "4.5",
                orders: "10,000+",
                itemUrl: "//www.aliexpress.com/item/1005008148860952.html",
              },
            ],
          },
        },
      },
    };

    const results = normalizeTextSearchResults(apiResponse);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("aliexpress");
    expect(results[0].title).toBe("TWS Wireless Bluetooth Headset");
    expect(results[0].price).toBe(1.83);
    expect(results[0].currency).toBe("USD");
    expect(results[0].imageUrl).toBe("https://ae04.alicdn.com/kf/test.jpg");
    expect(results[0].productUrl).toBe("https://www.aliexpress.com/item/1005008148860952.html");
    expect(results[0].marketplace).toBe("AliExpress");
  });

  it("returns empty array for empty response", () => {
    const results = normalizeTextSearchResults({});
    expect(results).toEqual([]);
  });

  it("handles missing optional fields", () => {
    const apiResponse = {
      aliexpress_ds_text_search_response: {
        data: {
          products: {
            selection_search_product: [
              {
                itemId: "123",
                title: "Product",
                itemMainPic: "//img.com/x.jpg",
                targetSalePrice: "5.00",
                targetOriginalPriceCurrency: "USD",
                itemUrl: "//www.aliexpress.com/item/123.html",
              },
            ],
          },
        },
      },
    };

    const results = normalizeTextSearchResults(apiResponse);
    expect(results).toHaveLength(1);
    expect(results[0].price).toBe(5);
  });
});

describe("normalizeImageSearchResults", () => {
  it("normalizes image search response to SearchResult[]", () => {
    const apiResponse = {
      aliexpress_ds_image_search_response: {
        data: {
          products: {
            traffic_image_product_d_t_o: [
              {
                product_id: "3256807996818647",
                product_title: "Butterfly Snake Necklace",
                product_main_image_url: "https://ae-pic-a1.aliexpress-media.com/kf/test.jpg",
                target_sale_price: "0.51",
                target_original_price: "1.03",
                target_sale_price_currency: "USD",
                discount: "50%",
                product_detail_url: "https://www.aliexpress.com/item/3256807996818647.html",
                lastest_volume: "11",
              },
            ],
          },
        },
      },
    };

    const results = normalizeImageSearchResults(apiResponse);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("aliexpress");
    expect(results[0].title).toBe("Butterfly Snake Necklace");
    expect(results[0].price).toBe(0.51);
    expect(results[0].currency).toBe("USD");
    expect(results[0].productUrl).toBe("https://www.aliexpress.com/item/3256807996818647.html");
    expect(results[0].marketplace).toBe("AliExpress");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/aliexpress.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement aliexpress.ts**

```typescript
// packages/backend/src/services/aliexpress.ts
import { createHmac } from "node:crypto";
import type { SearchResult } from "@shopping-assistant/shared";
import type { FetchedImage } from "./gemini.js";
import type { ProviderSearchOutcome } from "./provider-outcome.js";
import { resolveProviderStatus } from "./provider-outcome.js";
import { isLikelyTimeoutError } from "../utils/errors.js";

const BASE_URL = "https://api-sg.aliexpress.com/sync";
const APP_KEY = process.env.ALIEXPRESS_APP_KEY ?? "";
const APP_SECRET = process.env.ALIEXPRESS_API_KEY ?? "";
const PER_QUERY_TIMEOUT_MS = 8_000;

// Token state — in production, persist to a store with TTL
let accessToken = "";
let tokenExpiry = 0;

export function setAccessToken(token: string, expiresInSeconds: number): void {
  accessToken = token;
  tokenExpiry = Date.now() + expiresInSeconds * 1000;
}

export function hasValidToken(): boolean {
  return accessToken !== "" && Date.now() < tokenExpiry;
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
  const boundary = "----FormBoundary" + Date.now();
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
  if (!hasValidToken()) {
    console.warn("[aliexpress] No valid token — skipping AliExpress search");
    return {
      results: [],
      status: "ok",
      totalQueries: 0,
      successfulQueries: 0,
      failedQueries: 0,
      timedOutQueries: 0,
    };
  }

  const promises: Promise<SearchResult[]>[] = [];

  // Text searches
  for (const query of queries) {
    promises.push(textSearch(query));
  }

  // Image search (if image available)
  if (image) {
    promises.push(imageSearch(image));
  }

  const outcomes = await Promise.allSettled(promises);

  const results: SearchResult[] = [];
  let successfulQueries = 0;
  let failedQueries = 0;
  let timedOutQueries = 0;

  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") {
      results.push(...outcome.value);
      successfulQueries++;
    } else {
      console.error("[aliexpress] Query failed:", outcome.reason);
      failedQueries++;
      if (isLikelyTimeoutError(outcome.reason)) {
        timedOutQueries++;
      }
    }
  }

  return {
    results,
    status: resolveProviderStatus(successfulQueries, failedQueries, timedOutQueries),
    totalQueries: promises.length,
    successfulQueries,
    failedQueries,
    timedOutQueries,
  };
}

// ── Response Normalization ───────────────────────────────────────────────────

let aliIdCounter = 0;

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
      id: `ali_${aliIdCounter++}`,
      source: "aliexpress" as const,
      title: String(item.title ?? ""),
      price: price !== null && !isNaN(price) ? price : null,
      currency: typeof item.targetOriginalPriceCurrency === "string"
        ? item.targetOriginalPriceCurrency
        : "USD",
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
      id: `ali_img_${aliIdCounter++}`,
      source: "aliexpress" as const,
      title: String(item.product_title ?? ""),
      price: price !== null && !isNaN(price) ? price : null,
      currency: typeof item.target_sale_price_currency === "string"
        ? item.target_sale_price_currency
        : "USD",
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/aliexpress.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/services/aliexpress.ts packages/backend/src/services/__tests__/aliexpress.test.ts
git commit -m "feat: add AliExpress Dropship API client with signing and normalization"
```

---

## Chunk 2: Pipeline Integration

### Task 3: Remove aliexpress.com from Brave marketplace queries

**Files:**
- Modify: `packages/backend/src/utils/marketplace-queries.ts`
- Modify: `packages/backend/src/utils/__tests__/marketplace-queries.test.ts`

- [ ] **Step 1: Update TARGET_MARKETPLACES**

In `packages/backend/src/utils/marketplace-queries.ts`, remove `aliexpress.com`:

```typescript
const TARGET_MARKETPLACES = [
  "dhgate.com",
  "temu.com",
  "1688.com",
];
```

- [ ] **Step 2: Update tests if any reference aliexpress query count**

Check `packages/backend/src/utils/__tests__/marketplace-queries.test.ts` and update expected counts (4 → 3 marketplace queries).

- [ ] **Step 3: Run tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test -- --run src/utils/__tests__/marketplace-queries.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/utils/marketplace-queries.ts packages/backend/src/utils/__tests__/marketplace-queries.test.ts
git commit -m "refactor: remove aliexpress.com from Brave marketplace queries (native API replaces it)"
```

---

### Task 4: Add AliExpress to search pipeline

**Files:**
- Modify: `packages/backend/src/routes/search.ts`

- [ ] **Step 1: Import AliExpress service**

Add import at top of `packages/backend/src/routes/search.ts`:

```typescript
import { searchAliExpress } from "../services/aliexpress.js";
import type { FetchedImage } from "../services/gemini.js";
```

Note: `FetchedImage` is already imported via the existing `import type { FetchedImage } from "../services/gemini.js"` line, so only add the `searchAliExpress` import.

- [ ] **Step 2: Add AliExpress to Phase 2 parallel search**

In the Phase 2 section of `search.ts` (around lines 121-141), add AliExpress as a third parallel search alongside `aiBrave` and `marketplaceBrave`:

After the `marketplaceQueries` variable, add:

```typescript
  // Prepare AliExpress search — use AI queries + image for visual search
  const aliExpressImage: FetchedImage | null = body.imageBase64
    ? { data: body.imageBase64, mimeType: "image/png" }
    : null;
  const aliExpressQueries = [identification.description || body.title || ""].filter(Boolean);
```

Modify the `Promise.allSettled` to include AliExpress:

```typescript
  const [aiBraveResult, marketplaceBraveResult, aliExpressResult] =
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
    ]);
```

- [ ] **Step 3: Handle AliExpress outcome**

After the existing `marketplaceBraveOutcome` handling, add:

```typescript
  const aliExpressOutcome: ProviderSearchOutcome =
    aliExpressResult.status === "fulfilled"
      ? aliExpressResult.value
      : rejectedProviderOutcome(aliExpressQueries.length, aliExpressResult.reason);

  if (aliExpressResult.status === "rejected") {
    console.error(`[search:${requestId}] AliExpress failed:`, aliExpressResult.reason);
  }
```

- [ ] **Step 4: Include AliExpress results in merge**

Modify the `allResults` line to include AliExpress:

```typescript
  const allResults = [...braveOutcome.results, ...aliExpressOutcome.results];
```

- [ ] **Step 5: Add AliExpress to search diagnostics**

In the response `searchMeta`, add an aliexpress diagnostics entry. Update the `SearchResponse` type in `packages/shared/src/types.ts` to add an optional `aliexpress` key to `sourceDiagnostics`, or simply log it. For now, log it:

```typescript
  if (aliExpressOutcome.results.length > 0) {
    console.log(`[search:${requestId}] AliExpress contributed ${aliExpressOutcome.results.length} results`);
  }
```

- [ ] **Step 6: Run typecheck and all tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm typecheck && pnpm --filter @shopping-assistant/backend test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/routes/search.ts
git commit -m "feat: integrate AliExpress native API as parallel search source in pipeline"
```
