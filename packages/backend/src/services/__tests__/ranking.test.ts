import { describe, it, expect } from "vitest";
import type { SearchResult, ProductIdentification } from "@shopping-assistant/shared";
import { mergeAndDedup, applyRanking, buildFallbackScores, heuristicPreSort } from "../ranking.js";

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "test_0",
    source: "brave",
    title: "Test Product",
    price: null,
    currency: null,
    imageUrl: null,
    productUrl: "https://amazon.com/test-product",
    marketplace: "Amazon",
    snippet: null,
    structuredData: null,
    raw: {},
    ...overrides,
  };
}

const baseIdentification: ProductIdentification = {
  category: "Electronics",
  description: "Wireless Bluetooth Headphones",
  brand: "Sony",
  attributes: { color: "black", material: null, style: null, size: null },
  searchQueries: ["sony wireless headphones", "bluetooth headphones"],
  estimatedPriceRange: null,
};

describe("mergeAndDedup", () => {
  it("returns empty array for empty input", () => {
    expect(mergeAndDedup([])).toEqual([]);
  });

  it("passes through unique results", () => {
    const results = [
      makeResult({ id: "a", title: "Sony WH-1000XM5", productUrl: "https://amazon.com/a" }),
      makeResult({ id: "b", title: "Bose QuietComfort 45", productUrl: "https://ebay.com/b" }),
    ];
    expect(mergeAndDedup(results)).toHaveLength(2);
  });

  it("deduplicates by normalized URL", () => {
    const results = [
      makeResult({ id: "a", productUrl: "https://amazon.com/product?utm_source=google" }),
      makeResult({ id: "b", productUrl: "https://amazon.com/product?utm_source=facebook" }),
    ];
    expect(mergeAndDedup(results)).toHaveLength(1);
  });

  it("keeps the richer result on URL dedup", () => {
    const results = [
      makeResult({ id: "a", productUrl: "https://amazon.com/product", price: null, imageUrl: null }),
      makeResult({ id: "b", productUrl: "https://amazon.com/product", price: 29.99, imageUrl: "https://img.com/x.jpg" }),
    ];
    const deduped = mergeAndDedup(results);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("b");
  });

  it("deduplicates by title similarity", () => {
    // These titles have very high Jaccard similarity (identical words except one extra)
    const results = [
      makeResult({ id: "a", title: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones", productUrl: "https://amazon.com/a" }),
      makeResult({ id: "b", title: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones", productUrl: "https://ebay.com/b" }),
    ];
    const deduped = mergeAndDedup(results);
    expect(deduped).toHaveLength(1);
  });

  it("keeps results with different titles", () => {
    const results = [
      makeResult({ id: "a", title: "Sony WH-1000XM5", productUrl: "https://amazon.com/a" }),
      makeResult({ id: "b", title: "Bose QuietComfort 45", productUrl: "https://amazon.com/b" }),
    ];
    expect(mergeAndDedup(results)).toHaveLength(2);
  });

  it("strips tracking params for URL dedup", () => {
    const results = [
      makeResult({ id: "a", productUrl: "https://amazon.com/dp/B09?ref=sr_1&gclid=abc" }),
      makeResult({ id: "b", productUrl: "https://amazon.com/dp/B09?fbclid=xyz" }),
    ];
    expect(mergeAndDedup(results)).toHaveLength(1);
  });
});

describe("applyRanking", () => {
  it("returns empty array for empty results", () => {
    expect(applyRanking([], {}, null)).toEqual([]);
  });

  it("filters results below MIN_CONFIDENCE_SCORE", () => {
    const results = [
      makeResult({ id: "a" }),
      makeResult({ id: "b" }),
    ];
    const scores = { a: 0.8, b: 0.05 };
    const ranked = applyRanking(results, scores, null);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].result.id).toBe("a");
  });

  it("sorts by confidence score descending", () => {
    const results = [
      makeResult({ id: "a" }),
      makeResult({ id: "b" }),
      makeResult({ id: "c" }),
    ];
    const scores = { a: 0.5, b: 0.9, c: 0.7 };
    const ranked = applyRanking(results, scores, null);
    expect(ranked.map((r) => r.result.id)).toEqual(["b", "c", "a"]);
  });

  it("assigns sequential ranks", () => {
    const results = [makeResult({ id: "a" }), makeResult({ id: "b" })];
    const scores = { a: 0.8, b: 0.6 };
    const ranked = applyRanking(results, scores, null);
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(2);
  });

  it("computes price delta correctly", () => {
    const results = [makeResult({ id: "a", price: 20 })];
    const scores = { a: 0.8 };
    const ranked = applyRanking(results, scores, 30);
    expect(ranked[0].priceDelta).toBe(-10);
    expect(ranked[0].savingsPercent).toBeCloseTo(-33.33, 1);
  });

  it("returns null price delta when original price is null", () => {
    const results = [makeResult({ id: "a", price: 20 })];
    const scores = { a: 0.8 };
    const ranked = applyRanking(results, scores, null);
    expect(ranked[0].priceDelta).toBeNull();
    expect(ranked[0].savingsPercent).toBeNull();
  });

  it("sets priceAvailable to true when result has price", () => {
    const results = [makeResult({ id: "a", price: 29.99 })];
    const scores = { a: 0.8 };
    const ranked = applyRanking(results, scores, null);
    expect(ranked[0].priceAvailable).toBe(true);
  });

  it("sets priceAvailable to false when result has no price", () => {
    const results = [makeResult({ id: "a", price: null })];
    const scores = { a: 0.8 };
    const ranked = applyRanking(results, scores, null);
    expect(ranked[0].priceAvailable).toBe(false);
  });

  it("maps scores to confidence levels", () => {
    const results = [
      makeResult({ id: "a" }),
      makeResult({ id: "b" }),
      makeResult({ id: "c" }),
    ];
    const scores = { a: 0.85, b: 0.55, c: 0.2 };
    const ranked = applyRanking(results, scores, null);
    expect(ranked.find((r) => r.result.id === "a")!.confidence).toBe("high");
    expect(ranked.find((r) => r.result.id === "b")!.confidence).toBe("medium");
    expect(ranked.find((r) => r.result.id === "c")!.confidence).toBe("low");
  });
});

describe("buildFallbackScores", () => {
  it("returns scores for all results", () => {
    const results = [
      makeResult({ id: "a", title: "Sony Wireless Headphones" }),
      makeResult({ id: "b", title: "Random Kitchen Gadget" }),
    ];
    const scores = buildFallbackScores(results, baseIdentification);
    expect(scores).toHaveProperty("a");
    expect(scores).toHaveProperty("b");
  });

  it("scores brand-matching results higher", () => {
    const results = [
      makeResult({ id: "a", title: "Sony WH-1000XM5 Headphones" }),
      makeResult({ id: "b", title: "Generic Bluetooth Headphones" }),
    ];
    const scores = buildFallbackScores(results, baseIdentification);
    expect(scores.a).toBeGreaterThan(scores.b);
  });

  it("clamps scores between 0 and 0.95", () => {
    const results = [makeResult({ id: "a", title: "Sony Wireless Bluetooth Headphones Electronics" })];
    const scores = buildFallbackScores(results, baseIdentification);
    expect(scores.a).toBeGreaterThanOrEqual(0);
    expect(scores.a).toBeLessThanOrEqual(0.95);
  });

  it("boosts results with price and image", () => {
    const results = [
      makeResult({ id: "a", title: "Headphones", price: 29.99, imageUrl: "https://img.com/x.jpg" }),
      makeResult({ id: "b", title: "Headphones", price: null, imageUrl: null }),
    ];
    const scores = buildFallbackScores(results, baseIdentification);
    expect(scores.a).toBeGreaterThan(scores.b);
  });
});

describe("heuristicPreSort", () => {
  it("returns empty array for empty input", () => {
    expect(heuristicPreSort([], baseIdentification, null)).toEqual([]);
  });

  it("ranks brand-matching results higher", () => {
    const results = [
      makeResult({ id: "a", title: "Generic Bluetooth Headphones" }),
      makeResult({ id: "b", title: "Sony WH-1000XM5 Wireless Headphones" }),
    ];
    const sorted = heuristicPreSort(results, baseIdentification, null);
    expect(sorted[0].id).toBe("b");
  });

  it("prefers results with price and image", () => {
    const results = [
      makeResult({ id: "a", title: "Wireless Headphones", price: null, imageUrl: null }),
      makeResult({ id: "b", title: "Wireless Headphones", price: 199, imageUrl: "https://img.com/x.jpg" }),
    ];
    const sorted = heuristicPreSort(results, baseIdentification, null);
    expect(sorted[0].id).toBe("b");
  });

  it("boosts results with price close to original", () => {
    const results = [
      makeResult({ id: "a", title: "Sony Wireless Headphones", price: 999 }),
      makeResult({ id: "b", title: "Sony Wireless Headphones", price: 280 }),
    ];
    const sorted = heuristicPreSort(results, baseIdentification, 298);
    expect(sorted[0].id).toBe("b");
  });

  it("boosts known marketplaces", () => {
    const results = [
      makeResult({ id: "a", title: "Sony Headphones", marketplace: "Unknown Shop" }),
      makeResult({ id: "b", title: "Sony Headphones", marketplace: "Amazon" }),
    ];
    const sorted = heuristicPreSort(results, baseIdentification, null);
    expect(sorted[0].id).toBe("b");
  });
});

