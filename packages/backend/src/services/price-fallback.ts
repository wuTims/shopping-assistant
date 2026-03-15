import { chromium, type Browser } from "playwright";
import { ai, geminiModel as model } from "./ai-client.js";
import { PRICE_NAV_TIMEOUT_MS } from "@shopping-assistant/shared";
import { fetchAndExtractPrice } from "./price-extractor.js";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  if (!launching) {
    launching = chromium.launch({ headless: true }).then((b) => {
      browser = b;
      launching = null;
      return b;
    });
  }
  return launching;
}

export async function extractPriceFromUrl(
  url: string,
): Promise<{ price: number | null; currency: string | null }> {
  // Strategy 1: Lightweight HTTP fetch + structured data (fast, no bot detection)
  const httpResult = await fetchAndExtractPrice(url);
  if (httpResult.price !== null) {
    console.log(`[price-fallback] HTTP extraction succeeded for ${new URL(url).hostname}`);
    return httpResult;
  }

  // Strategy 2: Playwright screenshot + Gemini Vision (slow, expensive, last resort)
  return extractPriceViaPlaywright(url);
}

async function extractPriceViaPlaywright(
  url: string,
): Promise<{ price: number | null; currency: string | null }> {
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PRICE_NAV_TIMEOUT_MS });
    await page.waitForTimeout(500);

    const screenshot = await page.screenshot({ type: "png" });
    const base64 = screenshot.toString("base64");

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: base64 } },
            {
              text: `Extract the main product price from this screenshot. Return JSON: {"price": <number or null>, "currency": "<ISO code or null>"}. If no price is visible or the page shows an error/captcha, return {"price": null, "currency": null}.`,
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            price: { type: "number" as const, nullable: true },
            currency: { type: "string" as const, nullable: true },
          },
          required: ["price", "currency"],
        },
      },
    });

    const text = response.text ?? "{}";
    const parsed = JSON.parse(text);
    return {
      price: typeof parsed.price === "number" ? parsed.price : null,
      currency: typeof parsed.currency === "string" ? parsed.currency : null,
    };
  } catch (err) {
    console.error(`[price-fallback] Playwright failed for ${url}:`, err);
    return { price: null, currency: null };
  } finally {
    await context.close();
  }
}

export async function fillMissingPrices(
  results: Array<{ id: string; productUrl: string; price: number | null; currency: string | null }>,
  maxResults: number,
): Promise<Map<string, { price: number; currency: string }>> {
  const priceless = results
    .filter((r) => r.price == null)
    .slice(0, maxResults);

  const extracted = new Map<string, { price: number; currency: string }>();

  const settled = await Promise.allSettled(
    priceless.map(async (r) => {
      const result = await extractPriceFromUrl(r.productUrl);
      if (result.price != null && result.currency != null) {
        extracted.set(r.id, { price: result.price, currency: result.currency });
      }
    }),
  );

  const failed = settled.filter((s) => s.status === "rejected").length;
  if (failed > 0) {
    console.warn(`[price-fallback] ${failed}/${priceless.length} extractions failed`);
  }

  console.log(
    `[price-fallback] Extracted prices for ${extracted.size}/${priceless.length} results`,
  );

  return extracted;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
