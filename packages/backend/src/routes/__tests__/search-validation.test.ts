import type { SearchResponse } from "@shopping-assistant/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const identifyProductMock = vi.fn();
const generateImageSearchQueriesMock = vi.fn();
const searchProductsMock = vi.fn();
const searchImagesMock = vi.fn();
const searchAliExpressSplitMock = vi.fn();
const quickHttpPriceEnrichMock = vi.fn();
const generateMarketplaceQueriesMock = vi.fn();
const extractMarketplaceMock = vi.fn();
const computeVisualSimilarityScoresMock = vi.fn();

vi.mock("../../services/gemini.js", () => ({
  identifyProduct: identifyProductMock,
  generateImageSearchQueries: generateImageSearchQueriesMock,
  sanitizeImageSearchQueries: (rawQueries: string[], titleHint: string | null) => {
    const acceptedQueries = rawQueries.filter((query) => query !== "tool cart");
    return {
      acceptedQueries: acceptedQueries.length > 0 ? acceptedQueries : titleHint ? [`buy ${titleHint}`] : [],
      rejectedQueries: rawQueries.filter((query) => query === "tool cart"),
    };
  },
}));

vi.mock("../../services/brave.js", () => ({
  searchProducts: searchProductsMock,
  searchImages: searchImagesMock,
}));

vi.mock("../../services/aliexpress.js", () => ({
  searchAliExpressSplit: searchAliExpressSplitMock,
}));

vi.mock("../../services/price-fallback.js", () => ({
  quickHttpPriceEnrich: quickHttpPriceEnrichMock,
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

function providerOutcome(results: Array<Record<string, unknown>>) {
  return {
    results,
    status: "ok" as const,
    totalQueries: 1,
    successfulQueries: 1,
    failedQueries: 0,
    timedOutQueries: 0,
  };
}

function splitOutcome(textResults: Array<Record<string, unknown>>, imageResults: Array<Record<string, unknown>>) {
  return {
    textOutcome: providerOutcome(textResults),
    imageOutcome: providerOutcome(imageResults),
    combinedOutcome: providerOutcome([...textResults, ...imageResults]),
  };
}

function baseRequest() {
  return {
    imageUrl: null,
    imageBase64: "ZmFrZQ==",
    title: "Blue striped midi dress",
    price: 99.99,
    currency: "USD",
    sourceUrl: "https://source.example.com/tool-cart",
    identification: {
      category: "Tool chest",
      description: "Blue rolling tool chest",
      brand: "WORKPRO",
      attributes: {
        color: "blue",
        material: "steel",
        style: null,
        size: null,
      },
      searchQueries: ["blue rolling tool cart"],
      estimatedPriceRange: null,
    },
  };
}

describe("/search route validation metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    identifyProductMock.mockReset();
    generateImageSearchQueriesMock.mockReset();
    searchProductsMock.mockReset();
    searchImagesMock.mockReset();
    searchAliExpressSplitMock.mockReset();
    quickHttpPriceEnrichMock.mockReset();
    generateMarketplaceQueriesMock.mockReset();
    extractMarketplaceMock.mockReset();
    computeVisualSimilarityScoresMock.mockReset();

    extractMarketplaceMock.mockReturnValue("Walmart");
    generateMarketplaceQueriesMock.mockReturnValue([]);
    quickHttpPriceEnrichMock.mockResolvedValue({ prices: new Map(), deadLinks: new Set() });
    computeVisualSimilarityScoresMock.mockResolvedValue({});
    searchAliExpressSplitMock.mockResolvedValue(splitOutcome([], []));
    searchProductsMock.mockResolvedValue(providerOutcome([]));
    searchImagesMock.mockResolvedValue(providerOutcome([]));
  });

  it("filters invalid store/search pages and exposes image-query diagnostics", async () => {
    generateImageSearchQueriesMock.mockResolvedValue(["tool cart", "blue 3 drawer rolling tool cart"]);

    searchProductsMock.mockImplementation(async (queries: string[]) => {
      if (queries[0] === "Blue striped midi dress") {
        return providerOutcome([
          {
            id: "search_page",
            source: "brave",
            title: "Tool carts - Best Buy search results",
            price: 2497,
            currency: "USD",
            imageUrl: null,
            productUrl: "https://www.bestbuy.com/site/searchpage.jsp?st=tool+cart",
            marketplace: "Best Buy",
            snippet: "Find the best tool carts",
            structuredData: null,
            raw: {},
          },
        ]);
      }

      if (queries[0] === "blue 3 drawer rolling tool cart") {
        return providerOutcome([
          {
            id: "real_product",
            source: "brave",
            title: "WORKPRO 20-inch 3-Drawer Rolling Tool Chest",
            price: null,
            currency: "USD",
            imageUrl: "https://img.example.com/tool-cart.jpg",
            productUrl: "https://www.walmart.com/ip/WORKPRO-20-inch-3-Drawer-Rolling-Tool-Chest/13683071475",
            marketplace: "Walmart",
            snippet: "Rolling tool chest with 3 drawers",
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
      body: JSON.stringify(baseRequest()),
    });

    expect(response.status).toBe(200);
    const payload = await response.json() as SearchResponse;

    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].result.productUrl).toBe("https://www.walmart.com/ip/WORKPRO-20-inch-3-Drawer-Rolling-Tool-Chest/13683071475");
    expect(payload.results[0].result.urlClassification).toBe("product_detail");
    expect(payload.results[0].result.validationStatus).toBe("valid");
    expect(payload.results[0].result.price).toBeNull();
    expect(payload.results[0].result.priceSource).toBe("none");
    expect(payload.searchMeta.totalFound).toBe(1);
    expect(payload.searchMeta.imageQueryDiagnostics).toEqual({
      rawQueryCount: 2,
      acceptedQueries: ["blue 3 drawer rolling tool cart"],
      rejectedQueries: ["tool cart"],
    });
  });
});


