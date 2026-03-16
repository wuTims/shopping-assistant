import type {
  ResultUrlClassification,
  ResultValidationStatus,
  SearchResult,
} from "@shopping-assistant/shared";

const SEARCH_PATTERNS = [
  /[?&](q|query|keyword|search|st)=/i,
  /\/search(?:\/|$)/i,
  /\/searchpage(?:\.jsp)?(?:\/|$)/i,
];

const CATEGORY_PATTERNS = [
  /\/browse(?:\/|$)/i,
  /\/category(?:\/|$)/i,
  /\/collections?(?:\/|$)/i,
  /\/c(?:\/|$)/i,
  /\/b(?:\/|$)/i,
];

const STOREFRONT_PATTERNS = [
  /\/shop(?:\/|$)/i,
  /\/stores?(?:\/|$)/i,
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

export function isDisplayableCandidate(result: SearchResult): boolean {
  const validationStatus = result.validationStatus ?? resolveValidationStatus(result.urlClassification ?? "unknown");
  return validationStatus !== "invalid";
}
