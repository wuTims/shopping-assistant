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
});
