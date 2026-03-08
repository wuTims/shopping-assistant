# Anti-Bot Screenshot-Based Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace DOM-based product detection with screenshot-based detection to eliminate bot detection triggers, add price extraction fallback via Gemini Vision, and improve Chinese marketplace coverage.

**Architecture:** Extension captures visible tab screenshot via `chrome.tabs.captureVisibleTab()` (zero page injection). Backend identifies products from screenshots via Gemini Flash. Price gaps filled by server-side Playwright screenshots + Gemini Vision. Chinese marketplaces surfaced via targeted `site:` Brave queries.

**Tech Stack:** Gemini 2.5 Flash (vision), Playwright (headless Chromium), Brave Search API, Chrome Extension MV3

---

### Task 1: Add New Shared Types

**Files:**
- Modify: `packages/shared/src/types.ts`

**Step 1: Add IdentifyRequest, IdentifiedProduct, IdentifyResponse types**

Add after the `SearchRequest` interface (after line 37):

```typescript
export interface IdentifyRequest {
  screenshot: string; // base64 PNG from captureVisibleTab
  pageUrl: string;
}

export interface IdentifiedProduct {
  name: string;
  price: number | null;
  currency: string | null;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  imageRegion: string | null; // base64 cropped image of the product
}

export interface IdentifyResponse {
  products: IdentifiedProduct[];
  pageType: "product_detail" | "product_listing" | "unknown";
}
```

**Step 2: Add priceAvailable field to RankedResult**

In the `RankedResult` interface (line 77-85), add after the `rank` field:

```typescript
  priceAvailable: boolean;
```

**Step 3: Run typecheck**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm typecheck`
Expected: Type errors in `ranking.ts` where `RankedResult` is constructed without `priceAvailable` — this is expected and will be fixed in Task 8.

**Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): add identify types and priceAvailable field to RankedResult"
```

---

### Task 2: Update Constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

**Step 1: Add price fallback constants, remove overlay constants**

Remove these lines (they reference the deleted overlay system):
```typescript
export const MAX_OVERLAYS_PER_PAGE = 20;
export const MIN_IMAGE_SIZE_PX = 100;
export const OVERLAY_ICON_SIZE_PX = 28;
export const OVERLAY_ICON_HOVER_SIZE_PX = 32;
```

Add these new constants:
```typescript
export const PRICE_FALLBACK_TIMEOUT_MS = 5_000;
export const MAX_PRICE_FALLBACK_RESULTS = 5;
export const IDENTIFY_TIMEOUT_MS = 8_000;
```

**Step 2: Verify no code references removed constants**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && grep -r "MAX_OVERLAYS_PER_PAGE\|MIN_IMAGE_SIZE_PX\|OVERLAY_ICON_SIZE_PX\|OVERLAY_ICON_HOVER_SIZE_PX" packages/`
Expected: No matches (content script that used these is a stub and will be deleted).

**Step 3: Build shared and typecheck**

Run: `pnpm build:shared && pnpm typecheck`
Expected: May show errors from Task 1's `priceAvailable` — ignore for now.

**Step 4: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): add price fallback and identify constants, remove overlay constants"
```

---

### Task 3: Add Chinese Marketplaces to Marketplace List

**Files:**
- Modify: `packages/backend/src/utils/marketplace.ts`
- Test: `packages/backend/src/utils/__tests__/marketplace.test.ts`

**Step 1: Write failing tests**

Add to `packages/backend/src/utils/__tests__/marketplace.test.ts`:

```typescript
it("recognises DHgate", () => {
  expect(extractMarketplace("https://www.dhgate.com/product/foo.html")).toBe("DHgate");
});

it("recognises Temu", () => {
  expect(extractMarketplace("https://www.temu.com/some-product.html")).toBe("Temu");
});

it("recognises 1688", () => {
  expect(extractMarketplace("https://detail.1688.com/offer/12345.html")).toBe("1688");
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test`
Expected: 3 new tests FAIL (DHgate → "Dhgate", Temu → "Temu" might pass by accident via fallback, 1688 → "1688" might pass via fallback — check exact output).

**Step 3: Add marketplaces to the mapping**

In `packages/backend/src/utils/marketplace.ts`, add to the `MARKETPLACE_NAMES` object (after `"aliexpress.com": "AliExpress"` at line 11):

