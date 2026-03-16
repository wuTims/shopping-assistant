import type { SearchResponse } from "@shopping-assistant/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const identifyProductMock = vi.fn();
const generateImageSearchQueriesMock = vi.fn();
const searchProductsMock = vi.fn();
const searchImagesMock = vi.fn();
const searchAliExpressSplitMock = vi.fn();
const fillMissingPricesMock = vi.fn();
const generateMarketplaceQueriesMock = vi.fn();
const extractMarketplaceMock = vi.fn();
const computeVisualSimilarityScoresMock = vi.fn();

vi.mock("../../services/gemini.js", () => ({
  identifyProduct: identifyProductMock,
  generateImageSearchQueries: generateImageSearchQueriesMock,
  sanitizeImageSearchQueries: (queries: string[]) => ({
    acceptedQueries: queries,
    rejectedQueries: [],
  }),
}));

vi.mock("../../services/brave.js", () => ({
  searchProducts: searchProductsMock,
  searchImages: searchImagesMock,
}));

vi.mock("../../services/aliexpress.js", () => ({
  searchAliExpressSplit: searchAliExpressSplitMock,
}));

vi.mock("../../services/price-fallback.js", () => ({
  fillMissingPrices: fillMissingPricesMock,
}));

vi.mock("../../utils/marketplace-queries.js", () => ({
  generateMarketplaceQueries: generateMarketplaceQueriesMock,
}));

vi.mock("../../utils/marketplace.js", () => ({
  extractMarketplace: extractMarketplaceMock,
}));

vi.mock("../../services/embedding.js", () => ({
  computeVisualSimilarityScores: computeVisualSimilarityScoresMock,
  blendScores: (textScores: Record<string, number>) => textScores,
}));

function providerOutcome(results: Array<Record<string, unknown>>, overrides: Partial<Record<string, number | string>> = {}) {
  return {
    results,
    status: "ok" as const,
    totalQueries: 1,
    successfulQueries: 1,
    failedQueries: 0,
    timedOutQueries: 0,
    ...overrides,
  };
}

function splitOutcome(textResults: Array<Record<string, unknown>>, imageResults: Array<Record<string, unknown>>) {
  return {
    textOutcome: providerOutcome(textResults, {
      totalQueries: textResults.length > 0 ? 1 : 0,
      successfulQueries: textResults.length > 0 ? 1 : 0,
    }),
    imageOutcome: providerOutcome(imageResults, {
      totalQueries: imageResults.length > 0 ? 1 : 0,
      successfulQueries: imageResults.length > 0 ? 1 : 0,
    }),
    combinedOutcome: providerOutcome([...textResults, ...imageResults], {
      totalQueries: (textResults.length > 0 ? 1 : 0) + (imageResults.length > 0 ? 1 : 0),
      successfulQueries: (textResults.length > 0 ? 1 : 0) + (imageResults.length > 0 ? 1 : 0),
    }),
  };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    imageUrl: null,
    imageBase64: "ZmFrZQ==",
    title: "Blue striped midi dress",
    price: 99.99,
    currency: "USD",
    sourceUrl: "https://source.example.com/product",
    identification: {
      category: "Dress",
      description: "Blue striped midi dress",
      brand: null,
      attributes: {
        color: "blue",
        material: null,
        style: null,
        size: null,
      },
      searchQueries: ["blue striped midi dress"],
      estimatedPriceRange: null,
    },
    ...overrides,
  };
}

