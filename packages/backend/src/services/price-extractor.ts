import { PRICE_HTTP_TIMEOUT_MS } from "@shopping-assistant/shared";

const FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Fetch a URL via lightweight HTTP and extract price from structured data in HTML. */
export async function fetchAndExtractPrice(
  url: string,
): Promise<{ price: number | null; currency: string | null }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(PRICE_HTTP_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!res.ok) return { price: null, currency: null };

    const html = await res.text();
    return extractPriceFromHtml(html);
  } catch {
    return { price: null, currency: null };
  }
}

/** Extract price from raw HTML using structured data (no JS rendering needed). */
export function extractPriceFromHtml(
  html: string,
): { price: number | null; currency: string | null } {
  // Strategy 1: JSON-LD structured data
  const jsonLdResult = extractFromJsonLd(html);
  if (jsonLdResult.price !== null) {
    console.log(`[price-extract] JSON-LD: ${jsonLdResult.currency}${jsonLdResult.price}`);
    return jsonLdResult;
  }

  // Strategy 2: Meta tags (Open Graph, product)
  const metaResult = extractFromMetaTags(html);
  if (metaResult.price !== null) {
    console.log(`[price-extract] Meta tag: ${metaResult.currency}${metaResult.price}`);
    return metaResult;
  }

  // Strategy 3: Regex on visible text (least reliable)
  return extractFromRegex(html);
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

const JSON_LD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractFromJsonLd(
  html: string,
): { price: number | null; currency: string | null } {
  // Use matchAll to avoid shared mutable lastIndex state under concurrency
  const blocks = [...html.matchAll(JSON_LD_RE)].map((m) => m[1]);

  for (const block of blocks) {
    try {
      const data = JSON.parse(block);
      const result = extractPriceFromJsonLdObject(data);
      if (result.price !== null) return result;
    } catch {
      // malformed JSON-LD, skip
    }
  }

  return { price: null, currency: null };
}

function extractPriceFromJsonLdObject(
  obj: unknown,
): { price: number | null; currency: string | null } {
  if (!obj || typeof obj !== "object") return { price: null, currency: null };

  // Handle @graph arrays
  if ("@graph" in (obj as Record<string, unknown>)) {
    const graph = (obj as Record<string, unknown>)["@graph"];
    if (Array.isArray(graph)) {
      for (const item of graph) {
        const result = extractPriceFromJsonLdObject(item);
        if (result.price !== null) return result;
      }
    }
    return { price: null, currency: null };
  }

  // Handle arrays at top level
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = extractPriceFromJsonLdObject(item);
      if (result.price !== null) return result;
    }
    return { price: null, currency: null };
  }

  const record = obj as Record<string, unknown>;
  const type = record["@type"];

  // Only extract from Product types (handle array form: ["Product", "ItemPage"])
  const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (!isProduct) return { price: null, currency: null };

  const offers = record["offers"];
  if (!offers || typeof offers !== "object") return { price: null, currency: null };

  return extractPriceFromOffer(offers as Record<string, unknown> | unknown[]);
}

function extractPriceFromOffer(
  offer: Record<string, unknown> | unknown[],
): { price: number | null; currency: string | null } {
  // Handle array of offers — take the first one with a price
  if (Array.isArray(offer)) {
    for (const o of offer) {
      if (typeof o === "object" && o !== null) {
        const result = extractPriceFromOffer(o as Record<string, unknown>);
        if (result.price !== null) return result;
      }
    }
    return { price: null, currency: null };
  }

  const currency = typeof offer["priceCurrency"] === "string" ? offer["priceCurrency"] : null;

  // AggregateOffer — prefer lowPrice
  if (offer["@type"] === "AggregateOffer" && offer["lowPrice"] !== undefined) {
    const price = toNumber(offer["lowPrice"]);
    if (price !== null) return { price, currency };
  }

  // Standard Offer
  if (offer["price"] !== undefined) {
    const price = toNumber(offer["price"]);
    if (price !== null) return { price, currency };
  }

  return { price: null, currency: null };
}

