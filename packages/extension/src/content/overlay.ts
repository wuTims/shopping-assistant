import {
  OVERLAY_ICON_SIZE_PX,
  OVERLAY_ICON_HOVER_SIZE_PX,
  MIN_IMAGE_SIZE_PX,
  OVERLAY_TITLE_HINT_MAX_LENGTH,
  OVERLAY_HIDE_DELAY_MS,
} from "@shopping-assistant/shared";

const OVERLAY_HOVER_SCALE = OVERLAY_ICON_HOVER_SIZE_PX / OVERLAY_ICON_SIZE_PX;
const BOUND_ATTR = "data-shopping-assistant-bound";
const OVERLAY_ATTR = "data-shopping-assistant-overlay";

const MIN_BG_IMAGE_SIZE_PX = 80;

const PRICE_RE = /\$\s*([\d,]+(?:\.\d{1,2})?)/;
const PRICE_CURRENCY_MAP: Record<string, string> = { "$": "USD", "£": "GBP", "€": "EUR" };

/**
 * Extract product price from DOM elements near the clicked image.
 * Walks up from the image to find the nearest product container and
 * looks for price-like text in the visible DOM.
 */
function extractPriceFromDom(element: Element): { price: number | null; currency: string | null } {
  // Look for a product-like container (widening search)
  const containers = [
    element.closest("[data-price], [data-product-price]"),
    element.closest("article, [data-product], [data-testid*='product'], [class*='product']"),
    element.closest("li, .card, .item"),
    element.parentElement?.parentElement,
  ].filter(Boolean) as Element[];

  for (const container of containers) {
    // Check data attributes first (most reliable)
    for (const attr of ["data-price", "data-product-price", "data-sale-price"]) {
      const el = container.querySelector(`[${attr}]`) ?? (container.hasAttribute(attr) ? container : null);
      if (el) {
        const val = parseFloat(el.getAttribute(attr) ?? "");
        if (!isNaN(val) && val > 0) {
          return { price: val, currency: "USD" };
        }
      }
    }

    // Look for structured price elements
    const priceSelectors = [
      ".price-current", ".sale-price", ".now-price", "[class*='sale']",
      ".price", "[class*='price']", "[data-testid*='price']",
      "span[class*='Price']",
    ];

    for (const selector of priceSelectors) {
      const priceEls = container.querySelectorAll(selector);
      for (const priceEl of priceEls) {
        const text = (priceEl as HTMLElement).innerText?.trim();
        if (!text) continue;
        const match = text.match(PRICE_RE);
        if (match) {
          const price = parseFloat(match[1].replace(/,/g, ""));
          if (!isNaN(price) && price >= 1) {
            const symbolMatch = text.match(/[$£€]/);
            const currency = symbolMatch ? PRICE_CURRENCY_MAP[symbolMatch[0]] ?? "USD" : "USD";
            return { price, currency };
          }
        }
      }
    }
  }

  // Last resort: check page-level structured data (JSON-LD)
  const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent ?? "");
      const price = extractPriceFromJsonLd(data);
      if (price) return price;
    } catch { /* skip malformed */ }
  }

  return { price: null, currency: null };
}

function extractPriceFromJsonLd(obj: unknown): { price: number; currency: string } | null {
  if (!obj || typeof obj !== "object") return null;
  const record = obj as Record<string, unknown>;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = extractPriceFromJsonLd(item);
      if (result) return result;
    }
    return null;
  }

  if ("@graph" in record && Array.isArray(record["@graph"])) {
    for (const item of record["@graph"]) {
      const result = extractPriceFromJsonLd(item);
      if (result) return result;
    }
    return null;
  }

  const type = record["@type"];
  const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (!isProduct) return null;

  const offers = record["offers"];
  if (!offers || typeof offers !== "object") return null;

  const offer = Array.isArray(offers) ? offers[0] : offers;
  if (!offer || typeof offer !== "object") return null;

  const o = offer as Record<string, unknown>;
  const currency = typeof o["priceCurrency"] === "string" ? o["priceCurrency"] : "USD";
  const priceVal = o["price"] ?? o["lowPrice"];
  const price = typeof priceVal === "number" ? priceVal : parseFloat(String(priceVal ?? ""));
  if (!isNaN(price) && price > 0) return { price, currency };

  return null;
}