describe("/search route", () => {
  beforeEach(() => {
    vi.resetModules();
    identifyProductMock.mockReset();
    generateImageSearchQueriesMock.mockReset();
    searchProductsMock.mockReset();
    searchImagesMock.mockReset();
    searchAliExpressSplitMock.mockReset();
    fillMissingPricesMock.mockReset();
    generateMarketplaceQueriesMock.mockReset();
    extractMarketplaceMock.mockReset();
    computeVisualSimilarityScoresMock.mockReset();

    extractMarketplaceMock.mockReturnValue("Amazon");
    generateMarketplaceQueriesMock.mockReturnValue([]);
    fillMissingPricesMock.mockResolvedValue(new Map());
    computeVisualSimilarityScoresMock.mockResolvedValue({});
    searchAliExpressSplitMock.mockResolvedValue(splitOutcome([], []));
    searchProductsMock.mockResolvedValue(providerOutcome([]));
    searchImagesMock.mockResolvedValue(providerOutcome([]));
    generateImageSearchQueriesMock.mockResolvedValue([
      "buy blue striped midi dress",
      "blue striped midi dress price",
    ]);
  });

  it("returns lane diagnostics and promotes cross-lane duplicates to hybrid", async () => {
    searchProductsMock.mockImplementation(async (queries: string[]) => {
      if (queries[0] === "Blue striped midi dress") {
        return providerOutcome([
          {
            id: "txt_1",
            source: "brave",
            title: "Blue striped midi dress",
            price: 99.99,
            currency: "USD",
            imageUrl: "https://img.example.com/dress.jpg",
            productUrl: "https://shop.example.com/products/blue-striped-midi-dress",
            marketplace: "Shop Example",
            snippet: null,
            structuredData: null,
            raw: {},
          },
        ]);
      }
      return providerOutcome([]);
    });

    searchImagesMock.mockImplementation(async (queries: string[]) =>
      providerOutcome([
        {
          id: `img_${queries[0]}`,
          source: "brave",
          title: "Blue striped midi dress",
          price: 89.99,
          currency: "USD",
          imageUrl: "https://img.example.com/dress.jpg",
          productUrl: "https://shop.example.com/products/blue-striped-midi-dress",
          marketplace: "Shop Example",
          snippet: null,
          structuredData: null,
          raw: {},
        },
      ]),
    );

    const { searchRoute } = await import("../search.js");
    const response = await searchRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest()),
    });

    expect(response.status).toBe(200);

    const payload = await response.json() as SearchResponse;
    expect(payload.searchMeta.laneDiagnostics).toEqual({
      textResultCount: 0,
      imageResultCount: 0,
      hybridResultCount: 1,
    });
    expect(payload.results[0].result.retrievalLane).toBe("hybrid");
    expect(payload.results[0].result.matchedQueries).toEqual([
      { query: "Blue striped midi dress", lane: "text", provider: "brave" },
      { query: "buy blue striped midi dress", lane: "image", provider: "brave" },
      { query: "blue striped midi dress price", lane: "image", provider: "brave" },
    ]);
  });

  it("searches brave web with Gemini image queries and keeps image-lane provenance", async () => {
    generateImageSearchQueriesMock.mockResolvedValue(["visual dress dupe"]);
    searchProductsMock.mockImplementation(async (queries: string[]) => {
      if (queries[0] === "blue striped midi dress") {
        return providerOutcome([]);
      }
      if (queries[0] === "visual dress dupe") {
        return providerOutcome([
          {
            id: "img_web_1",
            source: "brave",
            title: "Blue striped midi dress alt listing",
            price: 95.5,
            currency: "USD",
            imageUrl: "https://img.example.com/dress-alt.jpg",
            productUrl: "https://shop.example.com/products/blue-striped-midi-dress-alt",
            marketplace: "Shop Example",
            snippet: null,
            structuredData: null,
            raw: {},
          },
        ]);
      }
      return providerOutcome([]);
    });

    const { searchRoute } = await import("../search.js");
    const response = await searchRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest({ title: null })),
    });

    expect(response.status).toBe(200);

    const payload = await response.json() as SearchResponse;
    expect(searchProductsMock).toHaveBeenCalledWith(["visual dress dupe"]);
    expect(payload.searchMeta.laneDiagnostics).toEqual({
      textResultCount: 0,
      imageResultCount: 1,
      hybridResultCount: 0,
    });
    expect(payload.results[0].result.retrievalLane).toBe("image");
    expect(payload.results[0].result.matchedQueries).toEqual([
      { query: "visual dress dupe", lane: "image", provider: "brave" },
    ]);
  });

  it("splits AliExpress text and image results into distinct lanes before dedupe", async () => {
    searchAliExpressSplitMock.mockImplementation(async (queries: string[], image: { data: string } | null) => {
      if (queries.length === 1 && queries[0] === "blue striped midi dress" && image === null) {
        return splitOutcome([
          {
            id: "ali_text_1",
            source: "aliexpress",
            title: "Blue striped midi dress",
            price: null,
            currency: "USD",
            imageUrl: null,
            productUrl: "https://www.aliexpress.com/item/123.html",
            marketplace: "AliExpress",
            snippet: null,
            structuredData: null,
            raw: {},
          },
        ], []);
      }

      if (queries.length === 0 && image) {
        return splitOutcome([], [
          {
            id: "ali_img_1",
            source: "aliexpress",
            title: "Blue striped midi dress",
            price: 88.88,
            currency: "USD",
            imageUrl: "https://img.alicdn.com/dress.jpg",
            productUrl: "https://www.aliexpress.com/item/123.html",
            marketplace: "AliExpress",
            snippet: null,
            structuredData: null,
            raw: {},
          },
        ]);
      }

      return splitOutcome([], []);
    });

    const { searchRoute } = await import("../search.js");
    const response = await searchRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest({ title: null })),
    });

    expect(response.status).toBe(200);

    const payload = await response.json() as SearchResponse;
    expect(payload.searchMeta.laneDiagnostics).toEqual({
      textResultCount: 0,
      imageResultCount: 0,
      hybridResultCount: 1,
    });
    expect(payload.results[0].result.retrievalLane).toBe("hybrid");
    expect(payload.results[0].result.matchedQueries).toHaveLength(2);
    expect(payload.results[0].result.matchedQueries).toEqual(expect.arrayContaining([
      { query: "blue striped midi dress", lane: "text", provider: "aliexpress" },
      { query: "[image-search]", lane: "image", provider: "aliexpress" },
    ]));
  });
  it("continues when Gemini image-query generation fails", async () => {
    generateImageSearchQueriesMock.mockRejectedValue(new Error("Gemini down"));
    searchProductsMock.mockResolvedValue(providerOutcome([]));
    searchImagesMock.mockResolvedValue(providerOutcome([]));

    const { searchRoute } = await import("../search.js");
    const response = await searchRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest()),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as SearchResponse;
    expect(payload.searchMeta.laneDiagnostics).toEqual({
      textResultCount: 0,
      imageResultCount: 0,
      hybridResultCount: 0,
    });
  });

  it("keeps image-web results when Brave image search fails", async () => {
    generateImageSearchQueriesMock.mockResolvedValue(["visual dress dupe"]);
    searchProductsMock.mockImplementation(async (queries: string[]) => {
      if (queries[0] === "blue striped midi dress") return providerOutcome([]);
      if (queries[0] === "visual dress dupe") {
        return providerOutcome([
          {
            id: "img_web_only",
            source: "brave",
            title: "Blue striped midi dress alt listing",
            price: 95.5,
            currency: "USD",
            imageUrl: "https://img.example.com/dress-alt.jpg",
            productUrl: "https://shop.example.com/products/blue-striped-midi-dress-alt",
            marketplace: "Shop Example",
            snippet: null,
            structuredData: null,
            raw: {},
          },
        ]);
      }
      return providerOutcome([]);
    });
    searchImagesMock.mockRejectedValue(new Error("image search down"));

    const { searchRoute } = await import("../search.js");
    const response = await searchRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest({ title: null })),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as SearchResponse;
    expect(payload.searchMeta.laneDiagnostics).toEqual({
      textResultCount: 0,
      imageResultCount: 1,
      hybridResultCount: 0,
    });
    expect(payload.results[0].result.matchedQueries).toEqual([
      { query: "visual dress dupe", lane: "image", provider: "brave" },
    ]);
  });

  it("keeps image-search results when Brave image-query web search fails", async () => {
    generateImageSearchQueriesMock.mockResolvedValue(["visual dress dupe"]);
    searchProductsMock.mockImplementation(async (queries: string[]) => {
      if (queries[0] === "blue striped midi dress") return providerOutcome([]);
      if (queries[0] === "visual dress dupe") throw new Error("web search down");
      return providerOutcome([]);
    });
    searchImagesMock.mockResolvedValue(providerOutcome([
      {
        id: "img_only",
        source: "brave",
        title: "Blue striped midi dress alt image listing",
        price: 94.0,
        currency: "USD",
        imageUrl: "https://img.example.com/dress-alt.jpg",
        productUrl: "https://shop.example.com/products/blue-striped-midi-dress-alt",
        marketplace: "Shop Example",
        snippet: null,
        structuredData: null,
        raw: {},
      },
    ]));

    const { searchRoute } = await import("../search.js");
    const response = await searchRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest({ title: null })),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as SearchResponse;
    expect(payload.searchMeta.laneDiagnostics).toEqual({
      textResultCount: 0,
      imageResultCount: 1,
      hybridResultCount: 0,
    });
    expect(payload.results[0].result.matchedQueries).toEqual([
      { query: "visual dress dupe", lane: "image", provider: "brave" },
    ]);
  });

  it("keeps AliExpress image results when AliExpress text search fails", async () => {
    searchAliExpressSplitMock.mockImplementation(async (queries: string[], image: { data: string } | null) => {
      if (queries.length === 1 && queries[0] === "blue striped midi dress") {
        throw new Error("text search down");
      }
      if (queries.length === 0 && image) {
        return splitOutcome([], [
          {
            id: "ali_img_only",
            source: "aliexpress",
            title: "Blue striped midi dress",
            price: 88.88,
            currency: "USD",
            imageUrl: "https://img.alicdn.com/dress.jpg",
            productUrl: "https://www.aliexpress.com/item/123.html",
            marketplace: "AliExpress",
            snippet: null,
            structuredData: null,
            raw: {},
          },
        ]);
      }
      return splitOutcome([], []);
    });

    const { searchRoute } = await import("../search.js");
    const response = await searchRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest({ title: null })),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as SearchResponse;
    expect(payload.searchMeta.laneDiagnostics).toEqual({
      textResultCount: 0,
      imageResultCount: 1,
      hybridResultCount: 0,
    });
    expect(payload.results[0].result.matchedQueries).toEqual([
      { query: "[image-search]", lane: "image", provider: "aliexpress" },
    ]);
  });

  it("keeps AliExpress text results when AliExpress image search fails", async () => {
    searchAliExpressSplitMock.mockImplementation(async (queries: string[], image: { data: string } | null) => {
      if (queries.length === 1 && queries[0] === "blue striped midi dress") {
        return splitOutcome([
          {
            id: "ali_text_only",
            source: "aliexpress",
            title: "Blue striped midi dress",
            price: 92.12,
            currency: "USD",
            imageUrl: null,
            productUrl: "https://www.aliexpress.com/item/123.html",
            marketplace: "AliExpress",
            snippet: null,
            structuredData: null,
            raw: {},
          },
        ], []);
      }
      if (queries.length === 0 && image) {
        throw new Error("image search down");
      }
      return splitOutcome([], []);
    });

    const { searchRoute } = await import("../search.js");
    const response = await searchRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(baseRequest({ title: null })),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as SearchResponse;
    expect(payload.searchMeta.laneDiagnostics).toEqual({
      textResultCount: 1,
      imageResultCount: 0,
      hybridResultCount: 0,
    });
    expect(payload.results[0].result.matchedQueries).toEqual([
      { query: "blue striped midi dress", lane: "text", provider: "aliexpress" },
    ]);
  });
});

