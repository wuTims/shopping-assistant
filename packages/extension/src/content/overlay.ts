import type { DetectedProduct } from "@shopping-assistant/shared";
import { OVERLAY_ICON_SIZE_PX, CACHE_TTL_MS } from "@shopping-assistant/shared";

const OVERLAY_ATTR = "data-shopping-assistant-overlay";
const Z_INDEX = 999999;

function createOverlayIcon(product: DetectedProduct): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute(OVERLAY_ATTR, product.id);

  Object.assign(el.style, {
    position: "absolute",
    width: `${OVERLAY_ICON_SIZE_PX}px`,
    height: `${OVERLAY_ICON_SIZE_PX}px`,
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.92)",
    border: "1px solid #e5e7eb",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    cursor: "pointer",
    zIndex: String(Z_INDEX),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    pointerEvents: "auto",
  } as CSSStyleDeclaration);

  // Inner icon (magnifier)
  const icon = document.createElement("span");
  icon.textContent = "\u{1F50D}";
  icon.style.fontSize = "14px";
  icon.style.lineHeight = "1";
  el.appendChild(icon);

  // Green dot (cached indicator, hidden by default)
  const dot = document.createElement("span");
  dot.className = "shopping-assistant-cached-dot";
  Object.assign(dot.style, {
    position: "absolute",
    top: "-2px",
    right: "-2px",
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#10b981",
    border: "1.5px solid white",
    display: "none",
  } as CSSStyleDeclaration);
  el.appendChild(dot);

  // Hover effects
  el.addEventListener("mouseenter", () => {
    el.style.transform = "scale(1.14)";
    el.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
    el.title = "Find cheaper alternatives";
  });
  el.addEventListener("mouseleave", () => {
    el.style.transform = "scale(1)";
    el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
  });

  // Click → send message to service worker
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "PRODUCT_CLICKED", product });
  });

  return el;
}

function positionOverlay(overlay: HTMLElement, imageEl: Element): void {
  const parent = imageEl.parentElement;
  if (!parent) return;

  // Ensure parent is positioned for absolute placement
  const parentPos = getComputedStyle(parent).position;
  if (parentPos === "static") {
    parent.style.position = "relative";
  }

  const parentRect = parent.getBoundingClientRect();
  const imgRect = imageEl.getBoundingClientRect();

  overlay.style.top = `${imgRect.top - parentRect.top + 8}px`;
  overlay.style.right = `${parentRect.right - imgRect.right + 8}px`;
  overlay.style.left = "auto";
}

export function injectOverlays(products: DetectedProduct[]): void {
  // Remove old overlays
  removeOverlays();

  for (const product of products) {
    const imgEl = document.querySelector(
      `img[src="${product.imageUrl}"]`
    ) ?? document.querySelector(
      `img[src*="${product.imageUrl.split("/").pop()}"]`
    );
    if (!imgEl) continue;

    const overlay = createOverlayIcon(product);
    positionOverlay(overlay, imgEl);
    imgEl.parentElement!.appendChild(overlay);

    // Check cache for green dot
    checkCachedStatus(product.id, overlay);
  }
}

async function checkCachedStatus(productId: string, overlay: HTMLElement): Promise<void> {
  try {
    const key = `search_${productId}`;
    const data = await chrome.storage.local.get(key);
    if (data[key]) {
      const cached = data[key];
      if (Date.now() - cached.cachedAt < (cached.ttl ?? CACHE_TTL_MS)) {
        const dot = overlay.querySelector(".shopping-assistant-cached-dot") as HTMLElement;
        if (dot) dot.style.display = "block";
      }
    }
  } catch { /* storage access may fail in some contexts */ }
}

export function removeOverlays(): void {
  document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((el) => el.remove());
}
