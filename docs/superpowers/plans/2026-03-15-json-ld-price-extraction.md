# JSON-LD Price Extraction Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Playwright screenshot-based price fallback with a lightweight HTTP fetch + JSON-LD/structured-data extraction pipeline that actually works.

**Architecture:** Fetch raw HTML via `fetch()` with proper headers (no headless browser). Extract prices from JSON-LD (`<script type="application/ld+json">`), then meta tags (og:price, product:price), then regex on raw HTML. Only fall back to Playwright (with increased timeout) as a last resort. This avoids bot detection, is 10-100x faster, and doesn't require Gemini Vision API calls.

**Tech Stack:** Node.js fetch API, regex, JSON parsing. Existing Playwright as fallback only.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/backend/src/services/price-extractor.ts` | Lightweight HTTP-based price extraction (JSON-LD, meta, regex) |
| Create | `packages/backend/src/services/__tests__/price-extractor.test.ts` | Unit tests for all extraction strategies |
| Modify | `packages/backend/src/services/price-fallback.ts` | Orchestrate: try HTTP extraction first, Playwright as last resort |
| Modify | `packages/shared/src/constants.ts` | Increase `PRICE_NAV_TIMEOUT_MS` to 5000ms, add `PRICE_HTTP_TIMEOUT_MS` |

---

## Chunk 1: HTTP-Based Price Extractor

### Task 1: Create price-extractor with JSON-LD extraction

**Files:**
- Create: `packages/backend/src/services/price-extractor.ts`
- Create: `packages/backend/src/services/__tests__/price-extractor.test.ts`

- [ ] **Step 1: Write failing tests for JSON-LD extraction**

```typescript
// packages/backend/src/services/__tests__/price-extractor.test.ts
import { describe, it, expect } from "vitest";
import { extractPriceFromHtml } from "../price-extractor.js";

