import { describe, it, expect, vi, afterEach } from "vitest";

const fetchAndExtractPriceMock = vi.fn();

vi.mock("../ai-client.js", () => ({
  ai: {},
  geminiModel: "test-model",
}));

vi.mock("../price-extractor.js", () => ({
  fetchAndExtractPrice: fetchAndExtractPriceMock,
}));

// Must import AFTER vi.mock
const { quickHttpPriceEnrich } = await import("../price-fallback.js");

describe("quickHttpPriceEnrich", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fetchAndExtractPriceMock.mockReset();
  });

  it("extracts prices from priceless results via HTTP", async () => {
    fetchAndExtractPriceMock.mockResolvedValue({
      price: 399.99,
      currency: "USD",
      httpStatus: 200,
    });

    const results = [
      { id: "r1", productUrl: "https://www.walmart.com/ip/test-product/123", price: null, currency: null },
    ];

    const { prices, deadLinks } = await quickHttpPriceEnrich(results, 5);

    expect(prices.size).toBe(1);
    expect(prices.get("r1")).toEqual({ price: 399.99, currency: "USD" });
    expect(deadLinks.size).toBe(0);
  });

  it("detects dead links (404) from priceless results", async () => {
    fetchAndExtractPriceMock.mockResolvedValue({
      price: null,
      currency: null,
      httpStatus: 404,
    });

    const results = [
      { id: "r1", productUrl: "https://www.ebay.com/itm/123456", price: null, currency: null },
    ];

    const { prices, deadLinks } = await quickHttpPriceEnrich(results, 5);

    expect(prices.size).toBe(0);
    expect(deadLinks.size).toBe(1);
    expect(deadLinks.has("r1")).toBe(true);
  });

  it("detects dead links (410 Gone) from priceless results", async () => {
    fetchAndExtractPriceMock.mockResolvedValue({
      price: null,
      currency: null,
      httpStatus: 410,
    });

    const results = [
      { id: "r1", productUrl: "https://www.ebay.com/itm/123456", price: null, currency: null },
    ];

    const { prices, deadLinks } = await quickHttpPriceEnrich(results, 5);

    expect(deadLinks.has("r1")).toBe(true);
  });

  it("validates cluster-priced results via HEAD request", async () => {
    // Mock globalThis.fetch for HEAD requests (cluster-priced results bypass fetchAndExtractPrice)
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 404 });

    const results = [
      {
        id: "r1",
        productUrl: "https://www.ebay.com/itm/357788513620",
        price: 19.99,
        currency: "USD",
        priceSource: "provider_structured" as const,
      },
    ];

    const { prices, deadLinks } = await quickHttpPriceEnrich(results, 5);

    expect(deadLinks.has("r1")).toBe(true);
    expect(prices.size).toBe(0);
    // Verify HEAD method was used
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://www.ebay.com/itm/357788513620",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("does not flag network errors as dead links", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const results = [
      {
        id: "r1",
        productUrl: "https://www.ebay.com/itm/123",
        price: 29.99,
        currency: "USD",
        priceSource: "provider_structured" as const,
      },
    ];

    const { deadLinks } = await quickHttpPriceEnrich(results, 5);

    expect(deadLinks.size).toBe(0);
  });

  it("skips non-product URLs for price extraction", async () => {
    const results = [
      { id: "r1", productUrl: "https://www.amazon.com/s?k=generator", price: null, currency: null },
    ];

    const { prices } = await quickHttpPriceEnrich(results, 5);

    expect(prices.size).toBe(0);
    expect(fetchAndExtractPriceMock).not.toHaveBeenCalled();
  });

  it("respects maxPriceResults limit", async () => {
    fetchAndExtractPriceMock.mockResolvedValue({ price: 10, currency: "USD", httpStatus: 200 });

    const results = [
      { id: "r1", productUrl: "https://www.walmart.com/ip/prod1/1", price: null, currency: null },
      { id: "r2", productUrl: "https://www.walmart.com/ip/prod2/2", price: null, currency: null },
      { id: "r3", productUrl: "https://www.walmart.com/ip/prod3/3", price: null, currency: null },
    ];

    const { prices } = await quickHttpPriceEnrich(results, 2);

    // 2 from the priceless pool + 1 unchecked liveness GET = 3 total
    expect(fetchAndExtractPriceMock).toHaveBeenCalledTimes(3);
    // The priceless pool should only extract prices for the first 2
    expect(prices.size).toBe(3); // 2 priceless + 1 bonus from liveness check
  });

  it("detects stale products (HTTP 200 with unavailable body content)", async () => {
    fetchAndExtractPriceMock.mockResolvedValue({
      price: null,
      currency: null,
      httpStatus: 200,
      stale: true,
    });

    const results = [
      { id: "r1", productUrl: "https://www.macys.com/shop/product/some-dress?ID=123", price: null, currency: null },
    ];

    const { prices, deadLinks } = await quickHttpPriceEnrich(results, 5);

    expect(prices.size).toBe(0);
    expect(deadLinks.size).toBe(1);
    expect(deadLinks.has("r1")).toBe(true);
  });
});