```typescript
  "dhgate.com": "DHgate",
  "temu.com": "Temu",
  "1688.com": "1688",
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add packages/backend/src/utils/marketplace.ts packages/backend/src/utils/__tests__/marketplace.test.ts
git commit -m "feat(backend): add DHgate, Temu, 1688 to marketplace list"
```

---

### Task 4: Add ¥ Currency Support to Price Regex

**Files:**
- Modify: `packages/backend/src/services/brave.ts`
- Test: `packages/backend/src/services/__tests__/brave.test.ts` (create)

**Step 1: Write failing tests**

Create `packages/backend/src/services/__tests__/brave.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// We need to test parsePrice which is currently not exported.
// For now, test via the module's internal behavior by testing parsePriceFromSnippets indirectly,
// or export parsePrice for testing.

// Option: Export parsePrice from brave.ts and test directly.
// Add this import after exporting parsePrice:
import { parsePrice } from "../brave.js";

describe("parsePrice", () => {
  it("parses USD with $ symbol", () => {
    expect(parsePrice("$29.99")).toEqual({ price: 29.99, currency: "USD" });
  });

  it("parses GBP with £ symbol", () => {
    expect(parsePrice("£15.00")).toEqual({ price: 15.0, currency: "GBP" });
  });

  it("parses EUR with € symbol", () => {
    expect(parsePrice("€42")).toEqual({ price: 42, currency: "EUR" });
  });

  it("parses CNY/JPY with ¥ symbol", () => {
    expect(parsePrice("¥1280")).toEqual({ price: 1280, currency: "CNY" });
  });

  it("parses ¥ with decimals", () => {
    expect(parsePrice("¥99.50")).toEqual({ price: 99.5, currency: "CNY" });
  });

  it("parses CNY currency code", () => {
    expect(parsePrice("CNY 580")).toEqual({ price: 580, currency: "CNY" });
  });

  it("parses JPY currency code", () => {
    expect(parsePrice("JPY 1500")).toEqual({ price: 1500, currency: "JPY" });
  });

  it("returns null for no price", () => {
    expect(parsePrice("no price here")).toEqual({ price: null, currency: null });
  });

  it("returns null for null input", () => {
    expect(parsePrice(null)).toEqual({ price: null, currency: null });
  });
});
```

**Step 2: Export parsePrice from brave.ts**

In `packages/backend/src/services/brave.ts`, change `function parsePrice` (line 128) to:

```typescript
export function parsePrice(raw: string | null): { price: number | null; currency: string | null }
```

**Step 3: Run tests to verify ¥ tests fail**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: ¥ and CNY/JPY tests FAIL, others PASS.

**Step 4: Update regex patterns**

In `packages/backend/src/services/brave.ts`, update the symbol regex (line 132) from:

```typescript
const symbolMatch = raw.match(/([£$€])\s*([\d,]+(?:\.\d{1,2})?)/);
```

to:

```typescript
const symbolMatch = raw.match(/([£$€¥])\s*([\d,]+(?:\.\d{1,2})?)/);
```

Update the currency symbol map (around line 134) to include ¥:

```typescript
const currencyMap: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR", "¥": "CNY" };
```

Update the currency code regex (line 142) from:

```typescript
const codeMatch = raw.match(/(USD|GBP|EUR|CAD|AUD)\s*([\d,]+(?:\.\d{1,2})?)/);
```

to:

```typescript
const codeMatch = raw.match(/(USD|GBP|EUR|CAD|AUD|CNY|JPY)\s*([\d,]+(?:\.\d{1,2})?)/);
```

**Step 5: Run tests to verify all pass**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All tests PASS.

**Step 6: Commit**

```bash
git add packages/backend/src/services/brave.ts packages/backend/src/services/__tests__/brave.test.ts
git commit -m "feat(backend): add ¥/CNY/JPY currency support to price parsing"
```

---

### Task 5: Add Marketplace Query Generator

**Files:**
- Create: `packages/backend/src/utils/marketplace-queries.ts`
- Test: `packages/backend/src/utils/__tests__/marketplace-queries.test.ts`

**Step 1: Write failing tests**

