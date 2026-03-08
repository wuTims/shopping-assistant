const MARKETPLACE_NAMES: Record<string, string> = {
  "amazon.com": "Amazon",
  "amazon.co.uk": "Amazon UK",
  "amazon.de": "Amazon DE",
  "amazon.ca": "Amazon CA",
  "amazon.co.jp": "Amazon JP",
  "amazon.in": "Amazon IN",
  "ebay.com": "eBay",
  "ebay.co.uk": "eBay UK",
  "ebay.de": "eBay DE",
  "aliexpress.com": "AliExpress",
  "dhgate.com": "DHgate",
  "temu.com": "Temu",
  "1688.com": "1688",
  "walmart.com": "Walmart",
  "target.com": "Target",
  "bestbuy.com": "Best Buy",
  "newegg.com": "Newegg",
  "etsy.com": "Etsy",
  "homedepot.com": "Home Depot",
  "lowes.com": "Lowe's",
  "costco.com": "Costco",
  "wayfair.com": "Wayfair",
  "overstock.com": "Overstock",
  "bhphotovideo.com": "B&H Photo",
  "adorama.com": "Adorama",
  "zappos.com": "Zappos",
  "nordstrom.com": "Nordstrom",
  "macys.com": "Macy's",
  "kohls.com": "Kohl's",
};

/**
 * Extract a human-readable marketplace name from a URL.
 * Falls back to the hostname if no known marketplace matches.
 */
export function extractMarketplace(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");

    // Check exact match first
    if (MARKETPLACE_NAMES[hostname]) {
      return MARKETPLACE_NAMES[hostname];
    }

    // Check if hostname ends with a known marketplace domain
    for (const [domain, name] of Object.entries(MARKETPLACE_NAMES)) {
      if (hostname.endsWith(`.${domain}`) || hostname === domain) {
        return name;
      }
    }

    // Fallback: extract the registrable domain name, handling multi-part TLDs
    // Common two-part TLDs where the SLD is not the brand name
    const MULTI_PART_TLDS = new Set([
      "co.uk", "co.jp", "co.kr", "co.nz", "co.za", "co.in", "co.id",
      "com.au", "com.br", "com.mx", "com.sg", "com.tw", "com.hk",
      "org.uk", "net.au", "ac.uk",
    ]);
    const parts = hostname.split(".");
    let main: string;
    if (parts.length >= 3) {
      const lastTwo = parts.slice(-2).join(".");
      main = MULTI_PART_TLDS.has(lastTwo) ? parts[parts.length - 3] : parts[parts.length - 2];
    } else {
      main = parts[0];
    }
    return main.charAt(0).toUpperCase() + main.slice(1);
  } catch {
    return "Unknown";
  }
}
