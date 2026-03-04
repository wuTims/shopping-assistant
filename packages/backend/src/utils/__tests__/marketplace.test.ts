import { describe, it, expect } from "vitest";
import { extractMarketplace } from "../marketplace.js";

describe("extractMarketplace", () => {
  it("extracts known marketplaces", () => {
    expect(extractMarketplace("https://www.amazon.com/dp/B09XYZ")).toBe("Amazon");
    expect(extractMarketplace("https://www.ebay.com/itm/123")).toBe("eBay");
    expect(extractMarketplace("https://www.walmart.com/ip/456")).toBe("Walmart");
    expect(extractMarketplace("https://www.etsy.com/listing/789")).toBe("Etsy");
  });

  it("handles regional Amazon domains", () => {
    expect(extractMarketplace("https://www.amazon.co.uk/dp/B09")).toBe("Amazon UK");
    expect(extractMarketplace("https://www.amazon.de/dp/B09")).toBe("Amazon DE");
    expect(extractMarketplace("https://www.amazon.co.jp/dp/B09")).toBe("Amazon JP");
  });

  it("strips www prefix", () => {
    expect(extractMarketplace("https://amazon.com/dp/B09")).toBe("Amazon");
  });

  it("falls back to domain name for unknown sites", () => {
    const result = extractMarketplace("https://www.coolshop.com/product/123");
    expect(result).toBe("Coolshop");
  });

  it("handles multi-part TLDs", () => {
    const result = extractMarketplace("https://www.example.co.uk/product");
    expect(result).toBe("Example");
  });

  it("returns Unknown for invalid URLs", () => {
    expect(extractMarketplace("not-a-url")).toBe("Unknown");
  });
});
