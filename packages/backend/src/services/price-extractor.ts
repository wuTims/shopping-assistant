import { PRICE_HTTP_TIMEOUT_MS } from "@shopping-assistant/shared";

const FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Patterns in visible page text that indicate a product is stale/unavailable.
 * These sites return HTTP 200 but show "unavailable" in the body.
 */
const STALE_BODY_PATTERNS = [
  /sorry,?\s*this\s+item\s+is\s+(currently\s+)?unavailable/i,
  /this\s+(product|item)\s+is\s+(currently\s+)?(no longer|not)\s+available/i,
  /this\s+(product|item)\s+(has been|was)\s+(removed|discontinued)/i,
  /oops!?\s*that['']?s?\s+out\s+of\s+stock/i, // Zappos
  /currently\s+unavailable\.?\s*highly\s+related/i, // DHGate
  /this\s+page\s+(doesn['']?t|does not|no longer)\s+exist/i,
  /the\s+item\s+you['']?(re| are)\s+(looking|searching)\s+for\s+(has been|is no longer)/i,
  // Amazon: "Currently unavailable. We don't know when or if this item will be back in stock."
  /currently\s+unavailable[\s\S]{0,200}we\s+don[''\u2019]?t\s+know\s+when/i,
  // Lowes: "we couldn't find that page" / "this item is unavailable"
  /we\s+(couldn[''\u2019]?t|could\s+not)\s+find\s+(that|this)\s+(page|product|item)/i,
  // Lowes: "This item is no longer sold on Lowes.com"
  /this\s+item\s+is\s+no\s+longer\s+sold/i,
  // Etsy: "Sorry, this item and shop are currently unavailable"
  /sorry,?\s*this\s+item\s+and\s+shop\s+are?\s+(currently\s+)?unavailable/i,
  // Generic 404 / removed patterns
  /page\s+(not\s+found|cannot\s+be\s+found|you\s+requested\s+(was|is)\s+not\s+found)/i,
];

/** Check if HTML body contains signals that the product is stale/unavailable. */
export function detectStaleContent(html: string): boolean {
  // Strip scripts and styles to avoid false positives from JS code
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  return STALE_BODY_PATTERNS.some((pattern) => pattern.test(visible));
}