Create `packages/backend/src/utils/__tests__/marketplace-queries.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateMarketplaceQueries } from "../marketplace-queries.js";

describe("generateMarketplaceQueries", () => {
  it("generates site-scoped queries for target marketplaces", () => {
    const queries = generateMarketplaceQueries("wireless earbuds");
    expect(queries).toContain("wireless earbuds site:aliexpress.com");
    expect(queries).toContain("wireless earbuds site:dhgate.com");
    expect(queries).toContain("wireless earbuds site:temu.com");
    expect(queries).toContain("wireless earbuds site:1688.com");
    expect(queries).toHaveLength(4);
  });

  it("trims whitespace from product name", () => {
    const queries = generateMarketplaceQueries("  blue widget  ");
    expect(queries[0]).toBe("blue widget site:aliexpress.com");
  });

  it("returns empty array for empty product name", () => {
    const queries = generateMarketplaceQueries("");
    expect(queries).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: FAIL — module not found.

**Step 3: Write implementation**

Create `packages/backend/src/utils/marketplace-queries.ts`:

```typescript
const TARGET_MARKETPLACES = [
  "aliexpress.com",
  "dhgate.com",
  "temu.com",
  "1688.com",
];

export function generateMarketplaceQueries(productName: string): string[] {
  const trimmed = productName.trim();
  if (!trimmed) return [];
  return TARGET_MARKETPLACES.map((domain) => `${trimmed} site:${domain}`);
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All tests PASS.

**Step 5: Commit**

```bash
git add packages/backend/src/utils/marketplace-queries.ts packages/backend/src/utils/__tests__/marketplace-queries.test.ts
git commit -m "feat(backend): add marketplace query generator for Chinese marketplaces"
```

---

### Task 6: Integrate Marketplace Queries into Search Pipeline

**Files:**
- Modify: `packages/backend/src/routes/search.ts`

**Step 1: Add import**

Add to imports at top of `packages/backend/src/routes/search.ts`:

```typescript
import { generateMarketplaceQueries } from "../utils/marketplace-queries.js";
```

**Step 2: Add marketplace Brave queries in Phase 2**

In `packages/backend/src/routes/search.ts`, Phase 2 (around line 85), modify the parallel search block. After the existing `groundedSearch()` and `searchProducts(aiQueries)` calls (lines 94-96), add marketplace queries to the parallel execution.

Replace the Phase 2 `Promise.allSettled` block (approximately lines 89-108) with:

```typescript
  // ── Phase 2: parallel search — grounding + brave(AI) + brave(marketplace) ──
  const aiQueries = identification.searchQueries;
  const marketplaceQueries = generateMarketplaceQueries(
    identification.description || title || "",
  );
  const phase2Deadline = Math.max(remaining() - 4000, 3000);

  const skipAiBrave = !hasNewQueries(aiQueries, titleQueries);

  const [groundingSettled, aiBraveSettled, marketplaceBraveSettled] =
    await Promise.allSettled([
      withTimeout(groundedSearch(aiQueries), phase2Deadline),
      skipAiBrave
        ? Promise.resolve(emptyProviderOutcome())
        : withTimeout(searchProducts(aiQueries), phase2Deadline),
      marketplaceQueries.length > 0
        ? withTimeout(searchProducts(marketplaceQueries), phase2Deadline)
        : Promise.resolve(emptyProviderOutcome()),
    ]);
```

Then update the result extraction below to include marketplace results. After extracting `groundingOutcome` and `aiBraveOutcome`, add:

```typescript
  const marketplaceBraveOutcome: ProviderSearchOutcome =
    marketplaceBraveSettled.status === "fulfilled"
      ? marketplaceBraveSettled.value
      : rejectedProviderOutcome(marketplaceBraveSettled.reason, marketplaceQueries.length);
```

And update where results are combined for merge/dedup to include marketplace results:

```typescript
  const allResults: SearchResult[] = [
    ...groundingOutcome.results,
    ...titleBraveOutcome.results,
    ...aiBraveOutcome.results,
    ...marketplaceBraveOutcome.results,
  ];
```

Also update the `combineBraveOutcomes` call to include marketplace results (or combine all three Brave outcomes):

```typescript
  const combinedBrave = combineBraveOutcomes(
    combineBraveOutcomes(titleBraveOutcome, aiBraveOutcome),
    marketplaceBraveOutcome,
  );
```

**Step 3: Run typecheck and tests**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/backend typecheck`
Expected: PASS (no type errors).

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All existing tests PASS.

**Step 4: Commit**

```bash
git add packages/backend/src/routes/search.ts
git commit -m "feat(backend): add Chinese marketplace site: queries to search pipeline"
```

---

### Task 7: Add POST /identify Endpoint

**Files:**
- Create: `packages/backend/src/routes/identify.ts`
- Modify: `packages/backend/src/services/gemini.ts`
- Modify: `packages/backend/src/index.ts`

**Step 1: Add identifyFromScreenshot function to Gemini service**

In `packages/backend/src/services/gemini.ts`, add after the existing `identifyProduct` function (after line 89):

```typescript
export async function identifyFromScreenshot(
  screenshotBase64: string,
): Promise<{ products: Array<{ name: string; price: number | null; currency: string | null; boundingBox: { x: number; y: number; width: number; height: number } | null }>; pageType: "product_detail" | "product_listing" | "unknown" }> {
  const prompt = `You are analyzing a screenshot of a web page. Identify all products visible in this screenshot.

For each product, extract:
- name: the product name/title
- price: the displayed price as a number (null if not visible)
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
```

**Step 2: Create identify route**

Create `packages/backend/src/routes/identify.ts`:

```typescript
import { Hono } from "hono";
import type { IdentifyRequest, IdentifyResponse } from "@shopping-assistant/shared";
import { IDENTIFY_TIMEOUT_MS } from "@shopping-assistant/shared";
import { identifyFromScreenshot } from "../services/gemini.js";

const identify = new Hono();

identify.post("/", async (c) => {
  const start = Date.now();
  const body = await c.req.json<IdentifyRequest>();

  if (!body.screenshot || !body.pageUrl) {
    return c.json({ error: "screenshot and pageUrl are required" }, 400);
  }

  // Strip data URL prefix if present (e.g. "data:image/png;base64,...")
  const base64Data = body.screenshot.includes(",")
    ? body.screenshot.split(",")[1]
    : body.screenshot;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IDENTIFY_TIMEOUT_MS);

    const result = await identifyFromScreenshot(base64Data);
    clearTimeout(timeout);

    const response: IdentifyResponse = {
      products: result.products.map((p) => ({
        name: p.name,
        price: p.price,
        currency: p.currency,
        boundingBox: p.boundingBox,
        imageRegion: null, // Cropping deferred to client
      })),
      pageType: result.pageType,
    };

    console.log(
      `[identify] Found ${response.products.length} products (${response.pageType}) in ${Date.now() - start}ms`,
    );

    return c.json(response);
  } catch (err) {
    console.error("[identify] Failed:", err);
    return c.json({ error: "Failed to identify products" }, 500);
  }
});

export default identify;
```

**Step 3: Register route in index.ts**

In `packages/backend/src/index.ts`, add import and route registration:

Add import:
```typescript
import identifyRoute from "./routes/identify.js";
```

Add route (after `app.route("/search", searchRoute);`):
```typescript
app.route("/identify", identifyRoute);
```

**Step 4: Export new types from shared**

Verify that `packages/shared/src/types.ts` exports are picked up. Check `packages/shared/src/index.ts` — if it uses barrel exports, ensure `IdentifyRequest`, `IdentifyResponse`, `IdentifiedProduct` are exported.

**Step 5: Build and typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/backend typecheck`
Expected: May still have the `priceAvailable` error — that's Task 8.

**Step 6: Commit**

```bash
git add packages/backend/src/routes/identify.ts packages/backend/src/services/gemini.ts packages/backend/src/index.ts
git commit -m "feat(backend): add POST /identify endpoint for screenshot-based product detection"
```

---

### Task 8: Fix priceAvailable in Ranking Pipeline

**Files:**
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`

**Step 1: Update applyRanking to set priceAvailable**

In `packages/backend/src/services/ranking.ts`, in the `applyRanking` function (lines 45-101), where `RankedResult` objects are constructed, add the `priceAvailable` field. Find where the result object is built (around line 58-80) and add:

```typescript
priceAvailable: r.price != null,
```

to each `RankedResult` object construction.

**Step 2: Update ranking tests**

In `packages/backend/src/services/__tests__/ranking.test.ts`, update any assertions or test fixtures that construct or check `RankedResult` objects to include `priceAvailable`. For example, in assertions checking ranked results:

```typescript
expect(ranked[0].priceAvailable).toBe(true); // result has price
```

Add a test case for results without prices:

```typescript
it("sets priceAvailable to false when result has no price", () => {
  const results: SearchResult[] = [
    makeResult({ id: "no-price", price: null }),
  ];
  const scores = { "no-price": 0.5 };
  const ranked = applyRanking(results, scores, 100);
  expect(ranked[0].priceAvailable).toBe(false);
});
```

**Step 3: Run tests**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All tests PASS.

**Step 4: Full typecheck**

Run: `pnpm build:shared && pnpm typecheck`
Expected: PASS — all `priceAvailable` errors resolved.

**Step 5: Commit**

```bash
git add packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat(backend): add priceAvailable field to ranked results"
```

---

### Task 9: Add Playwright Price Fallback Service

**Files:**
- Create: `packages/backend/src/services/price-fallback.ts`
- Modify: `packages/backend/package.json` (add playwright dependency)

**Step 1: Install Playwright**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend add playwright`
Then: `pnpm --filter @shopping-assistant/backend exec playwright install chromium`

**Step 2: Create price fallback service**

Create `packages/backend/src/services/price-fallback.ts`:

```typescript
import { chromium, type Browser } from "playwright";
import { ai, geminiModel as model } from "./ai-client.js";
import { PRICE_FALLBACK_TIMEOUT_MS } from "@shopping-assistant/shared";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function extractPriceFromUrl(
  url: string,
): Promise<{ price: number | null; currency: string | null }> {
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PRICE_FALLBACK_TIMEOUT_MS });
    // Wait briefly for dynamic price rendering
    await page.waitForTimeout(1000);

    const screenshot = await page.screenshot({ type: "png" });
    const base64 = screenshot.toString("base64");

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: base64 } },
            {
              text: `Extract the main product price from this screenshot. Return JSON: {"price": <number or null>, "currency": "<ISO code or null>"}. If no price is visible or the page shows an error/captcha, return {"price": null, "currency": null}.`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            price: { type: "number" as const, nullable: true },
            currency: { type: "string" as const, nullable: true },
          },
          required: ["price", "currency"],
        },
      },
    });

    const text = response.text ?? "{}";
    const parsed = JSON.parse(text);
    return {
      price: typeof parsed.price === "number" ? parsed.price : null,
      currency: typeof parsed.currency === "string" ? parsed.currency : null,
    };
  } catch (err) {
    console.error(`[price-fallback] Failed for ${url}:`, err);
    return { price: null, currency: null };
  } finally {
    await context.close();
  }
}

