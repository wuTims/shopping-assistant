/** Extract price from raw HTML using structured data (no JS rendering needed). */
export function extractPriceFromHtml(
  html: string,
): { price: number | null; currency: string | null } {
  // Strategy 1: JSON-LD structured data
  const jsonLdResult = extractFromJsonLd(html);
  if (jsonLdResult.price !== null) return jsonLdResult;

  // Strategy 2: Meta tags (Open Graph, product)
  const metaResult = extractFromMetaTags(html);
  if (metaResult.price !== null) return metaResult;

  // Strategy 3: Regex on visible text (least reliable)
  return extractFromRegex(html);
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────

const JSON_LD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractFromJsonLd(
  html: string,
): { price: number | null; currency: string | null } {
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = JSON_LD_RE.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  JSON_LD_RE.lastIndex = 0; // reset for next call

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

  // Only extract from Product types
  if (type !== "Product") return { price: null, currency: null };

  const offers = record["offers"];
  if (!offers || typeof offers !== "object") return { price: null, currency: null };

  return extractPriceFromOffer(offers as Record<string, unknown>);
}

function extractPriceFromOffer(
  offer: Record<string, unknown>,
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

function extractFromRegex(
  html: string,
): { price: number | null; currency: string | null } {
  // Strip script/style tags to avoid matching JS variables
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  for (const { re, currency } of PRICE_PATTERNS) {
    const match = visible.match(re);
    if (match) {
      const price = parseFloat(match[1].replace(/,/g, ""));
      if (!isNaN(price) && price > 0) {
        return { price, currency };
      }
    }
  }

  return { price: null, currency: null };
}

// ── Utilities ────────────────────────────────────────────────────────────────

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseFloat(value.replace(/,/g, ""));
    if (!isNaN(n) && isFinite(n)) return n;
  }
  return null;
}
