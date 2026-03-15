import { describe, it, expect, vi, afterEach } from "vitest";
import { extractPriceFromHtml, fetchAndExtractPrice } from "../price-extractor.js";

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
