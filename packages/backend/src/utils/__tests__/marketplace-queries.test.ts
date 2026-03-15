import { describe, it, expect } from "vitest";
import { generateMarketplaceQueries } from "../marketplace-queries.js";

describe("generateMarketplaceQueries", () => {
  it("generates site-scoped queries for target marketplaces", () => {
    const queries = generateMarketplaceQueries("wireless earbuds");
    expect(queries).toContain("wireless earbuds site:dhgate.com");
    expect(queries).toContain("wireless earbuds site:temu.com");
    expect(queries).toContain("wireless earbuds site:1688.com");
    expect(queries).toHaveLength(3);
  });

  it("trims whitespace from product name", () => {
    const queries = generateMarketplaceQueries("  blue widget  ");
    expect(queries[0]).toBe("blue widget site:dhgate.com");
  });

  it("returns empty array for empty product name", () => {
    const queries = generateMarketplaceQueries("");
    expect(queries).toHaveLength(0);
  });
});
