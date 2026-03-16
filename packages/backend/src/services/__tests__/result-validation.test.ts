import { describe, expect, it } from "vitest";

describe("result validation", () => {
  it("classifies obvious non-product URLs and keeps product-detail URLs", async () => {
    const {
      annotateResultValidation,
      classifyResultUrl,
      isDisplayableCandidate,
    } = await import("../result-validation.js");

    expect(classifyResultUrl("https://www.walmart.com/ip/Workbench-Tool-Cart/12345")).toBe("product_detail");
    expect(classifyResultUrl("https://www.walmart.com/search?q=tool+cart")).toBe("search_results");
    expect(classifyResultUrl("https://www.walmart.com/browse/tools/tool-carts/1234")).toBe("category_listing");
    expect(classifyResultUrl("https://www.bestbuy.com/site/searchpage.jsp?st=tool+cart")).toBe("search_results");
    expect(classifyResultUrl("https://www.aliexpress.com/store/1101234567")).toBe("seller_store");

    // New non-product URL patterns
    expect(classifyResultUrl("https://www.amazon.com/s?k=generator")).toBe("search_results");
    expect(classifyResultUrl("https://www.amazon.com/Birds-Print-Dress/s?k=Birds+Print+Dress")).toBe("search_results");
    expect(classifyResultUrl("https://www.etsy.com/market/blue_toile_dress")).toBe("category_listing");
    expect(classifyResultUrl("https://www.nordstrom.com/brands/reformation--18924?filterByColor=blue")).toBe("category_listing");
    expect(classifyResultUrl("https://www.dhgate.com/wholesale/reformation+long+dress.html")).toBe("category_listing");
    expect(classifyResultUrl("https://www.ebay.com/sch/109740/i.html")).toBe("search_results");
    expect(classifyResultUrl("https://www.walmart.com/cp/the-pioneer-woman-patio-garden/6178203")).toBe("category_listing");
    expect(classifyResultUrl("https://www.aliexpress.com/w/wholesale-ergonomic-chair.html")).toBe("category_listing");
    expect(classifyResultUrl("https://www.nordstrom.com/sr?keyword=dress")).toBe("search_results");
    expect(classifyResultUrl("https://www.target.com/s?searchTerm=dress")).toBe("search_results");
    expect(classifyResultUrl("https://www.lyst.com/designer/on-shoes/")).toBe("category_listing");
    expect(classifyResultUrl("https://www.poshmark.com/closet/username")).toBe("store_front");
    expect(classifyResultUrl("https://www.ebay.com/str/storename")).toBe("store_front");
    expect(classifyResultUrl("https://www.amazon.com/deals")).toBe("category_listing");

    // Kohl's catalog pages → category_listing
    expect(classifyResultUrl("https://www.kohls.com/catalog/womens-blue-dresses-clothing.jsp?CN=Gender%3AWomens+Color%3ABlue")).toBe("category_listing");

    // Zappos OOS redirect → search_results
    expect(classifyResultUrl("https://www.zappos.com/womens-lilly-pulitzer-haliey-midi-dress?oosRedirected=true")).toBe("search_results");

    // Product detail whitelist — host-specific patterns checked before generic patterns
    expect(classifyResultUrl("https://www.nordstrom.com/s/kate-spade-wool-coat/7958453")).toBe("product_detail");
    expect(classifyResultUrl("https://poshmark.com/listing/Nike-Air-Max-5a1afed199086a")).toBe("product_detail");
    expect(classifyResultUrl("https://www.mercari.com/us/item/m12345678901/")).toBe("product_detail");
    expect(classifyResultUrl("https://www.depop.com/products/seller-vintage-dress-3c32/")).toBe("product_detail");
    expect(classifyResultUrl("https://www.dhgate.com/product/ss-something/123456.html")).toBe("product_detail");
    expect(classifyResultUrl("https://www.macys.com/shop/product/giani-bernini-bag?ID=123")).toBe("product_detail");

    // Lyst product pages should NOT be classified as non-product (they use /clothing/ for products)
    expect(classifyResultUrl("https://www.lyst.com/clothing/reformation-nonie-dress/")).toBe("unknown");
    expect(classifyResultUrl("https://www.lyst.com/clothing/reformation-tagliatelle-denim-midi-dress/")).toBe("unknown");

    const validProduct = annotateResultValidation({
      id: "valid",
      source: "brave",
      title: "Blue rolling tool cart",
      price: null,
      currency: null,
      imageUrl: "https://img.example.com/cart.jpg",
      productUrl: "https://www.walmart.com/ip/Workbench-Tool-Cart/12345",
      marketplace: "Walmart",
      snippet: null,
      structuredData: null,
      raw: {},
    });

    const invalidSearchPage = annotateResultValidation({
      id: "invalid",
      source: "brave",
      title: "Tool cart search results",
      price: 2497,
      currency: "USD",
      imageUrl: null,
      productUrl: "https://www.bestbuy.com/site/searchpage.jsp?st=tool+cart",
      marketplace: "Best Buy",
      snippet: null,
      structuredData: null,
      raw: {},
    });

    expect(validProduct.validationStatus).toBe("valid");
    expect(validProduct.urlClassification).toBe("product_detail");
    expect(isDisplayableCandidate(validProduct)).toBe(true);

    expect(invalidSearchPage.validationStatus).toBe("invalid");
    expect(invalidSearchPage.urlClassification).toBe("search_results");
    expect(isDisplayableCandidate(invalidSearchPage)).toBe(false);
  });

  it("filters results with marketplace-only titles", async () => {
    const { isDisplayableCandidate } = await import("../result-validation.js");

    // Title = "1688" (just the site name) → not displayable
    expect(isDisplayableCandidate({
      id: "t1",
      source: "brave" as const,
      title: "1688",
      price: null,
      currency: null,
      imageUrl: null,
      productUrl: "https://detail.1688.com/offer/123.html",
      marketplace: "1688",
      snippet: null,
      structuredData: null,
      raw: {},
      validationStatus: "unknown",
    })).toBe(false);

    // Real product title → displayable
    expect(isDisplayableCandidate({
      id: "t2",
      source: "brave" as const,
      title: "Navy Blue Floral Midi Dress",
      price: 25,
      currency: "USD",
      imageUrl: null,
      productUrl: "https://detail.1688.com/offer/456.html",
      marketplace: "1688",
      snippet: null,
      structuredData: null,
      raw: {},
      validationStatus: "unknown",
    })).toBe(true);
  });

  it("filters non-purchasable titles (PDF sewing patterns)", async () => {
    const { isDisplayableCandidate } = await import("../result-validation.js");

    expect(isDisplayableCandidate({
      id: "t1",
      source: "brave" as const,
      title: "PDF Dress Sewing Pattern | Easy sewing pattern for women",
      price: null,
      currency: null,
      imageUrl: null,
      productUrl: "https://www.etsy.com/listing/1876886832/pdf-dress-sewing-pattern-easy-sewing",
      marketplace: "Etsy",
      snippet: null,
      structuredData: null,
      raw: {},
      urlClassification: "product_detail",
      validationStatus: "valid",
    })).toBe(false);

    // A real dress listing on Etsy → still displayable
    expect(isDisplayableCandidate({
      id: "t2",
      source: "brave" as const,
      title: "Vintage Navy Floral Midi Dress Handmade",
      price: 35,
      currency: "USD",
      imageUrl: null,
      productUrl: "https://www.etsy.com/listing/999999/vintage-navy-floral-dress",
      marketplace: "Etsy",
      snippet: null,
      structuredData: null,
      raw: {},
      urlClassification: "product_detail",
      validationStatus: "valid",
    })).toBe(true);
  });
});
