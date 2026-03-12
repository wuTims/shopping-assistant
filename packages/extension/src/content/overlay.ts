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
    const container = img.closest("a, li, article, div");
    const titleHint =
      (container as HTMLElement)?.innerText?.trim().slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH) ?? null;

    chrome.runtime.sendMessage({
      type: "IMAGE_CLICKED",
      imageUrl,
      titleHint,
      pageUrl: location.href,
    });
  });

  return el;
}

function positionOverlay(overlay: HTMLElement, img: HTMLImageElement): void {
  const parent = img.parentElement;
  if (!parent) return;

  const parentPos = getComputedStyle(parent).position;
  if (parentPos === "static") {
    parent.style.position = "relative";
  }

  const parentRect = parent.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();

  overlay.style.top = `${imgRect.top - parentRect.top + 8}px`;
  overlay.style.right = `${parentRect.right - imgRect.right + 8}px`;
  overlay.style.left = "auto";
}

let activeOverlay: { el: HTMLDivElement; img: HTMLImageElement } | null = null;
let hideTimeout: ReturnType<typeof setTimeout> | null = null;

function showOverlay(img: HTMLImageElement): void {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
  if (activeOverlay?.img === img) return;
  hideOverlay();

  const parent = img.parentElement;
  if (!parent) return;

  const overlay = createOverlayIcon(img);
  positionOverlay(overlay, img);
  parent.appendChild(overlay);
  activeOverlay = { el: overlay, img };

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

export function initOverlays(): void {
  const imgs = document.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    attachOverlay(img);
  }

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
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset"],
  });
}
