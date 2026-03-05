import type { DetectedProduct, SerializableRect } from "@shopping-assistant/shared";
import { MIN_IMAGE_SIZE_PX, MAX_OVERLAYS_PER_PAGE } from "@shopping-assistant/shared";

/** Simple string hash (djb2). */
function hashString(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function makeProductId(imageUrl: string, pageUrl: string): string {
  return hashString(imageUrl + "|" + pageUrl);
}

function toSerializableRect(el: Element): SerializableRect {
  const r = el.getBoundingClientRect();
  return {
    x: r.x, y: r.y, width: r.width, height: r.height,
    top: r.top, right: r.right, bottom: r.bottom, left: r.left,
  };
}

function parsePrice(text: string): { price: number; currency: string } | null {
  const match = text.match(/([£$€¥₹])\s*([\d,]+(?:\.\d{1,2})?)/);
  if (match) {
    const currencyMap: Record<string, string> = { "$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR" };
    return { price: parseFloat(match[2].replace(/,/g, "")), currency: currencyMap[match[1]] ?? "USD" };
  }
  const match2 = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)/i);
  if (match2) {
    return { price: parseFloat(match2[1].replace(/,/g, "")), currency: match2[2].toUpperCase() };
  }
  return null;
}

function getMarketplace(url: string): string | null {
  const host = new URL(url).hostname.replace("www.", "");
  const map: Record<string, string> = {
    "amazon.com": "Amazon", "amazon.co.uk": "Amazon", "amazon.de": "Amazon",
    "amazon.ca": "Amazon", "amazon.co.jp": "Amazon",
    "ebay.com": "eBay", "ebay.co.uk": "eBay",
    "walmart.com": "Walmart", "target.com": "Target",
    "aliexpress.com": "AliExpress", "temu.com": "Temu",
    "etsy.com": "Etsy", "bestbuy.com": "Best Buy",
  };
  for (const [domain, name] of Object.entries(map)) {
    if (host.includes(domain)) return name;
  }
  return host;
}

// ── Detection Strategies ──

interface RawDetection {
  imageUrl: string;
  imageEl: Element;
  title: string | null;
  price: number | null;
  currency: string | null;
}

function detectJsonLd(): RawDetection[] {
  const results: RawDetection[] = [];
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const item of items) {
        if (item["@type"] !== "Product") continue;
        const imageUrl = Array.isArray(item.image) ? item.image[0] : item.image;
        if (!imageUrl || typeof imageUrl !== "string") continue;
        const imgEl = document.querySelector(`img[src="${imageUrl}"], img[src*="${imageUrl.split("/").pop()}"]`);
        if (!imgEl) continue;
        const rect = imgEl.getBoundingClientRect();
        if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) continue;

        let price: number | null = null;
        let currency: string | null = null;
        const offers = item.offers ?? item.offer;
        if (offers) {
          const offer = Array.isArray(offers) ? offers[0] : offers;
          if (offer.price) price = parseFloat(offer.price);
          if (offer.priceCurrency) currency = offer.priceCurrency;
        }

        results.push({
          imageUrl, imageEl: imgEl,
          title: item.name ?? null, price, currency,
        });
      }
    } catch { /* skip malformed JSON-LD */ }
  }
  return results;
}

function detectOpenGraph(): RawDetection[] {
  const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute("content");
  if (!ogType || !ogType.includes("product")) return [];

  const imageUrl = document.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? null;
  const priceStr = document.querySelector('meta[property="product:price:amount"], meta[property="og:price:amount"]')?.getAttribute("content");
  const currency = document.querySelector('meta[property="product:price:currency"], meta[property="og:price:currency"]')?.getAttribute("content") ?? null;

  if (!imageUrl) return [];
  const imgEl = document.querySelector(`img[src="${imageUrl}"], img[src*="${imageUrl.split("/").pop()}"]`);
  if (!imgEl) return [];
  const rect = imgEl.getBoundingClientRect();
  if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) return [];

  return [{
    imageUrl, imageEl: imgEl, title,
    price: priceStr ? parseFloat(priceStr) : null, currency,
  }];
}

