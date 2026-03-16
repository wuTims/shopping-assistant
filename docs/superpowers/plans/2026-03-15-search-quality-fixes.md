# Search Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix same-platform result flooding, incorrect price extraction, and embedding failures to improve search result quality.

**Architecture:** Pure logic changes in the ranking pipeline and price extraction — zero additional network requests. Source marketplace awareness is threaded from URL extraction through scoring and capping. Price regex uses frequency-based selection instead of first-match. Embedding adds pre-call validation.

**Tech Stack:** TypeScript, Vitest

**Bot Detection Safety:** All changes process data already fetched. No new HTTP requests, no new Playwright navigations, no increased API call volume. The only external calls modified are the Gemini embedding calls, which get pre-validation to *reduce* failed calls.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/shared/src/constants.ts` | Modify | Add `SOURCE_MARKETPLACE_PENALTY`, `MAX_SOURCE_MARKETPLACE_RESULTS` |
| `packages/backend/src/services/ranking.ts` | Modify | Add source marketplace penalty to scoring, source-aware diversity cap, non-product URL filtering |
| `packages/backend/src/routes/search.ts` | Modify | Extract source marketplace, filter source URL, pass to ranking functions |
| `packages/backend/src/services/price-extractor.ts` | Modify | Frequency-based regex price extraction |
| `packages/backend/src/services/embedding.ts` | Modify | Validate image data before API call |
| `packages/backend/src/services/__tests__/ranking.test.ts` | Modify | Tests for source marketplace penalty and diversity cap |
| `packages/backend/src/services/__tests__/price-extractor.test.ts` | Modify | Tests for frequency-based regex |
| `packages/backend/src/services/__tests__/embedding.test.ts` | Modify | Tests for image validation |

---

## Chunk 1: Same-Platform Filtering

### Task 1: Add constants and source marketplace helper

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/backend/src/services/ranking.ts`

- [ ] **Step 1: Add constants to shared package**

In `packages/shared/src/constants.ts`, add after the `VISUAL_SCORE_WEIGHT` line (line 28):

```typescript
export const SOURCE_MARKETPLACE_PENALTY = 0.15;
export const MAX_SOURCE_MARKETPLACE_RESULTS = 2;
```

- [ ] **Step 2: Add `baseMarketplace` helper to ranking.ts**

In `packages/backend/src/services/ranking.ts`, add at the bottom of the helpers section (after the `clamp` function, line 354):

```typescript
/** Normalize marketplace variants to base name (e.g., "Amazon UK" → "Amazon"). */
export function baseMarketplace(name: string): string {
  if (name.startsWith("Amazon")) return "Amazon";
  if (name.startsWith("eBay")) return "eBay";
  return name;
}
```

- [ ] **Step 3: Add unit tests for `baseMarketplace`**

In `packages/backend/src/services/__tests__/ranking.test.ts`, update the import (line 3) to include `baseMarketplace`:

```typescript
import { mergeAndDedup, applyRanking, buildFallbackScores, heuristicPreSort, diversityCap, baseMarketplace } from "../ranking.js";
```

Add a new describe block after the existing `heuristicPreSort` block:

```typescript
describe("baseMarketplace", () => {
  it('normalizes "Amazon UK" to "Amazon"', () => {
    expect(baseMarketplace("Amazon UK")).toBe("Amazon");
  });

  it('normalizes "Amazon DE" to "Amazon"', () => {
    expect(baseMarketplace("Amazon DE")).toBe("Amazon");
  });

  it('normalizes "eBay UK" to "eBay"', () => {
    expect(baseMarketplace("eBay UK")).toBe("eBay");
  });

  it("returns other marketplace names unchanged", () => {
    expect(baseMarketplace("AliExpress")).toBe("AliExpress");
    expect(baseMarketplace("Temu")).toBe("Temu");
    expect(baseMarketplace("Walmart")).toBe("Walmart");
  });
});
```

- [ ] **Step 5: Build shared package**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared`
Expected: Clean build

- [ ] **Step 6: Run baseMarketplace tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/ranking.test.ts`
Expected: All tests PASS (including new `baseMarketplace` tests)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants.ts packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat: add source marketplace constants and helper"
```

---

### Task 2: Source-aware scoring in `buildFallbackScores`

**Files:**
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/backend/src/services/__tests__/ranking.test.ts`, add to the `buildFallbackScores` describe block (after line 215):