// ── Meta Tags ────────────────────────────────────────────────────────────────

const META_PRICE_RE =
  /<meta\s+(?:[^>]*?)property\s*=\s*["'](?:og|product):price:amount["']\s+content\s*=\s*["']([^"']+)["']/i;
const META_CURRENCY_RE =
  /<meta\s+(?:[^>]*?)property\s*=\s*["'](?:og|product):price:currency["']\s+content\s*=\s*["']([^"']+)["']/i;

// Also match reverse attribute order: content before property
const META_PRICE_REV_RE =
  /<meta\s+(?:[^>]*?)content\s*=\s*["']([^"']+)["']\s+property\s*=\s*["'](?:og|product):price:amount["']/i;
const META_CURRENCY_REV_RE =
  /<meta\s+(?:[^>]*?)content\s*=\s*["']([^"']+)["']\s+property\s*=\s*["'](?:og|product):price:currency["']/i;

function extractFromMetaTags(
  html: string,
): { price: number | null; currency: string | null } {
  const priceMatch = html.match(META_PRICE_RE) ?? html.match(META_PRICE_REV_RE);
  if (!priceMatch) return { price: null, currency: null };

  const price = toNumber(priceMatch[1]);
  if (price === null) return { price: null, currency: null };

  const currencyMatch = html.match(META_CURRENCY_RE) ?? html.match(META_CURRENCY_REV_RE);
  const currency = currencyMatch?.[1] ?? null;

  return { price, currency };
}

// ── Regex Fallback ───────────────────────────────────────────────────────────

const PRICE_PATTERNS = [
  // "$29.99" or "$ 29.99"
  { re: /\$\s*([\d,]+(?:\.\d{1,2})?)/, currency: "USD" },
  { re: /£\s*([\d,]+(?:\.\d{1,2})?)/, currency: "GBP" },
  { re: /€\s*([\d,]+(?:\.\d{1,2})?)/, currency: "EUR" },
];

// Minimum price to accept from regex fallback — avoids false positives
// from coupon text ("Save $10"), quantity selectors, shipping costs, etc.
const MIN_REGEX_PRICE = 3;

function extractFromRegex(
  html: string,
): { price: number | null; currency: string | null } {
  // Strip script/style tags to avoid matching JS variables
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  // Also strip common non-price contexts
  const cleaned = visible
    .replace(/save\s*\$\s*[\d,.]+/gi, "")
    .replace(/off\s*\$\s*[\d,.]+/gi, "")
    .replace(/coupon\s*\$\s*[\d,.]+/gi, "")
    .replace(/\$\s*[\d,.]+\s*off/gi, "")
    .replace(/\$\s*[\d,.]+\s*coupon/gi, "")
    .replace(/shipping\s*\$\s*[\d,.]+/gi, "");

  for (const { re, currency } of PRICE_PATTERNS) {
    const allMatches = [...cleaned.matchAll(new RegExp(re.source, "g"))];

    // Collect all valid prices and count frequency
    const priceCounts = new Map<number, number>();
    for (const match of allMatches) {
      const price = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(price) && price >= MIN_REGEX_PRICE) {
        priceCounts.set(price, (priceCounts.get(price) ?? 0) + 1);
      }
    }

    if (priceCounts.size === 0) continue;

    // Pick the most frequent price; break ties by preferring higher price
    let bestPrice = 0;
    let bestCount = 0;
    for (const [price, count] of priceCounts) {
      if (count > bestCount || (count === bestCount && price > bestPrice)) {
        bestPrice = price;
        bestCount = count;
      }
    }

    console.log(`[price-extract] Regex: matched ${currency}${bestPrice} (${bestCount}x from ${allMatches.length} candidates)`);
    return { price: bestPrice, currency };
  }

  return { price: null, currency: null };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.replace(/,/g, ""));
    if (!isNaN(n) && isFinite(n) && n > 0) return n;
  }
  return null;
}
