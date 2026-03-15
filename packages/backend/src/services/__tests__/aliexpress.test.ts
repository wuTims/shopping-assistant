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
