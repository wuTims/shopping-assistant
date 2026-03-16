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

/** Track elements that already have listeners to prevent duplicate attachment. */
const listenersAttached = new WeakSet<HTMLElement>();

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

function createOverlayIcon(img: HTMLImageElement): HTMLDivElement {
  // Outer element: transparent hit area (28 + 24 padding = 52px clickable zone)
  const el = document.createElement("div");
  el.setAttribute(OVERLAY_ATTR, "");

  Object.assign(el.style, {
    position: "absolute",
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

  // Inner element: visible 28px circle with border and shadow
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

    const imageUrl = img.src;
    const imageBase64 = imageToBase64(img);
    const container = img.closest("a, li, article, div");
    const containerClone = (container as HTMLElement)?.cloneNode(true) as HTMLElement | null;
    containerClone?.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((el) => el.remove());
    const containerText = containerClone?.innerText?.trim().slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH) || null;
    // Fall back to page title when the image container has no text (common on
    // product detail pages where the title lives outside the image wrapper)
    const titleHint = containerText || document.title || null;

    // Try to extract price from nearby DOM elements
    const priceInfo = extractPriceFromDom(img);

    chrome.runtime.sendMessage({
      type: "IMAGE_CLICKED",
      imageUrl,
      imageBase64,
      titleHint,
      pageUrl: location.href,
      price: priceInfo.price,
      currency: priceInfo.currency,
    });
  });

  return el;
}

function positionOverlay(overlay: HTMLElement, target: HTMLElement): void {
  const parent = target.parentElement;
  if (!parent) return;

  // For img elements, position in parent. For bg-image elements, position within the element itself.
  const positionHost = target instanceof HTMLImageElement ? parent : target;
  const positionHostStyle = getComputedStyle(positionHost).position;
  if (positionHostStyle === "static") {
    positionHost.style.position = "relative";
  }

  const hostRect = positionHost.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();

  overlay.style.top = `${targetRect.top - hostRect.top + 8}px`;
  overlay.style.right = `${hostRect.right - targetRect.right + 8}px`;
  overlay.style.left = "auto";
}

let activeOverlay: { el: HTMLDivElement; target: HTMLElement; img: HTMLImageElement } | null = null;
let hideTimeout: ReturnType<typeof setTimeout> | null = null;

function showOverlay(img: HTMLImageElement, target?: HTMLElement): void {
  const effectiveTarget = target ?? img;
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  if (activeOverlay?.target === effectiveTarget) return;
  hideOverlay();

  // For img: append overlay to parent. For bg-image element: append to element itself.
  const host = img instanceof HTMLImageElement && !target
    ? img.parentElement
    : effectiveTarget;
  if (!host) return;

  const overlay = createOverlayIcon(img);
  positionOverlay(overlay, effectiveTarget);
  host.appendChild(overlay);
  activeOverlay = { el: overlay, target: effectiveTarget, img };

  overlay.addEventListener("mouseenter", () => {
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
  });
  overlay.addEventListener("mouseleave", scheduleHide);
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

function bindOverlayEvents(img: HTMLImageElement): void {
  img.dataset.shoppingAssistantBound = "1";

  // Prevent duplicate listeners — WeakSet survives mutation observer resets
  if (listenersAttached.has(img)) return;
  listenersAttached.add(img);

  img.addEventListener("mouseenter", () => showOverlay(img));
  img.addEventListener("mouseleave", (e) => {
    const related = e.relatedTarget as Node | null;
    if (activeOverlay && related) {
      // Don't hide if mouse moved to overlay or its parent container
      if (activeOverlay.el.contains(related) || activeOverlay.el === related) return;
    }
    scheduleHide();
  });
}

/**
 * Create an overlay icon for a background-image element.
 * Uses a hidden <img> to pass to createOverlayIcon for canvas-based base64 conversion.
 */
function createBgOverlayIcon(el: HTMLElement, bgUrl: string): HTMLDivElement {
  // Create a hidden img element for base64 conversion on click
  const proxyImg = new Image();
  proxyImg.crossOrigin = "anonymous";
  proxyImg.src = bgUrl;

  const overlay = document.createElement("div");
  overlay.setAttribute(OVERLAY_ATTR, "");

  Object.assign(overlay.style, {
    position: "absolute",
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
  overlay.appendChild(circle);

  overlay.addEventListener("mouseenter", () => {
    circle.style.transform = `scale(${OVERLAY_HOVER_SCALE})`;
    circle.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
    overlay.title = "Find cheaper alternatives";
  });

  overlay.addEventListener("mouseleave", () => {
    circle.style.transform = "scale(1)";
    circle.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
  });

  overlay.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const imageBase64 = imageToBase64(proxyImg);
    const container = el.closest("a, li, article, div") ?? el;
    const containerClone = (container as HTMLElement)?.cloneNode(true) as HTMLElement | null;
    containerClone?.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((el) => el.remove());
    const containerText = containerClone?.innerText?.trim().slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH) || null;
    const titleHint = containerText || document.title || null;

    const priceInfo = extractPriceFromDom(el);

    chrome.runtime.sendMessage({
      type: "IMAGE_CLICKED",
      imageUrl: bgUrl,
      imageBase64,
      titleHint,
      pageUrl: location.href,
      price: priceInfo.price,
      currency: priceInfo.currency,
    });
  });

  return overlay;
}