describe("extractPriceFromHtml", () => {
  describe("JSON-LD extraction", () => {
    it("extracts price from Product schema", () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {"@type":"Product","name":"Test","offers":{"@type":"Offer","price":"29.99","priceCurrency":"USD"}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 29.99, currency: "USD" });
    });

    it("extracts price from AggregateOffer lowPrice", () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"@type":"AggregateOffer","lowPrice":"15.50","priceCurrency":"GBP"}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 15.5, currency: "GBP" });
    });

    it("extracts from nested @graph array", () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {"@graph":[{"@type":"Product","offers":{"price":42,"priceCurrency":"EUR"}}]}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 42, currency: "EUR" });
    });

    it("handles multiple ld+json blocks", () => {
      const html = `<html><head>
        <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"price":"9.99","priceCurrency":"USD"}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 9.99, currency: "USD" });
    });

    it("handles price as number not string", () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"price":199,"priceCurrency":"USD"}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 199, currency: "USD" });
    });

    it("returns null for non-product JSON-LD", () => {
      const html = `<html><head>
        <script type="application/ld+json">{"@type":"Organization","name":"Acme"}</script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: null, currency: null });
    });
  });

  describe("meta tag extraction", () => {
    it("extracts from og:price:amount meta tag", () => {
      const html = `<html><head>
        <meta property="og:price:amount" content="24.99">
        <meta property="og:price:currency" content="USD">
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 24.99, currency: "USD" });
    });

    it("extracts from product:price:amount meta tag", () => {
      const html = `<html><head>
        <meta property="product:price:amount" content="59.00">
        <meta property="product:price:currency" content="EUR">
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 59, currency: "EUR" });
    });
  });

  describe("regex fallback", () => {
    it("extracts price from visible text with dollar sign", () => {
      const html = `<html><body><span class="price">$34.99</span></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 34.99, currency: "USD" });
    });

    it("returns null for html with no price signals", () => {
      const html = `<html><body><p>Hello world</p></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: null, currency: null });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/price-extractor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement price-extractor.ts**

```typescript
// packages/backend/src/services/price-extractor.ts

/** Extract price from raw HTML using structured data (no JS rendering needed). */
export function extractPriceFromHtml(
  html: string,
): { price: number | null; currency: string | null } {
  // Strategy 1: JSON-LD structured data
  const jsonLdResult = extractFromJsonLd(html);
  if (jsonLdResult.price !== null) return jsonLdResult;

  // Strategy 2: Meta tags (Open Graph, product)
  const metaResult = extractFromMetaTags(html);
  if (metaResult.price !== null) return metaResult;

  // Strategy 3: Regex on visible text (least reliable)
  return extractFromRegex(html);
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

const JSON_LD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractFromJsonLd(
  html: string,
): { price: number | null; currency: string | null } {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = JSON_LD_RE.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  JSON_LD_RE.lastIndex = 0; // reset for next call

  for (const block of blocks) {
    try {
      const data = JSON.parse(block);
      const result = extractPriceFromJsonLdObject(data);
      if (result.price !== null) return result;
    } catch {
      // malformed JSON-LD, skip
    }
  }

  return { price: null, currency: null };
}

function extractPriceFromJsonLdObject(
  obj: unknown,
): { price: number | null; currency: string | null } {
  if (!obj || typeof obj !== "object") return { price: null, currency: null };

  // Handle @graph arrays
  if ("@graph" in (obj as Record<string, unknown>)) {
    const graph = (obj as Record<string, unknown>)["@graph"];
    if (Array.isArray(graph)) {
      for (const item of graph) {
        const result = extractPriceFromJsonLdObject(item);
        if (result.price !== null) return result;
      }
    }
    return { price: null, currency: null };
  }

  // Handle arrays at top level
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = extractPriceFromJsonLdObject(item);
      if (result.price !== null) return result;
    }
    return { price: null, currency: null };
  }

  const record = obj as Record<string, unknown>;
  const type = record["@type"];

  // Only extract from Product types
  if (type !== "Product") return { price: null, currency: null };

  const offers = record["offers"];
  if (!offers || typeof offers !== "object") return { price: null, currency: null };

  return extractPriceFromOffer(offers as Record<string, unknown>);
}

function extractPriceFromOffer(
  offer: Record<string, unknown>,
): { price: number | null; currency: string | null } {
  // Handle array of offers — take the first one with a price
  if (Array.isArray(offer)) {
    for (const o of offer) {
      if (typeof o === "object" && o !== null) {
        const result = extractPriceFromOffer(o as Record<string, unknown>);
        if (result.price !== null) return result;
      }
    }
    return { price: null, currency: null };
  }

  const currency = typeof offer["priceCurrency"] === "string" ? offer["priceCurrency"] : null;

  // AggregateOffer — prefer lowPrice
  if (offer["@type"] === "AggregateOffer" && offer["lowPrice"] !== undefined) {
    const price = toNumber(offer["lowPrice"]);
    if (price !== null) return { price, currency };
  }

  // Standard Offer
  if (offer["price"] !== undefined) {
    const price = toNumber(offer["price"]);
    if (price !== null) return { price, currency };
  }

  return { price: null, currency: null };
}

// ── Meta Tags ────────────────────────────────────────────────────────────────

const META_PRICE_RE =
  /<meta\s+(?:[^>]*?)property\s*=\s*["'](?:og|product):price:amount["']\s+content\s*=\s*["']([^"']+)["']/i;
const META_CURRENCY_RE =
  /<meta\s+(?:[^>]*?)property\s*=\s*["'](?:og|product):price:currency["']\s+content\s*=\s*["']([^"']+)["']/i;

// Also match reverse attribute order: content before property
const META_PRICE_REV_RE =
  /<meta\s+(?:[^>]*?)content\s*=\s*["']([^"']+)["']\s+property\s*=\s*["'](?:og|product):price:amount["']/i;
const META_CURRENCY_REV_RE =
  /<meta\s+(?:[^>]*?)content\s*=\s*["']([^"']+)["']\s+property\s*=\s*["'](?:og|product):price:currency["']/i;

function extractFromMetaTags(
  html: string,
): { price: number | null; currency: string | null } {
  const priceMatch = html.match(META_PRICE_RE) ?? html.match(META_PRICE_REV_RE);
  if (!priceMatch) return { price: null, currency: null };

  const price = toNumber(priceMatch[1]);
  if (price === null) return { price: null, currency: null };

  const currencyMatch = html.match(META_CURRENCY_RE) ?? html.match(META_CURRENCY_REV_RE);
  const currency = currencyMatch?.[1] ?? null;

  return { price, currency };
}

// ── Regex Fallback ───────────────────────────────────────────────────────────

const PRICE_PATTERNS = [
  // "$29.99" or "$ 29.99"
  { re: /\$\s*([\d,]+(?:\.\d{1,2})?)/, currency: "USD" },
  { re: /£\s*([\d,]+(?:\.\d{1,2})?)/, currency: "GBP" },
  { re: /€\s*([\d,]+(?:\.\d{1,2})?)/, currency: "EUR" },
];

function extractFromRegex(
  html: string,
): { price: number | null; currency: string | null } {
  // Strip script/style tags to avoid matching JS variables
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  for (const { re, currency } of PRICE_PATTERNS) {
    const match = visible.match(re);
    if (match) {
      const price = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(price) && price > 0) {
        return { price, currency };
      }
    }
  }

  return { price: null, currency: null };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.replace(/,/g, ""));
    if (!isNaN(n) && isFinite(n)) return n;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/price-extractor.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/services/price-extractor.ts packages/backend/src/services/__tests__/price-extractor.test.ts
git commit -m "feat: add JSON-LD/meta/regex price extraction from raw HTML"
```

---

### Task 2: Create HTTP fetch function for price extraction

**Files:**
- Modify: `packages/backend/src/services/price-extractor.ts`
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Add PRICE_HTTP_TIMEOUT_MS constant**

In `packages/shared/src/constants.ts`, add after `PRICE_NAV_TIMEOUT_MS`:

```typescript
export const PRICE_HTTP_TIMEOUT_MS = 4_000;
```

- [ ] **Step 2: Write failing test for fetchAndExtractPrice**

Add to `packages/backend/src/services/__tests__/price-extractor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractPriceFromHtml, fetchAndExtractPrice } from "../price-extractor.js";

// ... existing tests ...

describe("fetchAndExtractPrice", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts price from fetched HTML with JSON-LD", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(`<html><head>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"price":"49.99","priceCurrency":"USD"}}
        </script></head><body></body></html>`),
    });

    const result = await fetchAndExtractPrice("https://example.com/product");
    expect(result).toEqual({ price: 49.99, currency: "USD" });
  });

  it("returns null for non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const result = await fetchAndExtractPrice("https://example.com/blocked");
    expect(result).toEqual({ price: null, currency: null });
  });

  it("returns null on fetch error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await fetchAndExtractPrice("https://example.com/down");
    expect(result).toEqual({ price: null, currency: null });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/price-extractor.test.ts`