/**
 * Extract a product title from DOM elements near the clicked image.
 *
 * On listing / search / homepage carousels the <img> is often wrapped in a
 * minimal <a> or <div> that has NO text.  We try cheap attribute-based
 * signals first (alt, aria-label, link title), then walk up the DOM only
 * if needed — reading existing text rather than cloning subtrees.
 *
 * When all DOM text extraction fails, falls back to parsing the product
 * URL slug from the nearest <a> href (e.g. /itm/Navy-Blue-Dress/123 →
 * "Navy Blue Dress").
 */
const TITLE_NOISE_RE = /^(\$|£|€|¥|add to|buy|shop|free|sponsored|ad$)/i;
function isTitleUseful(t: string): boolean {
  return t.length > 3 && t.length < 300 && !TITLE_NOISE_RE.test(t);
}

/**
 * Extract a human-readable product title from a URL slug.
 * Works on most marketplaces:
 *   /itm/Navy-Blue-Floral-Midi-Dress/123  → "Navy Blue Floral Midi Dress"
 *   /listing/123/navy-blue-dress           → "navy blue dress"
 *   /ip/Some-Product-Name/456             → "Some Product Name"
 *   /dp/B09XYZ                            → null (no slug)
 */
function extractTitleFromHref(href: string): string | null {
  try {
    const url = new URL(href, location.origin);
    const segments = url.pathname.split("/").filter(Boolean);

    let best: string | null = null;
    for (const seg of segments) {
      // Skip numeric-only segments (product IDs)
      if (/^\d+$/.test(seg)) continue;
      // Skip short ASIN-like segments (e.g. B09XYZ)
      if (seg.length < 8) continue;
      // Require at least 3 hyphen- or underscore-separated words
      const words = seg.split(/[-_+]/).filter((w) => w.length > 0 && !/^\d+$/.test(w));
      if (words.length < 3) continue;
      // Strip file extensions (.html, .htm, .jsp)
      const title = words.join(" ").replace(/\.(html?|jsp|aspx?|php)$/i, "").trim();
      if (!best || title.length > best.length) {
        best = title;
      }
    }
    return best && isTitleUseful(best) ? best.slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH) : null;
  } catch {
    return null;
  }
}

/**
 * Check common data-* attributes on an element for a product title.
 */
const TITLE_DATA_ATTRS = ["data-title", "data-name", "data-product-name", "data-product-title", "data-item-name"];
function extractTitleFromDataAttrs(el: Element): string | null {
  for (const attr of TITLE_DATA_ATTRS) {
    const val = el.getAttribute(attr)?.trim();
    if (val && isTitleUseful(val)) return val.slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH);
  }
  return null;
}

/**
 * Detect generic page titles that are site taglines / homepages rather than
 * product names. Safety net for document.title fallback.
 */
const GENERIC_PAGE_TITLE_RE =
  /^(electronics|shop\b|shopping|browse|deals|welcome|home|search|new arrivals|trending|sale|best sellers)/i;
const CATEGORY_LIST_RE = /^[\w\s]+,\s*[\w\s]+,\s*[\w\s]+/;
const MARKETPLACE_SUFFIX_RE =
  /\s*[-–|:]\s*(Amazon|eBay|Walmart|Target|Best Buy|Etsy|AliExpress|Macy'?s|Nordstrom|Kohl'?s|Zappos|DHgate|Temu|1688|Taobao).*$/i;

