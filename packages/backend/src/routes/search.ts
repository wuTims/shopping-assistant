import { Hono } from "hono";
import type { SearchRequest, SearchResponse } from "@shopping-assistant/shared";

export const searchRoute = new Hono();

searchRoute.post("/", async (c) => {
  const body = await c.req.json<SearchRequest>();

  // TODO: Implement identification → parallel search → ranking pipeline
  console.log("[search] Received request for:", body.title ?? body.imageUrl);

  const stubResponse: SearchResponse = {
    requestId: crypto.randomUUID(),
    originalProduct: {
      title: body.title,
      price: body.price,
      currency: body.currency,
      imageUrl: body.imageUrl,
      identification: {
        category: "unknown",
        description: "Product identification not yet implemented",
        brand: null,
        attributes: { color: null, material: null, style: null, size: null },
        searchQueries: [],
        estimatedPriceRange: null,
      },
    },
    results: [],
    searchMeta: {
      totalFound: 0,
      braveResultCount: 0,
      groundingResultCount: 0,
      sourceStatus: { brave: "ok", grounding: "ok" },
      searchDurationMs: 0,
      rankingDurationMs: 0,
    },
  };

  return c.json(stubResponse);
});