```typescript
  it("penalizes results from the same marketplace as source", () => {
    const results = [
      makeResult({ id: "a", title: "Sony Wireless Headphones", marketplace: "Amazon" }),
      makeResult({ id: "b", title: "Sony Wireless Headphones", marketplace: "eBay" }),
    ];
    const scores = buildFallbackScores(results, baseIdentification, "Amazon");
    expect(scores.b).toBeGreaterThan(scores.a);
  });

  it("penalizes regional variants of source marketplace", () => {
    const results = [
      makeResult({ id: "a", title: "Sony Wireless Headphones", marketplace: "Amazon UK" }),
      makeResult({ id: "b", title: "Sony Wireless Headphones", marketplace: "AliExpress" }),
    ];
    const scores = buildFallbackScores(results, baseIdentification, "Amazon");
    expect(scores.b).toBeGreaterThan(scores.a);
  });

  it("applies no penalty when sourceMarketplace is null", () => {
    const results = [
      makeResult({ id: "a", title: "Sony Wireless Headphones", marketplace: "Amazon" }),
    ];
    const withSource = buildFallbackScores(results, baseIdentification, "Amazon");
    const withoutSource = buildFallbackScores(results, baseIdentification, null);
    expect(withoutSource.a).toBeGreaterThan(withSource.a);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/ranking.test.ts`
Expected: FAIL — `buildFallbackScores` doesn't accept 3rd argument

- [ ] **Step 3: Update import and function signature**

In `packages/backend/src/services/ranking.ts`, update the imports (line 2):

```typescript
import { CONFIDENCE_THRESHOLDS, MIN_CONFIDENCE_SCORE, MIN_DISPLAY_RESULTS, SOURCE_MARKETPLACE_PENALTY } from "@shopping-assistant/shared";
```

Update `buildFallbackScores` signature (line 126-129) to:

```typescript
export function buildFallbackScores(
  results: SearchResult[],
  identification: ProductIdentification,
  sourceMarketplace: string | null = null,
): Record<string, number> {
```

Add the penalty calculation after `richnessBoost` (line 156), before `rawScore`:

```typescript
    const sourcePenalty =
      sourceMarketplace && baseMarketplace(result.marketplace) === baseMarketplace(sourceMarketplace)
        ? SOURCE_MARKETPLACE_PENALTY
        : 0;
    const rawScore = 0.12 + overlapRatio * 0.55 + brandBoost + categoryBoost + richnessBoost - sourcePenalty;
```

Update the log line (around line 161) to include source penalty:

```typescript
    console.log(
      `[text-scoring]   [${result.id}] "${result.title.slice(0, 50)}": ` +
      `overlap=${overlap}/${referenceTokens.size} (${(overlapRatio * 100).toFixed(0)}%) ` +
      `brand=${brandBoost.toFixed(2)} cat=${categoryBoost.toFixed(2)} rich=${richnessBoost.toFixed(2)} ` +
      `src=${sourcePenalty > 0 ? `-${sourcePenalty.toFixed(2)}` : "0.00"} ` +
      `→ ${scores[result.id].toFixed(3)} [${matchedTokens.join(",")}]`,
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/ranking.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat: add source marketplace penalty to text scoring"
```

---

### Task 3: Source-aware `heuristicPreSort`

**Files:**
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/backend/src/services/__tests__/ranking.test.ts`, add to the `heuristicPreSort` describe block (after line 257):

```typescript
  it("deprioritizes results from source marketplace", () => {
    const results = [
      makeResult({ id: "a", title: "Sony Wireless Headphones", marketplace: "Amazon" }),
      makeResult({ id: "b", title: "Sony Wireless Headphones", marketplace: "eBay" }),
    ];
    const sorted = heuristicPreSort(results, baseIdentification, null, "Amazon");
    expect(sorted[0].id).toBe("b");
  });
```

Update the existing `heuristicPreSort` import in the test file (line 3) to also import `baseMarketplace` if not already exported — actually it's already in the same module. Just add the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/ranking.test.ts`
Expected: FAIL — `heuristicPreSort` doesn't accept 4th argument

- [ ] **Step 3: Update function signature and add penalty**

In `packages/backend/src/services/ranking.ts`, update `heuristicPreSort` signature (lines 179-183):