function isGenericPageTitle(title: string): boolean {
  const cleaned = title.replace(MARKETPLACE_SUFFIX_RE, "").trim();
  if (cleaned.length < 5) return true;
  if (GENERIC_PAGE_TITLE_RE.test(cleaned)) return true;
  if (CATEGORY_LIST_RE.test(cleaned)) return true;
  return false;
}

const MAX_WALK = 6;
const TITLE_SELECTOR = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "[class*='title' i]", "[class*='name' i]",
  "[class*='Title']", "[class*='Name']",
  "[class*='description' i]", "[class*='label' i]",
  "a[title]",
].join(", ");
const CARD_BOUNDARY = [
  "li", "article",
  "[data-product]", "[data-item]", "[data-testid*='product']",
  "[class*='product' i]", "[class*='card' i]", "[class*='item' i]",
  "[class*='result' i]", "[class*='listing' i]", "[class*='tile' i]",
  "[class*='module' i]", "[class*='carousel' i]",
].join(", ");

function extractTitleFromDom(positionTarget: HTMLElement, img: HTMLImageElement): string | null {
  // 1. Cheapest: img alt text (often the product name on listing pages)
  const alt = img.alt?.trim();
  if (alt && isTitleUseful(alt)) return alt.slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH);

  // 2. Data attributes on the image or its immediate container
  const fromImgData = extractTitleFromDataAttrs(img);
  if (fromImgData) return fromImgData;

  // 3. Closest <a> — title attribute or visible text
  const link = positionTarget.closest("a") as HTMLAnchorElement | null;
  if (link) {
    const linkTitle = link.title?.trim();
    if (linkTitle && isTitleUseful(linkTitle)) return linkTitle.slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH);

    const fromLinkData = extractTitleFromDataAttrs(link);
    if (fromLinkData) return fromLinkData;

    const linkText = link.textContent?.trim();
    if (linkText && isTitleUseful(linkText)) return linkText.slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH);
  }

  // 4. Walk up the DOM looking for title-carrying elements (headings, aria-labels, title classes).
  //    Single querySelectorAll per level — no cloneNode, no innerText on large subtrees.
  let current: HTMLElement | null = positionTarget;
  for (let depth = 0; depth < MAX_WALK && current && current !== document.body; depth++) {
    current = current.parentElement;
    if (!current) break;

    // Check data attributes on container
    const fromData = extractTitleFromDataAttrs(current);
    if (fromData) return fromData;

    // Check for aria-label on the container itself
    const ariaLabel = current.getAttribute("aria-label")?.trim();
    if (ariaLabel && isTitleUseful(ariaLabel)) return ariaLabel.slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH);

    // Look for title-carrying child elements
    for (const el of current.querySelectorAll<HTMLElement>(TITLE_SELECTOR)) {
      if (el.closest(`[${OVERLAY_ATTR}]`)) continue;
      const text = (el.getAttribute("title") || el.textContent || "").trim();
      if (isTitleUseful(text)) return text.slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH);
    }

    // At card boundary, try the container's own textContent as last resort at this level
    if (current.matches(CARD_BOUNDARY)) {
      const cardText = current.textContent?.trim();
      if (cardText) {
        // Take the first non-noise line from the card's text
        const firstLine = cardText.split(/\n/).map((l) => l.trim()).find(isTitleUseful);
        if (firstLine) return firstLine.slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH);
      }
      break;
    }
  }

  // 5. Parse product title from the nearest link's URL slug.
  //    On listing pages, the <a> wrapping the image often has a descriptive href
  //    like /itm/Navy-Blue-Floral-Midi-Dress/123 even when the link has no text.
  const productLink = link ?? positionTarget.closest("a") as HTMLAnchorElement | null;
  if (productLink?.href) {
    const fromHref = extractTitleFromHref(productLink.href);
    if (fromHref) return fromHref;
  }
  // Also check any link in the card boundary ancestor
  if (current && current !== document.body) {
    for (const a of current.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (a === productLink) continue;
      const fromHref = extractTitleFromHref(a.href);
      if (fromHref) return fromHref;
    }
  }

  // 6. Last resort: page title (only useful on product detail pages, not
  //    store homepages, search pages, or category listings)
  const pageTitle = document.title?.trim();
  if (pageTitle && !isGenericPageTitle(pageTitle)) return pageTitle;
  return null;
}