/** Fetch a URL via lightweight HTTP and extract price from structured data in HTML. */
export async function fetchAndExtractPrice(
  url: string,
): Promise<{ price: number | null; currency: string | null; httpStatus: number | null; stale?: boolean }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(PRICE_HTTP_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!res.ok) return { price: null, currency: null, httpStatus: res.status };

    const html = await res.text();
    const stale = detectStaleContent(html);
    if (stale) {
      console.log(`[price-extract] Stale content detected: ${new URL(url).hostname}`);
      return { price: null, currency: null, httpStatus: res.status, stale: true };
    }

    const result = extractPriceFromHtml(html);
    return { ...result, httpStatus: res.status };
  } catch {
    return { price: null, currency: null, httpStatus: null };
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

  // Strategy 2: Microdata (itemprop="price" / itemprop="priceCurrency")
  const microdataResult = extractFromMicrodata(html);
  if (microdataResult.price !== null) {
    console.log(`[price-extract] Microdata: ${microdataResult.currency}${microdataResult.price}`);
    return microdataResult;
  }

  // Strategy 3: Meta tags (Open Graph, product)
  const metaResult = extractFromMetaTags(html);
  if (metaResult.price !== null) {
    console.log(`[price-extract] Meta tag: ${metaResult.currency}${metaResult.price}`);
    return metaResult;
  }

  // Strategy 4: Embedded script data (__NEXT_DATA__, React hydration, etc.)
  const embeddedResult = extractFromEmbeddedScripts(html);
  if (embeddedResult.price !== null) {
    console.log(`[price-extract] Embedded script: ${embeddedResult.currency}${embeddedResult.price}`);
    return embeddedResult;
  }

  // Strategy 5: Regex on visible text (least reliable)
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

// ── Microdata (itemprop) ─────────────────────────────────────────────────────

// itemprop="price" with content attribute: <meta itemprop="price" content="499.00">
const MICRODATA_PRICE_CONTENT_RE =
  /<[^>]+itemprop\s*=\s*["']price["'][^>]+content\s*=\s*["']([^"']+)["']/i;
const MICRODATA_PRICE_CONTENT_REV_RE =
  /<[^>]+content\s*=\s*["']([^"']+)["'][^>]+itemprop\s*=\s*["']price["']/i;

// itemprop="price" with text content: <span itemprop="price">$499.00</span>
const MICRODATA_PRICE_TEXT_RE =
  /<[^>]+itemprop\s*=\s*["']price["'][^>]*>([^<]+)</i;

// itemprop="priceCurrency" with content attribute
const MICRODATA_CURRENCY_RE =
  /<[^>]+itemprop\s*=\s*["']priceCurrency["'][^>]+content\s*=\s*["']([^"']+)["']/i;
const MICRODATA_CURRENCY_REV_RE =
  /<[^>]+content\s*=\s*["']([^"']+)["'][^>]+itemprop\s*=\s*["']priceCurrency["']/i;

function extractFromMicrodata(
  html: string,
): { price: number | null; currency: string | null } {
  // Try content attribute first (most reliable — numeric value, no parsing needed)
  let priceStr: string | null = null;

  const contentMatch = html.match(MICRODATA_PRICE_CONTENT_RE)
    ?? html.match(MICRODATA_PRICE_CONTENT_REV_RE);
  if (contentMatch) {
    priceStr = contentMatch[1];
  }

  // Fall back to element text content: <span itemprop="price">$499.00</span>
  if (!priceStr) {
    const textMatch = html.match(MICRODATA_PRICE_TEXT_RE);
    if (textMatch) {
      const text = textMatch[1].trim();
      // Extract numeric value from text like "$499.00", "499.00", "US $260.83"
      const numMatch = text.match(/[\d,]+(?:\.\d{1,2})?/);
      if (numMatch) priceStr = numMatch[0];
    }
  }

  if (!priceStr) return { price: null, currency: null };

  const price = toNumber(priceStr);
  if (price === null) return { price: null, currency: null };

  // Extract currency
  const currMatch = html.match(MICRODATA_CURRENCY_RE)
    ?? html.match(MICRODATA_CURRENCY_REV_RE);
  const currency = currMatch?.[1] ?? null;

  return { price, currency };
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

// ── Embedded Script Data ──────────────────────────────────────────────────

/**
 * Extract price from embedded JSON data in script tags.
 * Modern sites (Walmart, Home Depot, etc.) often embed product data in
 * __NEXT_DATA__ (Next.js) or similar hydration scripts rather than
 * standard JSON-LD / microdata.
 */
function extractFromEmbeddedScripts(
  html: string,
): { price: number | null; currency: string | null } {
  // Pattern 1: Next.js __NEXT_DATA__ JSON blob
  const nextDataMatch = html.match(
    /<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextDataMatch) {
    const result = searchScriptForPrice(nextDataMatch[1]);
    if (result.price !== null) return result;
  }

  // Pattern 2: window.__PRELOADED_STATE__ / __INITIAL_STATE__
  const stateMatches = html.matchAll(
    /window\.__(?:PRELOADED_STATE|INITIAL_STATE|INITIAL_DATA)__\s*=\s*([\s\S]*?);?\s*<\/script>/gi,
  );
  for (const [, content] of stateMatches) {
    const result = searchScriptForPrice(content);
    if (result.price !== null) return result;
  }

  return { price: null, currency: null };
}

/**
 * Search a serialized JSON string for common e-commerce price field patterns.
 * Uses targeted regexes on the raw text to avoid parsing multi-megabyte blobs.
 */
function searchScriptForPrice(
  text: string,
): { price: number | null; currency: string | null } {
  // Try to find currency first (reused across patterns)
  const findCurrency = (): string | null => {
    const m = text.match(/"(?:price)?[Cc]urrency(?:Code)?":\s*"([A-Z]{3})"/);
    return m?.[1] ?? null;
  };

  // "priceString":"$11.49" / "formattedPrice":"$949.04" — very reliable
  const formattedMatch = text.match(
    /"(?:priceString|formattedPrice|displayPrice)":\s*"[£€$]?\s*([\d,]+(?:\.\d{1,2})?)"/,
  );
  if (formattedMatch) {
    const price = parseFloat(formattedMatch[1].replace(/,/g, ""));
    if (isFinite(price) && price > 0) return { price, currency: findCurrency() };
  }

  // "currentPrice":{"price":11.49,...} — Walmart nested pattern
  const nestedMatch = text.match(
    /"currentPrice":\s*\{[^}]*?"price":\s*"?([\d]+(?:\.[\d]{1,2})?)"?/,
  );
  if (nestedMatch) {
    const price = parseFloat(nestedMatch[1]);
    if (isFinite(price) && price > 0) return { price, currency: findCurrency() };
  }

  // "salePrice" / "offerPrice" / "finalPrice" / "specialPrice" — flat fields
  const flatMatch = text.match(
    /"(?:salePrice|offerPrice|finalPrice|specialPrice)":\s*"?([\d]+(?:\.[\d]{1,2})?)"?/,
  );
  if (flatMatch) {
    const price = parseFloat(flatMatch[1]);
    if (isFinite(price) && price > 0) return { price, currency: findCurrency() };
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
