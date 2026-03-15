import { describe, it, expect } from "vitest";
import { parsePrice, normalizeBraveImageResults } from "../brave.js";

describe("parsePrice", () => {
  it("parses USD with $ symbol", () => {
    expect(parsePrice("$29.99")).toEqual({ price: 29.99, currency: "USD" });
  });

  it("parses GBP with £ symbol", () => {
    expect(parsePrice("£15.00")).toEqual({ price: 15.0, currency: "GBP" });
  });

  it("parses EUR with € symbol", () => {
    expect(parsePrice("€42")).toEqual({ price: 42, currency: "EUR" });
  });

  it("returns null currency for ambiguous ¥ symbol", () => {
    expect(parsePrice("¥1280")).toEqual({ price: 1280, currency: null });
  });

  it("returns null currency for ¥ with decimals", () => {
    expect(parsePrice("¥99.50")).toEqual({ price: 99.5, currency: null });
  });

  it("parses CNY currency code", () => {
    expect(parsePrice("CNY 580")).toEqual({ price: 580, currency: "CNY" });
  });

  it("parses JPY currency code", () => {
    expect(parsePrice("JPY 1500")).toEqual({ price: 1500, currency: "JPY" });
  });

  it("returns null for no price", () => {
    expect(parsePrice("no price here")).toEqual({ price: null, currency: null });
  });

  it("returns null for null input", () => {
    expect(parsePrice(null)).toEqual({ price: null, currency: null });
  });
});

describe("normalizeBraveImageResults", () => {
  it("extracts shopping domain results with thumbnails", () => {
    const data = {
      results: [
        {
          url: "https://www.amazon.com/dp/B09XYZ123",
          title: "Wireless Headphones",
          thumbnail: { src: "https://imgs.amazon.com/thumb1.jpg" },
        },
        {
          url: "https://random-blog.com/review",
          title: "Blog Review of Headphones",
          thumbnail: { src: "https://random-blog.com/img.jpg" },
        },
        {
          url: "https://www.target.com/p/headphones",
          title: "Target Wireless Headphones",
          thumbnail: { src: "https://target.scene7.com/thumb2.jpg" },
        },
      ],
    };

    const results = normalizeBraveImageResults(data);
    expect(results).toHaveLength(2);

    expect(results[0].title).toBe("Wireless Headphones");
    expect(results[0].productUrl).toBe("https://www.amazon.com/dp/B09XYZ123");
    expect(results[0].imageUrl).toBe("https://imgs.amazon.com/thumb1.jpg");
    expect(results[0].marketplace).toBe("Amazon");
    expect(results[0].source).toBe("brave");
    expect(results[0].id).toMatch(/^brave_img_/);

    expect(results[1].title).toBe("Target Wireless Headphones");
    expect(results[1].productUrl).toBe("https://www.target.com/p/headphones");
    expect(results[1].imageUrl).toBe("https://target.scene7.com/thumb2.jpg");
    expect(results[1].marketplace).toBe("Target");
    expect(results[1].source).toBe("brave");
    expect(results[1].id).toMatch(/^brave_img_/);
  });

  it("generates unique IDs across calls", () => {
    const data = {
      results: [
        {
          url: "https://www.amazon.com/dp/B09XYZ123",
          title: "Headphones",
          thumbnail: { src: "https://imgs.amazon.com/thumb.jpg" },
        },
      ],
    };

    const results1 = normalizeBraveImageResults(data);
    const results2 = normalizeBraveImageResults(data);
    expect(results1[0].id).not.toBe(results2[0].id);
  });

  it("returns empty array for missing results", () => {
    expect(normalizeBraveImageResults({})).toEqual([]);
    expect(normalizeBraveImageResults({ results: [] })).toEqual([]);
  });

  it("parses price from title when present", () => {
    const data = {
      results: [
        {
          url: "https://www.walmart.com/ip/headphones/123",
          title: "Wireless Headphones $24.99 - Walmart",
          thumbnail: { src: "https://i5.walmartimages.com/thumb.jpg" },
        },
      ],
    };

    const results = normalizeBraveImageResults(data);
    expect(results).toHaveLength(1);
    expect(results[0].price).toBe(24.99);
    expect(results[0].currency).toBe("USD");
  });

  it("falls back through image URL chain when thumbnail is missing", () => {
    const dataWithPlaceholder = {
      results: [
        {
          url: "https://www.amazon.com/dp/B09XYZ123",
          title: "Headphones",
          properties: { placeholder: "https://placeholder.example.com/img.jpg" },
        },
      ],
    };

    const results1 = normalizeBraveImageResults(dataWithPlaceholder);
    expect(results1[0].imageUrl).toBe("https://placeholder.example.com/img.jpg");

    const dataWithPropertiesUrl = {
      results: [
        {
          url: "https://www.amazon.com/dp/B09XYZ123",
          title: "Headphones",
          properties: { url: "https://properties-url.example.com/img.jpg" },
        },
      ],
    };

    const results2 = normalizeBraveImageResults(dataWithPropertiesUrl);
    expect(results2[0].imageUrl).toBe("https://properties-url.example.com/img.jpg");
  });
});