```typescript
export function heuristicPreSort(
  results: SearchResult[],
  identification: ProductIdentification,
  originalPrice: number | null,
  sourceMarketplace: string | null = null,
): SearchResult[] {
```

Add source penalty after `marketplaceScore` (line 218), before `total` (line 220):

```typescript
    const sourcePenalty =
      sourceMarketplace && baseMarketplace(r.marketplace) === baseMarketplace(sourceMarketplace)
        ? SOURCE_MARKETPLACE_PENALTY
        : 0;

    const total = overlapScore * 0.4 + brandScore + hasPrice + hasImage + priceProximity + marketplaceScore - sourcePenalty;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/ranking.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat: add source marketplace penalty to heuristic pre-sort"
```

---

### Task 4: Source-aware `diversityCap`

**Files:**
- Modify: `packages/backend/src/services/ranking.ts`
- Modify: `packages/backend/src/services/__tests__/ranking.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/backend/src/services/__tests__/ranking.test.ts`, add a new describe block after the `heuristicPreSort` block:

```typescript
describe("diversityCap", () => {
  it("caps source marketplace results to MAX_SOURCE_MARKETPLACE_RESULTS", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({ id: `a${i}`, marketplace: "Amazon", productUrl: `https://amazon.com/p${i}` }),
    );
    results.push(
      makeResult({ id: "b0", marketplace: "eBay", productUrl: "https://ebay.com/p0" }),
      makeResult({ id: "b1", marketplace: "eBay", productUrl: "https://ebay.com/p1" }),
    );
    const capped = diversityCap(results, 10, "Amazon");
    const amazonCount = capped.filter((r) => r.marketplace === "Amazon").length;
    expect(amazonCount).toBeLessThanOrEqual(2);
  });

  it("fills remaining slots with non-source marketplace results", () => {
    const results = [
      makeResult({ id: "a0", marketplace: "Amazon", productUrl: "https://amazon.com/p0" }),
      makeResult({ id: "a1", marketplace: "Amazon", productUrl: "https://amazon.com/p1" }),
      makeResult({ id: "a2", marketplace: "Amazon", productUrl: "https://amazon.com/p2" }),
      makeResult({ id: "b0", marketplace: "eBay", productUrl: "https://ebay.com/p0" }),
      makeResult({ id: "b1", marketplace: "eBay", productUrl: "https://ebay.com/p1" }),
      makeResult({ id: "c0", marketplace: "AliExpress", productUrl: "https://aliexpress.com/p0" }),
    ];
    const capped = diversityCap(results, 5, "Amazon");
    const amazonCount = capped.filter((r) => r.marketplace === "Amazon").length;
    expect(amazonCount).toBeLessThanOrEqual(2);
    expect(capped.length).toBe(5);
  });

  it("enforces global cap across regional marketplace variants", () => {
    // "Amazon" and "Amazon UK" should both count toward the source cap
    const results = [
      makeResult({ id: "a0", marketplace: "Amazon", productUrl: "https://amazon.com/p0" }),
      makeResult({ id: "a1", marketplace: "Amazon", productUrl: "https://amazon.com/p1" }),
      makeResult({ id: "a2", marketplace: "Amazon UK", productUrl: "https://amazon.co.uk/p0" }),
      makeResult({ id: "a3", marketplace: "Amazon UK", productUrl: "https://amazon.co.uk/p1" }),
      makeResult({ id: "b0", marketplace: "eBay", productUrl: "https://ebay.com/p0" }),
      makeResult({ id: "b1", marketplace: "eBay", productUrl: "https://ebay.com/p1" }),
    ];
    const capped = diversityCap(results, 5, "Amazon");
    const amazonTotal = capped.filter((r) =>
      r.marketplace === "Amazon" || r.marketplace === "Amazon UK",
    ).length;
    expect(amazonTotal).toBeLessThanOrEqual(2);
  });

  it("applies normal cap when sourceMarketplace is null", () => {
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({ id: `a${i}`, marketplace: "Amazon", productUrl: `https://amazon.com/p${i}` }),
    );
    const capped = diversityCap(results, 5, null);
    // Without source filtering, all Amazon results can fill slots
    expect(capped.length).toBe(5);
    expect(capped.every((r) => r.marketplace === "Amazon")).toBe(true);
  });
});
```

Also update the import at the top of the test file (line 3) to include `diversityCap`:

```typescript
import { mergeAndDedup, applyRanking, buildFallbackScores, heuristicPreSort, diversityCap } from "../ranking.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/ranking.test.ts`
Expected: FAIL — `diversityCap` doesn't accept 3rd argument