export async function fillMissingPrices(
  results: Array<{ id: string; productUrl: string; price: number | null; currency: string | null }>,
  maxResults: number,
): Promise<Map<string, { price: number; currency: string }>> {
  const priceless = results
    .filter((r) => r.price == null)
    .slice(0, maxResults);

  const extracted = new Map<string, { price: number; currency: string }>();

  const settled = await Promise.allSettled(
    priceless.map(async (r) => {
      const result = await extractPriceFromUrl(r.productUrl);
      if (result.price != null && result.currency != null) {
        extracted.set(r.id, { price: result.price, currency: result.currency });
      }
    }),
  );

  const failed = settled.filter((s) => s.status === "rejected").length;
  if (failed > 0) {
    console.warn(`[price-fallback] ${failed}/${priceless.length} extractions failed`);
  }

  console.log(
    `[price-fallback] Extracted prices for ${extracted.size}/${priceless.length} results`,
  );

  return extracted;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
```

**Step 3: Typecheck**

Run: `pnpm --filter @shopping-assistant/backend typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add packages/backend/src/services/price-fallback.ts packages/backend/package.json pnpm-lock.yaml
git commit -m "feat(backend): add Playwright-based price fallback service with Gemini Vision"
```

---

### Task 10: Integrate Price Fallback into Search Pipeline

**Files:**
- Modify: `packages/backend/src/routes/search.ts`

**Step 1: Add imports**

Add to `packages/backend/src/routes/search.ts`:

```typescript
import { fillMissingPrices } from "../services/price-fallback.js";
import { MAX_PRICE_FALLBACK_RESULTS, PRICE_FALLBACK_TIMEOUT_MS } from "@shopping-assistant/shared";
```

**Step 2: Add price fallback phase between merge/dedup and ranking**

After the merge/dedup and heuristicPreSort block (after approximately line 126), and before the image fetching block (line 128), insert:

```typescript
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
      console.log(`[search] Price fallback filled ${extractedPrices.size} prices`);
    } catch (err) {
      console.warn("[search] Price fallback timed out or failed:", err);
    }
  } else {
    console.log("[search] Skipping price fallback — insufficient time remaining");
  }
