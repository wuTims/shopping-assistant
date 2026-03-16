import { describe, it, expect, vi, afterEach } from "vitest";
import { extractPriceFromHtml, fetchAndExtractPrice, detectStaleContent } from "../price-extractor.js";

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

    it("handles @type as array (Shopify pattern)", () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {"@type":["Product","ItemPage"],"offers":{"price":"39.99","priceCurrency":"USD"}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 39.99, currency: "USD" });
    });

    it("handles offers as array (Amazon pattern)", () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {"@type":"Product","offers":[{"@type":"Offer","price":"19.99","priceCurrency":"USD"}]}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 19.99, currency: "USD" });
    });

    it("skips malformed JSON-LD and extracts from valid block", () => {
      const html = `<html><head>
        <script type="application/ld+json">{invalid json here</script>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"price":"12.99","priceCurrency":"USD"}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 12.99, currency: "USD" });
    });

    it("rejects zero and negative prices", () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"price":"0","priceCurrency":"USD"}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: null, currency: null });
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

  describe("embedded script data extraction", () => {
    it("extracts price from __NEXT_DATA__ with priceString (Walmart pattern)", () => {
      const html = `<html><head>
        <script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"initialData":{"data":{"product":{"priceInfo":{"currentPrice":{"price":11.49,"priceString":"$11.49"},"priceCurrency":"USD"}}}}}}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 11.49, currency: "USD" });
    });

    it("extracts price from __NEXT_DATA__ with currentPrice nested object", () => {
      const html = `<html><head>
        <script id="__NEXT_DATA__" type="application/json">
        {"props":{"pageProps":{"product":{"pricing":{"currentPrice":{"price":949.04},"currencyCode":"USD"}}}}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 949.04, currency: "USD" });
    });

    it("extracts price from __NEXT_DATA__ with salePrice flat field", () => {
      const html = `<html><head>
        <script id="__NEXT_DATA__" type="application/json">
        {"props":{"product":{"salePrice":24.99,"currency":"EUR"}}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 24.99, currency: "EUR" });
    });

    it("prefers JSON-LD over embedded script data", () => {
      const html = `<html><head>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"price":"29.99","priceCurrency":"USD"}}
        </script>
        <script id="__NEXT_DATA__" type="application/json">
        {"props":{"product":{"salePrice":19.99}}}
        </script>
        </head><body></body></html>`;
      expect(extractPriceFromHtml(html)).toEqual({ price: 29.99, currency: "USD" });
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
      status: 200,
      text: () => Promise.resolve(`<html><head>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"price":"49.99","priceCurrency":"USD"}}
        </script></head><body></body></html>`),
    });

    const result = await fetchAndExtractPrice("https://example.com/product");
    expect(result).toEqual({ price: 49.99, currency: "USD", httpStatus: 200 });
  });

  it("returns null with httpStatus for non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const result = await fetchAndExtractPrice("https://example.com/blocked");
    expect(result).toEqual({ price: null, currency: null, httpStatus: 403 });
  });

  it("returns 404 httpStatus for dead links", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchAndExtractPrice("https://example.com/removed");
    expect(result).toEqual({ price: null, currency: null, httpStatus: 404 });
  });

  it("returns null httpStatus on fetch error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await fetchAndExtractPrice("https://example.com/down");
    expect(result).toEqual({ price: null, currency: null, httpStatus: null });
  });

  it("detects stale product page (Macy's unavailable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`<html><body>
        <h1>Siena Women's Floral Print Sleeveless High-Low Maxi Dress</h1>
        <div class="message">Sorry, this item is currently unavailable.</div>
      </body></html>`),
    });
    const result = await fetchAndExtractPrice("https://www.macys.com/shop/product/test?ID=123");
    expect(result.stale).toBe(true);
    expect(result.price).toBeNull();
  });

  it("detects stale product page (Zappos out of stock)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`<html><body>
        <h1>Oops! That's out of stock.</h1>
        <p>Browse styles inspired by your search below!</p>
      </body></html>`),
    });
    const result = await fetchAndExtractPrice("https://www.zappos.com/p/test-dress");
    expect(result.stale).toBe(true);
  });

  it("detects stale product page (DHGate unavailable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`<html><body>
        <div>Currently unavailable. Highly Related Products Here</div>
      </body></html>`),
    });
    const result = await fetchAndExtractPrice("https://www.dhgate.com/product/test/123.html");
    expect(result.stale).toBe(true);
  });

  it("detects stale product page (Etsy item and shop unavailable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`<html><body>
        <div>Sorry, this item and shop are currently unavailable</div>
      </body></html>`),
    });
    const result = await fetchAndExtractPrice("https://www.etsy.com/listing/4393338219/");
    expect(result.stale).toBe(true);
    expect(result.price).toBeNull();
  });

  it("detects stale product page (Lowes no longer sold)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`<html><body>
        <p>This item is no longer sold on Lowes.com</p>
      </body></html>`),
    });
    const result = await fetchAndExtractPrice("https://www.lowes.com/pd/Champion-Power-Equipment/1000728080");
    expect(result.stale).toBe(true);
    expect(result.price).toBeNull();
  });

  it("does not flag live product pages as stale", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(`<html><head>
        <script type="application/ld+json">
        {"@type":"Product","offers":{"price":"49.99","priceCurrency":"USD"}}
        </script></head><body><h1>Great Dress</h1></body></html>`),
    });
    const result = await fetchAndExtractPrice("https://example.com/product");
    expect(result.stale).toBeUndefined();
    expect(result.price).toBe(49.99);
  });
});
