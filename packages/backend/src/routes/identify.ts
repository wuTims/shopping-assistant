import { Hono } from "hono";
import type { IdentifyRequest, IdentifyResponse } from "@shopping-assistant/shared";
import { IDENTIFY_TIMEOUT_MS } from "@shopping-assistant/shared";
import { identifyFromScreenshot } from "../services/gemini.js";
import sharp from "sharp";

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
    const response = await Promise.race([
      (async (): Promise<IdentifyResponse> => {
        const result = await identifyFromScreenshot(base64Data);

        const screenshotBuffer = Buffer.from(base64Data, "base64");
        const metadata = await sharp(screenshotBuffer).metadata();
        const imgWidth = metadata.width ?? 1;
        const imgHeight = metadata.height ?? 1;

        return {
          products: await Promise.all(
            result.products.map(async (p) => {
              let imageRegion: string | null = null;

              if (p.boundingBox) {
                try {
                  // Clamp bounding box to image dimensions
                  const x = Math.max(0, Math.round(p.boundingBox.x));
                  const y = Math.max(0, Math.round(p.boundingBox.y));
                  const w = Math.max(0, Math.min(Math.round(p.boundingBox.width), imgWidth - x));
                  const h = Math.max(0, Math.min(Math.round(p.boundingBox.height), imgHeight - y));

                  if (w > 10 && h > 10) {
                    const cropped = await sharp(screenshotBuffer)
                      .extract({ left: x, top: y, width: w, height: h })
                      .png()
                      .toBuffer();
                    imageRegion = cropped.toString("base64");
                  }
                } catch (err) {
                  console.warn(`[identify] Cropping failed for "${p.name}":`, err);
                }
              }

              return {
                name: p.name,
                price: p.price,
                currency: p.currency,
                boundingBox: p.boundingBox,
                imageRegion,
              };
            }),
          ),
          pageType: result.pageType,
        };
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Identify timed out")), IDENTIFY_TIMEOUT_MS),
      ),
    ]);

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