```

**Step 3: Typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/backend typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add packages/backend/src/routes/search.ts
git commit -m "feat(backend): integrate price fallback phase into search pipeline"
```

---

### Task 11: Remove Content Script and Update Extension Manifest

**Files:**
- Delete: `packages/extension/src/content/index.ts`
- Modify: `packages/extension/src/manifest.json`

**Step 1: Remove content_scripts from manifest**

In `packages/extension/src/manifest.json`, remove the entire `content_scripts` block (lines 12-17):

```json
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/index.ts"],
      "run_at": "document_idle"
    }
  ],
```

**Step 2: Delete the content script file**

Run: `rm packages/extension/src/content/index.ts`
If the directory is now empty: `rmdir packages/extension/src/content`

**Step 3: Verify no other code imports from content script**

Run: `grep -r "content/index" packages/extension/`
Expected: No matches.

**Step 4: Build extension**

Run: `pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS (content script was a standalone module).

**Step 5: Commit**

```bash
git add -A packages/extension/src/content/ packages/extension/src/manifest.json
git commit -m "feat(extension): remove content script and all_urls permission to prevent bot detection"
```

---

### Task 12: Update Service Worker for Screenshot Flow

**Files:**
- Modify: `packages/extension/src/background/index.ts`

**Step 1: Implement screenshot → identify → search flow**

Replace the contents of `packages/extension/src/background/index.ts`:

```typescript
import type {
  IdentifyResponse,
  SearchRequest,
  SearchResponse,
} from "@shopping-assistant/shared";
import { CACHE_TTL_MS, CACHE_MAX_ENTRIES } from "@shopping-assistant/shared";