/** Convert an image element to base64 using an offscreen canvas. */
function imageToBase64(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.offsetWidth;
    canvas.height = img.naturalHeight || img.offsetHeight;
    if (canvas.width === 0 || canvas.height === 0) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    // toDataURL returns "data:image/png;base64,..." — strip the prefix
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.split(",")[1] ?? null;
  } catch {
    // Cross-origin images will throw a SecurityError — fall back to URL-only
    return null;
  }
}

/** Extract a background-image URL from a computed style value. */
function extractBgImageUrl(bgImage: string): string | null {
  const match = bgImage.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
  return match?.[1] ?? null;
}

// ─── Bound target tracking ──────────────────────────────────────────

type BoundProductTarget = {
  img: HTMLImageElement;
  positionTarget: HTMLElement;
  bgUrl?: string;
};

const boundTargets = new WeakMap<HTMLElement, BoundProductTarget>();

// ─── Overlay element creation ────────────────────────────────────────

function createOverlayElement(bound: BoundProductTarget): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute(OVERLAY_ATTR, "");

  Object.assign(el.style, {
    width: `${OVERLAY_ICON_SIZE_PX}px`,
    height: `${OVERLAY_ICON_SIZE_PX}px`,
    padding: "12px",
    margin: "-12px",
    boxSizing: "content-box",
    cursor: "pointer",
    zIndex: "999999",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "auto",
  });

  const circle = document.createElement("div");
  Object.assign(circle.style, {
    width: "100%",
    height: "100%",
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.92)",
    border: "1px solid #e5e7eb",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    pointerEvents: "none",
  });

  const icon = document.createElement("span");
  icon.textContent = "\u{1F50D}";
  icon.style.fontSize = "14px";
  icon.style.lineHeight = "1";
  circle.appendChild(icon);
  el.appendChild(circle);

  el.addEventListener("mouseenter", () => {
    circle.style.transform = `scale(${OVERLAY_HOVER_SCALE})`;
    circle.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
    el.title = "Find cheaper alternatives";
  });

  el.addEventListener("mouseleave", () => {
    circle.style.transform = "scale(1)";
    circle.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
  });

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const imageUrl = bound.bgUrl ?? bound.img.src;
    const imageBase64 = imageToBase64(bound.img);
    const titleHint = extractTitleFromDom(bound.positionTarget, bound.img);

    const priceInfo = extractPriceFromDom(bound.positionTarget);

    // Extract the product link URL from the <a> wrapping the image.
    // On listing pages, location.href is the page URL (e.g. marketplace homepage),
    // but the product link points to the actual product detail page.
    const productLink = (bound.positionTarget.closest("a") as HTMLAnchorElement | null)?.href ?? null;

    chrome.runtime.sendMessage({
      type: "IMAGE_CLICKED",
      imageUrl,
      imageBase64,
      titleHint,
      pageUrl: location.href,
      productLink,
      price: priceInfo.price,
      currency: priceInfo.currency,
    });
  });

  return el;
}

// ─── Overlay positioning ─────────────────────────────────────────────

function positionOverlay(overlay: HTMLElement, target: HTMLElement): void {
  // Use fixed positioning so the overlay lives in document.body and is immune
  // to parent overflow:hidden, CSS transforms, and framework reconciliation.
  const rect = target.getBoundingClientRect();
  overlay.style.position = "fixed";
  overlay.style.top = `${rect.top + 8}px`;
  overlay.style.right = `${document.documentElement.clientWidth - rect.right + 8}px`;
  overlay.style.left = "auto";
}

