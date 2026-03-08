import { Hono } from "hono";
import type { IdentifyRequest, IdentifyResponse } from "@shopping-assistant/shared";
import { IDENTIFY_TIMEOUT_MS } from "@shopping-assistant/shared";
import { identifyFromScreenshot } from "../services/gemini.js";

const identify = new Hono();

identify.post("/", async (c) => {
  const start = Date.now();
  const body = await c.req.json<IdentifyRequest>();

  if (!body.screenshot || !body.pageUrl) {
    return c.json({ error: "screenshot and pageUrl are required" }, 400);
  }

  // Strip data URL prefix if present (e.g. "data:image/png;base64,...")
  const base64Data = body.screenshot.includes(",")
    ? body.screenshot.split(",")[1]
    : body.screenshot;

  try {
    const result = await Promise.race([
      identifyFromScreenshot(base64Data),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Identify timed out")), IDENTIFY_TIMEOUT_MS),
      ),
    ]);

    const response: IdentifyResponse = {
      products: result.products.map((p) => ({
        name: p.name,
        price: p.price,
        currency: p.currency,
        boundingBox: p.boundingBox,
        imageRegion: null, // Cropping deferred to client
      })),
      pageType: result.pageType,
    };

    console.log(
      `[identify] Found ${response.products.length} products (${response.pageType}) in ${Date.now() - start}ms`,
    );

    return c.json(response);
  } catch (err) {
    console.error("[identify] Failed:", err);
    return c.json({ error: "Failed to identify products" }, 500);
  }
});

export default identify;