const BACKEND_URL = "http://localhost:8080";

console.log("[Shopping Assistant] Service worker started");

// Open side panel and trigger screenshot on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // Open side panel first
  await chrome.sidePanel.open({ tabId: tab.id });

  try {
    // Capture visible tab screenshot
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });

    // Send to backend for product identification
    const identifyRes = await fetch(`${BACKEND_URL}/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        screenshot: screenshotDataUrl,
        pageUrl: tab.url ?? "",
      }),
    });

    if (!identifyRes.ok) {
      notifySidePanel(tab.id, {
        type: "error",
        message: "Failed to identify products on this page.",
      });
      return;
    }

    const identified: IdentifyResponse = await identifyRes.json();

    if (identified.products.length === 0) {
      notifySidePanel(tab.id, {
        type: "error",
        message: "No products found on this page.",
      });
      return;
    }

    if (identified.products.length === 1 || identified.pageType === "product_detail") {
      // Auto-select the single/main product
      const product = identified.products[0];
      notifySidePanel(tab.id, { type: "searching", product });
      await searchForProduct(tab.id, product, screenshotDataUrl, tab.url ?? "");
    } else {
      // Multiple products — let user pick
      notifySidePanel(tab.id, {
        type: "product_selection",
        products: identified.products,
        screenshotDataUrl,
        pageUrl: tab.url ?? "",
      });
    }
  } catch (err) {
    console.error("[Shopping Assistant] Screenshot flow failed:", err);
    if (tab.id) {
      notifySidePanel(tab.id, {
        type: "error",
        message: "Something went wrong. Please try again.",
      });
    }
  }
});

// Listen for product selection from side panel
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "select_product") {
    const { tabId, product, screenshotDataUrl, pageUrl } = message;
    searchForProduct(tabId, product, screenshotDataUrl, pageUrl).then(() =>
      sendResponse({ status: "ok" }),
    );
    return true; // async response
  }
  return false;
});

async function searchForProduct(
  tabId: number,
  product: { name: string; price: number | null; currency: string | null },
  screenshotDataUrl: string,
  pageUrl: string,
): Promise<void> {
  // Check cache first
  const cacheKey = `search:${product.name}:${pageUrl}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    notifySidePanel(tabId, { type: "results", response: cached });
    return;
  }

  try {
    const searchReq: SearchRequest = {
      imageUrl: "",
      imageBase64: screenshotDataUrl.includes(",")
        ? screenshotDataUrl.split(",")[1]
        : screenshotDataUrl,
      title: product.name,
      price: product.price,
      currency: product.currency,
      sourceUrl: pageUrl,
    };

    notifySidePanel(tabId, { type: "searching", product });

    const searchRes = await fetch(`${BACKEND_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchReq),
    });

    if (!searchRes.ok) {
      notifySidePanel(tabId, {
        type: "error",
        message: "Search failed. Please try again.",
      });
      return;
    }

    const response: SearchResponse = await searchRes.json();
    await setCache(cacheKey, response);
    notifySidePanel(tabId, { type: "results", response });
  } catch (err) {
    console.error("[Shopping Assistant] Search failed:", err);
    notifySidePanel(tabId, {
      type: "error",
      message: "Search failed. Please try again.",
    });
  }
}

function notifySidePanel(tabId: number, message: Record<string, unknown>): void {
  chrome.runtime.sendMessage({ target: "sidepanel", tabId, ...message }).catch(() => {
    // Side panel may not be ready yet
  });
}

async function getCached(key: string): Promise<SearchResponse | null> {
  const data = await chrome.storage.local.get(key);
  if (!data[key]) return null;
  const entry = data[key] as { response: SearchResponse; cachedAt: number };
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry.response;
}

async function setCache(key: string, response: SearchResponse): Promise<void> {
  // LRU eviction
  const all = await chrome.storage.local.get(null);
  const searchKeys = Object.keys(all).filter((k) => k.startsWith("search:"));
  if (searchKeys.length >= CACHE_MAX_ENTRIES) {
    const oldest = searchKeys
      .map((k) => ({ key: k, cachedAt: (all[k] as { cachedAt: number }).cachedAt }))
      .sort((a, b) => a.cachedAt - b.cachedAt);
    const toRemove = oldest.slice(0, searchKeys.length - CACHE_MAX_ENTRIES + 1).map((e) => e.key);
    await chrome.storage.local.remove(toRemove);
  }
  await chrome.storage.local.set({ [key]: { response, cachedAt: Date.now() } });
}
```

**Step 2: Typecheck**

Run: `pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/extension/src/background/index.ts
git commit -m "feat(extension): implement screenshot-based product detection in service worker"
```

---

### Task 13: Update Side Panel for Product Selection and Price Filtering

**Files:**
- Modify: `packages/extension/src/sidepanel/App.tsx`

**Step 1: Implement side panel states**

Replace `packages/extension/src/sidepanel/App.tsx`:

```tsx
import { useState, useEffect } from "react";
import type {
  IdentifiedProduct,
  SearchResponse,
  RankedResult,
} from "@shopping-assistant/shared";

type PanelState =
  | { kind: "idle" }
  | { kind: "identifying" }
  | { kind: "product_selection"; products: IdentifiedProduct[]; screenshotDataUrl: string; pageUrl: string }
  | { kind: "searching"; product: IdentifiedProduct }
  | { kind: "results"; response: SearchResponse }
  | { kind: "error"; message: string };

export default function App() {
  const [state, setState] = useState<PanelState>({ kind: "idle" });

  useEffect(() => {
    const listener = (message: Record<string, unknown>) => {
      if (message.target !== "sidepanel") return;

      switch (message.type) {
        case "product_selection":
          setState({
            kind: "product_selection",
            products: message.products as IdentifiedProduct[],
            screenshotDataUrl: message.screenshotDataUrl as string,
            pageUrl: message.pageUrl as string,
          });
          break;
        case "searching":
          setState({
            kind: "searching",
            product: message.product as IdentifiedProduct,
          });
          break;
        case "results":
          setState({
            kind: "results",
            response: message.response as SearchResponse,
          });
          break;
        case "error":
          setState({
            kind: "error",
            message: (message.message as string) || "Something went wrong.",
          });
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <div className="panel">
      <header className="header">
        <h1>Shopping Assistant</h1>
      </header>
      <main className="main">
        {state.kind === "idle" && (
          <p className="placeholder">
            Click the extension icon on any product page to find cheaper alternatives.
          </p>
        )}

        {state.kind === "identifying" && (
          <p className="status">Identifying products...</p>
        )}

        {state.kind === "product_selection" && (
          <ProductSelectionGrid
            products={state.products}
            onSelect={(product) => {
              chrome.runtime.sendMessage({
                type: "select_product",
                tabId: null, // Service worker will use sender tab
                product,
                screenshotDataUrl: state.screenshotDataUrl,
                pageUrl: state.pageUrl,
              });
              setState({ kind: "searching", product });
            }}
          />
        )}

        {state.kind === "searching" && (
          <div className="status">
            <p>Searching for cheaper alternatives...</p>
            <p className="product-name">{state.product.name}</p>
            {state.product.price != null && (
              <p className="product-price">
                {state.product.currency ?? "$"}{state.product.price.toFixed(2)}
              </p>
            )}
          </div>
        )}

        {state.kind === "results" && (
          <ResultsList response={state.response} />
        )}

        {state.kind === "error" && (
          <div className="error">
            <p>{state.message}</p>
            <button onClick={() => setState({ kind: "idle" })}>Try again</button>
          </div>
        )}
      </main>
    </div>
  );
}

function ProductSelectionGrid({
  products,
  onSelect,
}: {
  products: IdentifiedProduct[];
  onSelect: (product: IdentifiedProduct) => void;
}) {
  return (
    <div className="product-grid">
      <p>Multiple products found. Which one?</p>
      {products.map((product, i) => (
        <button
          key={i}
          className="product-card"
          onClick={() => onSelect(product)}
        >
          <span className="product-name">{product.name}</span>
          {product.price != null && (
            <span className="product-price">
              {product.currency ?? "$"}{product.price.toFixed(2)}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function ResultsList({ response }: { response: SearchResponse }) {
  // Filter to only show results with prices
  const displayResults = response.results.filter((r) => r.priceAvailable);
  const hiddenCount = response.results.length - displayResults.length;

  return (
    <div className="results">
      <div className="original-product">
        <h2>{response.originalProduct.title ?? "Product"}</h2>
        {response.originalProduct.price != null && (
          <p className="original-price">
            {response.originalProduct.currency ?? "$"}
            {response.originalProduct.price.toFixed(2)}
          </p>
        )}
      </div>

      {displayResults.length === 0 ? (
        <p className="no-results">No alternatives with pricing found.</p>
      ) : (
        <ul className="result-list">
          {displayResults.map((ranked: RankedResult) => (
            <li key={ranked.result.id} className="result-item">
              <a
                href={ranked.result.productUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="result-title">{ranked.result.title}</span>
                <span className="result-marketplace">{ranked.result.marketplace}</span>
                <span className="result-price">
                  {ranked.result.currency ?? "$"}
                  {ranked.result.price?.toFixed(2)}
                </span>
                {ranked.savingsPercent != null && ranked.savingsPercent > 0 && (
                  <span className="savings">
                    Save {ranked.savingsPercent.toFixed(0)}%
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}

      {hiddenCount > 0 && (
        <p className="hidden-count">
          {hiddenCount} result{hiddenCount > 1 ? "s" : ""} hidden (no price available)
        </p>
      )}

      <p className="meta">
        Found {response.searchMeta.totalFound} results in{" "}
        {(response.searchMeta.searchDurationMs / 1000).toFixed(1)}s
      </p>
    </div>
  );
}
```

**Step 2: Typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/extension/src/sidepanel/App.tsx
git commit -m "feat(extension): add product selection grid, results display, and N/A price filtering to side panel"
```

---

### Task 14: Increase Search Timeout to Account for Price Fallback

**Files:**
- Modify: `packages/shared/src/constants.ts`

**Step 1: Increase SEARCH_TIMEOUT_MS**

The price fallback phase adds up to 5s. Increase the total timeout from 15s to 20s:

```typescript
export const SEARCH_TIMEOUT_MS = 20_000;
```

**Step 2: Build and commit**

Run: `pnpm build:shared && pnpm typecheck`
Expected: PASS.

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): increase search timeout to 20s to accommodate price fallback phase"
```

---

### Task 15: End-to-End Verification

**Step 1: Full build**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm build`
Expected: All packages build successfully.

**Step 2: Run all tests**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All tests PASS.

**Step 3: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS across all packages.

**Step 4: Start backend and verify endpoints**

Run: `pnpm dev:backend`

Test identify endpoint (use a base64 test image or skip if no test image available):
```bash
curl -s http://localhost:8080/identify -X POST -H "Content-Type: application/json" -d '{"screenshot":"iVBORw0KGgo=","pageUrl":"https://example.com"}' | head -c 200
```
Expected: JSON response (may error on invalid image, but endpoint should respond).

Test search endpoint is still functional:
```bash
curl -s http://localhost:8080/search -X POST -H "Content-Type: application/json" -d '{"imageUrl":"https://example.com/test.jpg","title":"test","sourceUrl":"https://example.com"}' | head -c 200
```
Expected: JSON response.

**Step 5: Commit if any fixes were needed**

```bash
git add -A && git commit -m "fix: resolve issues found during end-to-end verification"
```