function bindBgOverlayEvents(el: HTMLElement, bgUrl: string): void {
  el.dataset.shoppingAssistantBound = "1";
  if (listenersAttached.has(el)) return;
  listenersAttached.add(el);

  // Create a proxy img for the overlay system
  const proxyImg = new Image();
  proxyImg.crossOrigin = "anonymous";
  proxyImg.src = bgUrl;

  el.addEventListener("mouseenter", () => {
    // Re-use showOverlay with the element as position target
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
    if (activeOverlay?.target === el) return;
    hideOverlay();

    const overlayEl = createBgOverlayIcon(el, bgUrl);
    positionOverlay(overlayEl, el);

    const posHost = getComputedStyle(el).position;
    if (posHost === "static") el.style.position = "relative";
    el.appendChild(overlayEl);
    activeOverlay = { el: overlayEl, target: el, img: proxyImg };

    overlayEl.addEventListener("mouseenter", () => {
      if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
    });
    overlayEl.addEventListener("mouseleave", scheduleHide);
  });

  el.addEventListener("mouseleave", (e) => {
    const related = e.relatedTarget as Node | null;
    if (activeOverlay && related) {
      if (activeOverlay.el.contains(related) || activeOverlay.el === related) return;
    }
    scheduleHide();
  });
}

/** Check if the image is visually large enough for an overlay using displayed size. */
function isImageLargeEnough(img: HTMLImageElement): boolean {
  // Use displayed size (offsetWidth/offsetHeight) — this works even when
  // the src is a tiny placeholder but CSS sizes the element to full size.
  const w = img.offsetWidth || img.naturalWidth;
  const h = img.offsetHeight || img.naturalHeight;
  return w >= MIN_IMAGE_SIZE_PX && h >= MIN_IMAGE_SIZE_PX;
}

function attachOverlay(img: HTMLImageElement): void {
  if (img.dataset.shoppingAssistantBound) return;

  // Image has dimensions (loaded or CSS-sized) — check size
  if (img.offsetWidth > 0 || img.naturalWidth > 0) {
    if (!isImageLargeEnough(img)) return;
    bindOverlayEvents(img);
    return;
  }

  // Image not yet loaded / no layout — wait for load event
  if (!img.complete) {
    img.addEventListener("load", () => {
      if (img.dataset.shoppingAssistantBound) return;
      if (!isImageLargeEnough(img)) return;
      bindOverlayEvents(img);
    }, { once: true });
  }
}

/** Check if an element has a background-image that looks like a product image. */
function tryAttachBgOverlay(el: HTMLElement): void {
  if (el.dataset.shoppingAssistantBound) return;
  if (el.querySelector("img")) return; // Skip if element contains an <img> — that will get its own overlay

  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (w < MIN_BG_IMAGE_SIZE_PX || h < MIN_BG_IMAGE_SIZE_PX) return;

  const bgImage = getComputedStyle(el).backgroundImage;
  if (!bgImage || bgImage === "none") return;

  const bgUrl = extractBgImageUrl(bgImage);
  if (!bgUrl) return;

  bindBgOverlayEvents(el, bgUrl);
}

/** Scan an element and its children for background-image product candidates. */
function scanForBgImages(root: HTMLElement): void {
  // Check the root element itself
  tryAttachBgOverlay(root);
  // Check common product-like children
  for (const child of root.querySelectorAll<HTMLElement>("div, span, a, li, article, figure")) {
    tryAttachBgOverlay(child);
  }
}

export function initOverlays(): void {
  const imgs = document.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    attachOverlay(img);
  }

  // Scan for background-image products
  scanForBgImages(document.body);

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
          // Also check for background-image products in new nodes
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
        // (listeners are NOT duplicated — WeakSet guards that)
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