Expected: FAIL — fetchAndExtractPrice not exported

- [ ] **Step 4: Implement fetchAndExtractPrice**

Add to `packages/backend/src/services/price-extractor.ts`:

```typescript
import { PRICE_HTTP_TIMEOUT_MS } from "@shopping-assistant/shared";

const FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Fetch a URL via lightweight HTTP and extract price from structured data in HTML. */
export async function fetchAndExtractPrice(
  url: string,
): Promise<{ price: number | null; currency: string | null }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(PRICE_HTTP_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!res.ok) return { price: null, currency: null };

    const html = await res.text();
    return extractPriceFromHtml(html);
  } catch {
    return { price: null, currency: null };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm --filter @shopping-assistant/backend test -- --run src/services/__tests__/price-extractor.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/services/price-extractor.ts packages/backend/src/services/__tests__/price-extractor.test.ts packages/shared/src/constants.ts
git commit -m "feat: add HTTP fetch + structured data price extraction"
```

---

### Task 3: Rewire price-fallback to use HTTP extraction first

**Files:**
- Modify: `packages/backend/src/services/price-fallback.ts`
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Increase PRICE_NAV_TIMEOUT_MS**

In `packages/shared/src/constants.ts`, change:

```typescript
export const PRICE_NAV_TIMEOUT_MS = 5_000;
```

This gives Playwright a fighting chance when it IS used (only as last resort now).

- [ ] **Step 2: Modify price-fallback.ts to try HTTP first**

Replace the `extractPriceFromUrl` function body in `packages/backend/src/services/price-fallback.ts`:

```typescript
import { chromium, type Browser } from "playwright";
import { ai, geminiModel as model } from "./ai-client.js";
import { PRICE_NAV_TIMEOUT_MS } from "@shopping-assistant/shared";
import { fetchAndExtractPrice } from "./price-extractor.js";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  if (!launching) {
    launching = chromium.launch({ headless: true }).then((b) => {
      browser = b;
      launching = null;
      return b;
    });
  }
  return launching;
}

export async function extractPriceFromUrl(
  url: string,
): Promise<{ price: number | null; currency: string | null }> {
  // Strategy 1: Lightweight HTTP fetch + structured data (fast, no bot detection)
  const httpResult = await fetchAndExtractPrice(url);
  if (httpResult.price !== null) {
    console.log(`[price-fallback] HTTP extraction succeeded for ${new URL(url).hostname}`);
    return httpResult;
  }

  // Strategy 2: Playwright screenshot + Gemini Vision (slow, expensive, last resort)
  return extractPriceViaPlaywright(url);
}

async function extractPriceViaPlaywright(
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PRICE_NAV_TIMEOUT_MS });
    await page.waitForTimeout(500);

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
    console.error(`[price-fallback] Playwright failed for ${url}:`, err);
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

- [ ] **Step 3: Build shared and run all backend tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm --filter @shopping-assistant/backend test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd /workspaces/web-dev-playground/shopping-assistant
git add packages/backend/src/services/price-fallback.ts packages/shared/src/constants.ts
git commit -m "feat: rewire price fallback to try HTTP/JSON-LD before Playwright"
```

- [ ] **Step 5: Run typecheck**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm typecheck`
Expected: No errors
