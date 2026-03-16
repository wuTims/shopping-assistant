import type {
  ResultUrlClassification,
  ResultValidationStatus,
  SearchResult,
} from "@shopping-assistant/shared";

const SEARCH_PATTERNS = [
  /[?&](q|query|keyword|search|st|k|searchTerm|_nkw|SearchText|search_key)=/i,
  /[?&]oosRedirected=true/i, // Zappos OOS redirect to search (e.g. ?oosRedirected=true)
  /\/search(?:\/|$)/i,
  /\/searchpage(?:\.jsp)?(?:\/|$)/i,
  /\/s(?:\/|$)/i, // Amazon, Target search results
  /\/sch(?:\/|$)/i, // eBay search results
  /\/sr(?:\/|$)/i, // Nordstrom search results (/sr?keyword=...)
  /\/search_result\.html/i, // Temu search results
];

const CATEGORY_PATTERNS = [
  /\/browse(?:\/|$)/i,
  /\/category(?:\/|$)/i,
  /\/catalog(?:\/|$)/i, // Kohl's catalog pages (e.g. /catalog/womens-blue-dresses-clothing.jsp)
  /\/collections?(?:\/|$)/i,
  /\/c(?:\/|$)/i,
  /\/b(?:\/|$)/i,
  /\/market(?:\/|$)/i, // Etsy market/browse pages
  /\/brands?(?:\/|$)/i, // Nordstrom, Poshmark, etc. brand listing pages
  /\/wholesale(?:\/|$)/i, // DHgate wholesale listing pages
  /\/w\/wholesale/i, // AliExpress wholesale search (/w/wholesale-keyword.html)
  /\/cp(?:\/|$)/i, // Walmart category/content pages
  /\/deals(?:\/|$)/i, // Generic deals listing pages
  /\/designer(?:\/|$)/i, // Lyst designer/brand pages
];

const STOREFRONT_PATTERNS = [
  /\/shop(?:\/|$)/i,
  /\/stores?(?:\/|$)/i,
  /\/closet(?:\/|$)/i, // Poshmark seller closets
  /\/str(?:\/|$)/i, // eBay seller stores
];

const SELLER_STORE_PATTERNS = [
  /(^|\.)aliexpress\.com$/i,
  /(^|\.)alibaba\.com$/i,
  /(^|\.)etsy\.com$/i,
];

const PRODUCT_DETAIL_PATTERNS: Array<{ host: RegExp; path: RegExp }> = [
  { host: /(^|\.)walmart\.com$/i, path: /^\/ip(?:\/|$)/i },
  { host: /(^|\.)amazon\./i, path: /^\/(?:dp|gp\/product)(?:\/|$)/i },
  { host: /(^|\.)ebay\./i, path: /^\/itm(?:\/|$)/i },
  { host: /(^|\.)target\.com$/i, path: /^\/p\/(?:-|$)/i },
  { host: /(^|\.)bestbuy\.com$/i, path: /^\/site\/(?!searchpage)/i },
  { host: /(^|\.)homedepot\.com$/i, path: /^\/p\/(?:-|$)/i },
  { host: /(^|\.)lowes\.com$/i, path: /^\/pd\/(?:-|$)/i },
  { host: /(^|\.)etsy\.com$/i, path: /^\/listing\/\d+/i },
  { host: /(^|\.)aliexpress\.com$/i, path: /^\/item\/(?:-|$|[\w-]+\.html)/i },
  // Nordstrom uses /s/<slug>/<numeric_id> for products — must whitelist before
  // the generic /s search pattern catches it
  { host: /(^|\.)nordstrom\.com$/i, path: /^\/s\/[^/]+\/\d+/i },
  { host: /(^|\.)poshmark\.com$/i, path: /^\/listing\//i },
  { host: /(^|\.)mercari\.com$/i, path: /^(?:\/us)?\/item\//i },
  { host: /(^|\.)depop\.com$/i, path: /^\/products\//i },
  { host: /(^|\.)dhgate\.com$/i, path: /^\/product\//i },
  { host: /(^|\.)macys\.com$/i, path: /^\/shop\/product\//i },
];

export function classifyResultUrl(url: string): ResultUrlClassification {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, "");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const href = `${path}${parsed.search}`;

    for (const { host, path: productPath } of PRODUCT_DETAIL_PATTERNS) {
      if (host.test(hostname) && productPath.test(path)) {
        return "product_detail";
      }
    }

    if (SEARCH_PATTERNS.some((pattern) => pattern.test(href))) {
      return "search_results";
    }

    if (CATEGORY_PATTERNS.some((pattern) => pattern.test(path))) {
      return "category_listing";
    }

    if (hostname.endsWith("aliexpress.com") && /^\/store\/\d+/i.test(path)) {
      return "seller_store";
    }

    if (SELLER_STORE_PATTERNS.some((pattern) => pattern.test(hostname)) && /\/store(s)?(?:\/|$)/i.test(path)) {
      return "seller_store";
    }

    if (STOREFRONT_PATTERNS.some((pattern) => pattern.test(path))) {
      return "store_front";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

export function resolveValidationStatus(urlClassification: ResultUrlClassification): ResultValidationStatus {
  if (urlClassification === "product_detail") return "valid";
  if (urlClassification === "unknown") return "unknown";
  return "invalid";
}

export function annotateResultValidation(result: SearchResult): SearchResult {
  const urlClassification = result.urlClassification ?? classifyResultUrl(result.productUrl);
  return {
    ...result,
    urlClassification,
    priceSource: result.priceSource ?? "none",
    validationStatus: result.validationStatus ?? resolveValidationStatus(urlClassification),
  };
}

/**
 * Titles that indicate a non-purchasable digital product (PDF sewing patterns,
 * tutorials, etc.) rather than the physical product the user is looking for.
 */
const NON_PURCHASABLE_TITLE_RE =
  /\b(pdf|digital)\s+(dress|sewing|knitting|crochet)\s+pattern\b|\bsewing\s+pattern\s+(for|pdf)\b/i;

/**
 * Titles that are just the marketplace/site name — not a real product title.
 * These come from 1688.com results where Brave can't extract a useful title.
 */
const MARKETPLACE_ONLY_TITLES = new Set([
  "1688", "alibaba", "aliexpress", "amazon", "ebay", "walmart",
  "target", "etsy", "dhgate", "temu", "taobao",
]);

function hasUsableTitle(result: SearchResult): boolean {
  const title = result.title.trim();
  if (title.length < 2) return false;
  if (MARKETPLACE_ONLY_TITLES.has(title.toLowerCase())) return false;
  if (NON_PURCHASABLE_TITLE_RE.test(title)) return false;
  return true;
}

export function isDisplayableCandidate(result: SearchResult): boolean {
  const validationStatus = result.validationStatus ?? resolveValidationStatus(result.urlClassification ?? "unknown");
  if (validationStatus === "invalid") return false;
  if (!hasUsableTitle(result)) return false;
  return true;
}