- [ ] **Step 3: Update `diversityCap` to accept sourceMarketplace**

In `packages/backend/src/services/ranking.ts`, update the import (line 2) to add `MAX_SOURCE_MARKETPLACE_RESULTS`:

```typescript
import { CONFIDENCE_THRESHOLDS, MIN_CONFIDENCE_SCORE, MIN_DISPLAY_RESULTS, SOURCE_MARKETPLACE_PENALTY, MAX_SOURCE_MARKETPLACE_RESULTS } from "@shopping-assistant/shared";
```

Replace the entire `diversityCap` function (lines 237-276):

```typescript
export function diversityCap(
  preSorted: SearchResult[],
  limit: number,
  sourceMarketplace: string | null = null,
): SearchResult[] {
  const sourceBase = sourceMarketplace ? baseMarketplace(sourceMarketplace) : null;

  // Group by marketplace, preserving pre-sort order within each group
  const byMarketplace = new Map<string, SearchResult[]>();
  for (const r of preSorted) {
    const mp = r.marketplace;
    if (!byMarketplace.has(mp)) byMarketplace.set(mp, []);
    byMarketplace.get(mp)!.push(r);
  }

  const selected: SearchResult[] = [];
  const selectedIds = new Set<string>();

  // First pass: reserve top results from each marketplace
  // Track source marketplace count globally across regional variants (e.g., "Amazon" + "Amazon UK")
  const marketplaceCount = byMarketplace.size;
  const perMarketplace = Math.min(
    MIN_SLOTS_PER_MARKETPLACE,
    Math.floor(limit / marketplaceCount),
  );

  let sourceCount = 0;
  for (const [mp, items] of byMarketplace) {
    const isSource = sourceBase !== null && baseMarketplace(mp) === sourceBase;
    const groupCap = isSource
      ? Math.max(0, Math.min(perMarketplace, MAX_SOURCE_MARKETPLACE_RESULTS - sourceCount))
      : perMarketplace;
    for (const r of items.slice(0, groupCap)) {
      selected.push(r);
      selectedIds.add(r.id);
      if (isSource) sourceCount++;
    }
  }

  // Second pass: fill remaining slots, preferring non-source marketplaces
  for (const r of preSorted) {
    if (selected.length >= limit) break;
    if (selectedIds.has(r.id)) continue;
    const isSource = sourceBase !== null && baseMarketplace(r.marketplace) === sourceBase;
    if (isSource) continue; // skip source marketplace in overflow
    selected.push(r);
    selectedIds.add(r.id);
  }

  // Third pass: if still under limit, allow source marketplace overflow
  for (const r of preSorted) {
    if (selected.length >= limit) break;
    if (selectedIds.has(r.id)) continue;
    selected.push(r);
    selectedIds.add(r.id);
  }

  return selected;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/ranking.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/ranking.ts packages/backend/src/services/__tests__/ranking.test.ts
git commit -m "feat: source-aware diversity cap limits same-platform results"
```

---

### Task 5: Wire source marketplace through search route + filter source URL

**Files:**
- Modify: `packages/backend/src/routes/search.ts`

- [ ] **Step 1: Add import for `extractMarketplace`**

In `packages/backend/src/routes/search.ts`, add to the imports (after line 18):

```typescript
import { extractMarketplace } from "../utils/marketplace.js";
```

- [ ] **Step 2: Extract source marketplace after validation**

After the `body.sourceUrl` validation (line 50) and before `requestId` (line 52), add:

```typescript
  const sourceMarketplace = extractMarketplace(body.sourceUrl);
```

Add a log line after the existing source URL log (after line 57):

```typescript
  console.log(`[search:${requestId}] Source marketplace: ${sourceMarketplace}`);
```

- [ ] **Step 3: Filter source URL from results and pass sourceMarketplace to ranking**

Replace the Phase 3 block (lines 237-242):