// ─── Overlay show/hide ───────────────────────────────────────────────

let activeOverlay: { el: HTMLDivElement; target: HTMLElement; img: HTMLImageElement } | null = null;
let hideTimeout: ReturnType<typeof setTimeout> | null = null;

function showOverlay(bound: BoundProductTarget): void {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  if (activeOverlay?.target === bound.positionTarget) return;
  hideOverlay();

  const overlay = createOverlayElement(bound);
  positionOverlay(overlay, bound.positionTarget);
  document.body.appendChild(overlay);
  activeOverlay = { el: overlay, target: bound.positionTarget, img: bound.img };
}

function scheduleHide(): void {
  if (hideTimeout) clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    if (!activeOverlay) return;
    hideOverlay();
  }, OVERLAY_HIDE_DELAY_MS);
}

function hideOverlay(): void {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  if (activeOverlay) {
    activeOverlay.el.remove();
    activeOverlay = null;
  }
}

// ─── Product target resolution ───────────────────────────────────────

/**
 * Maximum DOM levels to walk up when resolving a hover target to a product image.
 * Kept low to avoid matching at grid/page level where multiple products coexist.
 */
const MAX_RESOLVE_DEPTH = 5;

/**
 * Given any hovered DOM element, find the nearest bound product image.
 *
 * Walks UP the DOM from the event target, checking at each level whether the
 * subtree contains exactly one bound product element.  Stops early when
 * multiple are found (indicating a grid/list container — too high in the tree).
 *
 * This is the key robustness improvement: it does not matter what element
 * actually received the mouse event (overlay div, hover effect, click
 * interceptor, nested wrapper) — we always find the product image.
 */
function resolveProductTarget(el: HTMLElement): BoundProductTarget | null {
  // Direct hit — the hovered element itself is a bound target
  if (boundTargets.has(el)) return boundTargets.get(el)!;

  // Walk up the DOM looking for a container with exactly one bound descendant
  let current: HTMLElement | null = el;
  for (let depth = 0; depth < MAX_RESOLVE_DEPTH && current && current !== document.body; depth++) {
    const boundEls = current.querySelectorAll<HTMLElement>(`[${BOUND_ATTR}]`);
    if (boundEls.length === 1) {
      return boundTargets.get(boundEls[0]) ?? null;
    }
    if (boundEls.length > 1) return null; // Grid/list level — stop
    current = current.parentElement;
  }

  return null;
}

// ─── Delegated hover handling ────────────────────────────────────────

/**
 * Single delegated mouseover handler on document.body.
 *
 * Instead of attaching mouseenter/mouseleave on each product image (which
 * fails when overlay divs, hover effects, or click interceptors sit on top
 * of the <img>), this handler catches ALL mouseover events and resolves
 * the hovered element to the nearest product image via DOM walking.
 */
function handleMouseOver(e: Event): void {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;

  // Mouse entered our overlay element — cancel any pending hide
  if (activeOverlay && (target === activeOverlay.el || activeOverlay.el.contains(target))) {
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
    return;
  }

  const bound = resolveProductTarget(target);
  if (bound) {
    // Same target as current overlay — just keep it visible
    if (activeOverlay?.target === bound.positionTarget) {
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
      return;
    }
    showOverlay(bound);
  } else if (activeOverlay) {
    scheduleHide();
  }
}

// ─── Element binding (mark + register, no per-element listeners) ─────

/** Check if the image is visually large enough for an overlay using displayed size. */
function isImageLargeEnough(img: HTMLImageElement): boolean {
  const w = img.offsetWidth || img.naturalWidth;
  const h = img.offsetHeight || img.naturalHeight;
  return w >= MIN_IMAGE_SIZE_PX && h >= MIN_IMAGE_SIZE_PX;
}

