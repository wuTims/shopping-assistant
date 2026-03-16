import { describe, expect, it } from "vitest";

describe("normalizeImageSearchQueries", () => {
  it("deduplicates, trims, and limits image-first queries", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const { normalizeImageSearchQueries } = await import("../gemini.js");
    const queries = normalizeImageSearchQueries([
      "  buy blue striped midi dress  ",
      "blue striped midi dress price",
      "buy blue striped midi dress",
      "",
      "shop blue and white summer dress",
      "women striped cotton dress for sale",
      "extra query that should be dropped",
    ]);

    expect(queries).toEqual([
      "buy blue striped midi dress",
      "blue striped midi dress price",
      "shop blue and white summer dress",
      "women striped cotton dress for sale",
      "extra query that should be dropped",
    ]);
  });

  it("falls back to a title hint query when no valid queries survive", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const { normalizeImageSearchQueries } = await import("../gemini.js");
    const queries = normalizeImageSearchQueries([], "Blue striped midi dress");

    expect(queries).toEqual(["buy Blue striped midi dress"]);
  });

  it("rejects low-signal generic image queries and records them for diagnostics", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const { sanitizeImageSearchQueries } = await import("../gemini.js");
    const queries = sanitizeImageSearchQueries([
      "tool cart",
      "rolling cart",
      "blue 3 drawer rolling tool cart",
      "WORKPRO 20 inch rolling tool chest",
    ], "WORKPRO 20 inch 3-drawer rolling tool chest - Walmart");

    expect(queries.acceptedQueries).toEqual([
      "blue 3 drawer rolling tool cart",
      "WORKPRO 20 inch rolling tool chest",
    ]);
    expect(queries.rejectedQueries).toEqual(["tool cart", "rolling cart"]);
  });
});