function detectAmazon(): RawDetection[] {
  if (!location.hostname.includes("amazon")) return [];
  const imgEl = document.querySelector("#imgTagWrapperId img, #landingImage, #main-image");
  if (!imgEl) return [];
  const imageUrl = imgEl.getAttribute("src");
  if (!imageUrl) return [];
  const rect = imgEl.getBoundingClientRect();
  if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) return [];

  const title = document.querySelector("#productTitle")?.textContent?.trim() ?? null;
  const priceWhole = document.querySelector(".a-price .a-price-whole")?.textContent?.replace(/[^0-9]/g, "") ?? "";
  const priceFrac = document.querySelector(".a-price .a-price-fraction")?.textContent?.replace(/[^0-9]/g, "") ?? "00";
  const price = priceWhole ? parseFloat(`${priceWhole}.${priceFrac}`) : null;

  return [{ imageUrl, imageEl: imgEl, title, price, currency: "USD" }];
}

function detectEbay(): RawDetection[] {
  if (!location.hostname.includes("ebay")) return [];
  const imgEl = document.querySelector(".ux-image-carousel-item img, #icImg");
  if (!imgEl) return [];
  const imageUrl = imgEl.getAttribute("src");
  if (!imageUrl) return [];
  const rect = imgEl.getBoundingClientRect();
  if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) return [];

  const title = document.querySelector(".x-item-title__mainTitle span, #itemTitle")?.textContent?.trim() ?? null;
  const priceEl = document.querySelector(".x-price-primary span, #prcIsum");
  const parsed = priceEl?.textContent ? parsePrice(priceEl.textContent) : null;

  return [{
    imageUrl, imageEl: imgEl, title,
    price: parsed?.price ?? null, currency: parsed?.currency ?? "USD",
  }];
}

function detectGenericFallback(): RawDetection[] {
  const results: RawDetection[] = [];
  const images = document.querySelectorAll("img");
  for (const img of images) {
    const rect = img.getBoundingClientRect();
    if (rect.width < MIN_IMAGE_SIZE_PX || rect.height < MIN_IMAGE_SIZE_PX) continue;
    const imageUrl = img.src;
    if (!imageUrl || imageUrl.startsWith("data:")) continue;

    // Walk up to find a container with price text
    let container = img.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      const text = container.textContent ?? "";
      const parsed = parsePrice(text);
      if (parsed) {
        // Try to find a title nearby
        const heading = container.querySelector("h1, h2, h3, h4, [class*='title'], [class*='name']");
        results.push({
          imageUrl, imageEl: img,
          title: heading?.textContent?.trim() ?? null,
          price: parsed.price, currency: parsed.currency,
        });
        break;
      }
      container = container.parentElement;
    }
  }
  return results;
}

// ── Public API ──

export function detectProducts(): DetectedProduct[] {
  const pageUrl = location.href;
  const marketplace = getMarketplace(pageUrl);
  const seen = new Set<string>();
  const products: DetectedProduct[] = [];

  const strategies = [detectJsonLd, detectOpenGraph, detectAmazon, detectEbay, detectGenericFallback];

  for (const strategy of strategies) {
    for (const raw of strategy()) {
      const id = makeProductId(raw.imageUrl, pageUrl);
      if (seen.has(id)) continue;
      seen.add(id);

      products.push({
        id, imageUrl: raw.imageUrl,
        title: raw.title, price: raw.price, currency: raw.currency,
        pageUrl, marketplace,
        schemaData: null,
        boundingRect: toSerializableRect(raw.imageEl),
        detectedAt: Date.now(),
      });

      if (products.length >= MAX_OVERLAYS_PER_PAGE) return products;
    }
  }

  return products;
}

export { makeProductId };