function attachOverlay(img: HTMLImageElement): void {
  if (img.dataset.shoppingAssistantBound) return;

  if (img.offsetWidth > 0 || img.naturalWidth > 0) {
    if (!isImageLargeEnough(img)) return;
    img.dataset.shoppingAssistantBound = "1";
    boundTargets.set(img, { img, positionTarget: img });
    return;
  }

  // Image not yet loaded / no layout — wait for load event
  if (!img.complete) {
    img.addEventListener("load", () => {
      if (img.dataset.shoppingAssistantBound) return;
      if (!isImageLargeEnough(img)) return;
      img.dataset.shoppingAssistantBound = "1";
      boundTargets.set(img, { img, positionTarget: img });
    }, { once: true });
  }
}

/** Check if an element has a background-image that looks like a product image. */
function tryAttachBgOverlay(el: HTMLElement): void {
  if (el.dataset.shoppingAssistantBound) return;
  if (el.querySelector("img")) return; // Skip if element contains an <img>

  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (w < MIN_BG_IMAGE_SIZE_PX || h < MIN_BG_IMAGE_SIZE_PX) return;

  const bgImage = getComputedStyle(el).backgroundImage;
  if (!bgImage || bgImage === "none") return;

  const bgUrl = extractBgImageUrl(bgImage);
  if (!bgUrl) return;

  const proxyImg = new Image();
  proxyImg.crossOrigin = "anonymous";
  proxyImg.src = bgUrl;

  el.dataset.shoppingAssistantBound = "1";
  boundTargets.set(el, { img: proxyImg, positionTarget: el, bgUrl });
}

/** Scan an element and its children for background-image product candidates. */
function scanForBgImages(root: HTMLElement): void {
  tryAttachBgOverlay(root);
  for (const child of root.querySelectorAll<HTMLElement>("div, span, a, li, article, figure")) {
    tryAttachBgOverlay(child);
  }
}

// ─── Initialization ──────────────────────────────────────────────────

export function initOverlays(): void {
  // Mark all existing product images
  for (const img of document.querySelectorAll<HTMLImageElement>("img")) {
    attachOverlay(img);
  }
  scanForBgImages(document.body);

  // Single delegated hover listener — robust against overlay divs, hover
  // effects, click interceptors, and any card layout structure.
  // Uses capturing phase so it runs before any site script can stopPropagation.
  document.body.addEventListener("mouseover", handleMouseOver, true);

  // Hide overlay when mouse leaves the page entirely
  document.documentElement.addEventListener("mouseleave", () => {
    if (activeOverlay) scheduleHide();
  });

  // Reposition overlay on scroll so it tracks the product image
  let scrollRafId = 0;
  window.addEventListener("scroll", () => {
    if (!activeOverlay) return;
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = 0;
      if (activeOverlay) positionOverlay(activeOverlay.el, activeOverlay.target);
    });
  }, { passive: true });

  // Watch for dynamically added/changed images
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Handle new nodes added to the DOM
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLImageElement) {
          attachOverlay(node);
        }
        if (node instanceof HTMLElement) {
          for (const img of node.querySelectorAll<HTMLImageElement>("img")) {
            attachOverlay(img);
          }
          scanForBgImages(node);
        }
      }

      // Handle lazy-loaded images: src/srcset attribute changes on existing <img>
      if (
        mutation.type === "attributes" &&
        mutation.target instanceof HTMLImageElement
      ) {
        const img = mutation.target;
        // Reset bound state so attachOverlay re-evaluates with the new src
        delete img.dataset.shoppingAssistantBound;
        attachOverlay(img);
      }

      // Handle style/class changes that might reveal background images
      if (
        mutation.type === "attributes" &&
        mutation.target instanceof HTMLElement &&
        !(mutation.target instanceof HTMLImageElement)
      ) {
        const el = mutation.target;
        delete el.dataset.shoppingAssistantBound;
        tryAttachBgOverlay(el);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "class"],
  });
}
