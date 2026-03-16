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
  const hostname = new URL(url).hostname;

  // Strategy 1: Lightweight HTTP fetch + structured data (fast, no bot detection)
  const httpResult = await fetchAndExtractPrice(url);
  if (httpResult.price !== null) {
    console.log(`[price-fallback] HTTP extraction succeeded for ${hostname}: ${httpResult.currency}${httpResult.price}`);
    return httpResult;
  }
  console.log(`[price-fallback] HTTP extraction failed for ${hostname}, falling back to Playwright`);

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

/**
 * Detect URLs that are category/search/listing pages rather than product pages.
 * Price extraction on these pages returns misleading prices (random product on page).
 */
function isNonProductUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const search = parsed.search.toLowerCase();

    // Category / listing / search patterns
    if (path.match(/\/(shop|category|categories|collections|browse|search|s)\b/)) return true;
    if (search.includes("k=") || search.includes("q=") || search.includes("query=")) return true;
    // Filter/facet pages (e.g., macys.com/shop/womens/dresses?Color=Black)
    if (path.match(/\/(womens|mens|kids|home|clothing|shoes|accessories)\//)) {
      // But allow if URL also has a product-like identifier (DP, listing, item, product)
      if (!path.match(/\/(dp|item|listing|product|products|p)\b/)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function fillMissingPrices(
  results: Array<{ id: string; productUrl: string; price: number | null; currency: string | null }>,
  maxResults: number,
): Promise<Map<string, { price: number; currency: string }>> {
  const withPrice = results.filter((r) => r.price != null).length;
  const priceless = results
    .filter((r) => r.price == null)
    .slice(0, maxResults);

  console.log(`[price-fallback] ${withPrice}/${results.length} results already have prices, attempting ${priceless.length} extractions`);

  // Filter out non-product URLs (category/search pages) — prices from those are unreliable
  const productUrls: typeof priceless = [];
  for (const r of priceless) {
    if (isNonProductUrl(r.productUrl)) {
      console.log(`[price-fallback]   Skip (non-product URL): "${r.productUrl.slice(0, 80)}"`);
    } else {
      console.log(`[price-fallback]   Need price: "${r.productUrl.slice(0, 80)}"`);
      productUrls.push(r);
    }
  }

  const extracted = new Map<string, { price: number; currency: string }>();

  const settled = await Promise.allSettled(
    productUrls.map(async (r) => {
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