```typescript
  // ── Phase 3: merge → dedup → filter source URL → heuristicPreSort → cap ──

  const allResults = [...braveOutcome.results, ...aliExpressOutcome.results];
  const deduped = mergeAndDedup(allResults);

  // Filter out the exact source product URL — users don't want to see the item they're already viewing.
  // Intentionally strips ALL query params (not just tracking params like normalizeUrl does) for
  // aggressive matching — false positives are acceptable since users never want their own product.
  const sourceNormalized = body.sourceUrl.split("?")[0].toLowerCase().replace(/\/$/, "");
  const filtered = deduped.filter((r) => {
    const normalized = r.productUrl.split("?")[0].toLowerCase().replace(/\/$/, "");
    return normalized !== sourceNormalized;
  });

  const preSorted = heuristicPreSort(filtered, identification, body.price, sourceMarketplace);
  const capped = diversityCap(preSorted, MAX_RESULTS_FOR_RANKING, sourceMarketplace);
```

- [ ] **Step 4: Pass sourceMarketplace to `buildFallbackScores`**

Update the buildFallbackScores call (line 309):

```typescript
  const textScores = buildFallbackScores(capped, identification, sourceMarketplace);
```

- [ ] **Step 5: Run typecheck**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routes/search.ts
git commit -m "feat: wire source marketplace through search pipeline"
```

---

## Chunk 2: Price Extraction Fix

### Task 6: Frequency-based regex price extraction

**Files:**
- Modify: `packages/backend/src/services/price-extractor.ts`
- Modify: `packages/backend/src/services/__tests__/price-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/backend/src/services/__tests__/price-extractor.test.ts`, add to the `regex fallback` describe block (after line 124):

```typescript
    it("picks the most frequent price when multiple candidates exist", () => {
      // Simulate Amazon-like HTML where $29.99 appears 3 times and $10 appears once
      const html = `<html><body>
        <span class="price">$10.00</span>
        <span class="a-price">$29.99</span>
        <span class="buybox-price">$29.99</span>
        <span class="our-price">$29.99</span>
      </body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 29.99, currency: "USD" });
    });

    it("breaks frequency ties by preferring the higher price", () => {
      // Both appear once — prefer higher (more likely the real product price vs a fee)
      const html = `<html><body>
        <span>$5.99</span>
        <span>$24.99</span>
      </body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 24.99, currency: "USD" });
    });

    it("still works with a single price match", () => {
      const html = `<html><body><span class="price">$34.99</span></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 34.99, currency: "USD" });
    });

    it("filters prices below MIN_REGEX_PRICE from frequency count", () => {
      // $1, $2 should be ignored; $19.99 should win
      const html = `<html><body>
        <span>$1</span><span>$1</span><span>$2</span><span>$2</span>
        <span>$19.99</span>
      </body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 19.99, currency: "USD" });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/price-extractor.test.ts`
Expected: FAIL — first test expects $29.99 but gets $10.00

- [ ] **Step 3: Implement frequency-based regex extraction**

In `packages/backend/src/services/price-extractor.ts`, replace the `extractFromRegex` function (lines 185-215):

```typescript
function extractFromRegex(
  html: string,
): { price: number | null; currency: string | null } {
  // Strip script/style tags to avoid matching JS variables
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  // Also strip common non-price contexts
  const cleaned = visible
    .replace(/save\s*\$\s*[\d,.]+/gi, "")
    .replace(/off\s*\$\s*[\d,.]+/gi, "")
    .replace(/coupon\s*\$\s*[\d,.]+/gi, "")
    .replace(/\$\s*[\d,.]+\s*off/gi, "")
    .replace(/\$\s*[\d,.]+\s*coupon/gi, "")
    .replace(/shipping\s*\$\s*[\d,.]+/gi, "");

  for (const { re, currency } of PRICE_PATTERNS) {
    const allMatches = [...cleaned.matchAll(new RegExp(re.source, "g"))];

    // Collect all valid prices and count frequency
    const priceCounts = new Map<number, number>();
    for (const match of allMatches) {
      const price = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(price) && price >= MIN_REGEX_PRICE) {
        priceCounts.set(price, (priceCounts.get(price) ?? 0) + 1);
      }
    }

    if (priceCounts.size === 0) continue;

    // Pick the most frequent price; break ties by preferring higher price
    let bestPrice = 0;
    let bestCount = 0;
    for (const [price, count] of priceCounts) {
      if (count > bestCount || (count === bestCount && price > bestPrice)) {
        bestPrice = price;
        bestCount = count;
      }
    }

    console.log(`[price-extract] Regex: matched ${currency}${bestPrice} (${bestCount}x from ${allMatches.length} candidates)`);
    return { price: bestPrice, currency };
  }

  return { price: null, currency: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/price-extractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/services/price-extractor.ts packages/backend/src/services/__tests__/price-extractor.test.ts
git commit -m "fix: use frequency-based regex for price extraction"
```

---

## Chunk 3: Embedding Resilience

### Task 7: Validate image data before embedding API call

**Files:**
- Modify: `packages/backend/src/services/embedding.ts`
- Modify: `packages/backend/src/services/__tests__/embedding.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/backend/src/services/__tests__/embedding.test.ts`, add to the `embedImage` describe block:

```typescript
  it("rejects images with empty data", async () => {
    await expect(embedImage({ data: "", mimeType: "image/png" })).rejects.toThrow("empty");
  });

  it("rejects images with unsupported MIME type", async () => {
    await expect(embedImage({ data: "abc", mimeType: "text/html" })).rejects.toThrow("Unsupported");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/embedding.test.ts`
Expected: FAIL — embedImage doesn't validate inputs

- [ ] **Step 3: Add validation to `embedImage`**

In `packages/backend/src/services/embedding.ts`, replace the `embedImage` function (lines 57-67):

```typescript
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/**
 * Embed a single image using gemini-embedding-2-preview.
 * Throws on invalid input (empty data, unsupported MIME type).
 * Returns the embedding vector, or an empty array if the API returns no embeddings.
 */
export async function embedImage(image: FetchedImage): Promise<number[]> {
  if (!image.data || image.data.length === 0) {
    throw new Error("Cannot embed image: empty data");
  }
  if (!SUPPORTED_IMAGE_MIMES.has(image.mimeType)) {
    throw new Error(`Unsupported image MIME type for embedding: ${image.mimeType}`);
  }

  const response = await ai.models.embedContent({
    model: embeddingModel,
    contents: [{ inlineData: { mimeType: image.mimeType, data: image.data } }],
    config: {
      outputDimensionality: EMBEDDING_DIMS,
    },
  });

  return response.embeddings?.[0]?.values ?? [];
}
```

- [ ] **Step 4: Add diagnostic logging to `computeVisualSimilarityScores`**

In the same file, update the original image embedding error log (line 122) to include diagnostics:

```typescript
  if (originalResult.status === "rejected") {
    console.warn(
      `[visual-ranking] Failed to embed original image (${originalImage.mimeType}, ${originalImage.data.length} chars):`,
      originalResult.reason,
    );
    return {};
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run packages/backend/src/services/__tests__/embedding.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm vitest run`
Expected: All tests PASS

- [ ] **Step 7: Run typecheck**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm typecheck`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add packages/backend/src/services/embedding.ts packages/backend/src/services/__tests__/embedding.test.ts
git commit -m "fix: validate image data before embedding API call"
```

---

## Implementation Notes

### Impact Analysis

| Issue | Fix | Expected Improvement |
|-------|-----|---------------------|
| eBay search: 5/11 from eBay | Source penalty + cap at 2 | Max 2 eBay results, others from AliExpress/Temu/DHgate |
| Amazon search: 7/15 from Amazon | Source penalty + cap at 2 | Max 2 Amazon results, more diverse marketplace mix |
| Amazon $10 wrong price | Frequency-based regex | $29.99 (appears 3+ times) selected over $10 (1 time) |
| Source URL appearing in results | URL filtering | Exact source product removed from results |
| Embedding INVALID_ARGUMENT | Pre-validation | Bad images rejected before API call, clearer error logs |

### What This Does NOT Fix (Out of Scope)

- **Missing images from Brave web results**: Brave's API simply doesn't return thumbnails for all results. Fixing this would require additional HTTP requests to fetch page metadata (bot detection risk).
- **Price fallback limit of 5**: Increasing this means more HTTP requests per search (bot detection risk). The frequency-based regex fix should improve the quality of prices we DO extract.
- **Non-product URLs in results** (category pages, review pages): Could be addressed in a follow-up by applying the existing `isNonProductUrl` filter earlier in the pipeline, but this is a separate concern from the bugs reported.
