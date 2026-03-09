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
  const el = document.createElement("div");
  el.setAttribute(OVERLAY_ATTR, "");

  Object.assign(el.style, {
    position: "absolute",
    width: `${OVERLAY_ICON_SIZE_PX}px`,
    height: `${OVERLAY_ICON_SIZE_PX}px`,
    borderRadius: "50%",
    background: "rgba(255, 255, 255, 0.92)",
    border: "1px solid #e5e7eb",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    cursor: "pointer",
    zIndex: "999999",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.15s ease, box-shadow 0.15s ease",
    pointerEvents: "auto",
    // Invisible hit area: extend hover zone 12px in all directions
    padding: "12px",
    margin: "-12px",
    boxSizing: "content-box",
  });

  const icon = document.createElement("span");
  icon.textContent = "\u{1F50D}";
  icon.style.fontSize = "14px";
  icon.style.lineHeight = "1";
  el.appendChild(icon);

  el.addEventListener("mouseenter", () => {
    el.style.transform = `scale(${OVERLAY_HOVER_SCALE})`;
    el.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
    el.title = "Find cheaper alternatives";
  });

  el.addEventListener("mouseleave", () => {
    el.style.transform = "scale(1)";
    el.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
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

function attachOverlay(img: HTMLImageElement): void {
  if (img.dataset.shoppingAssistantBound) return;
  if (img.naturalWidth < MIN_IMAGE_SIZE_PX || img.naturalHeight < MIN_IMAGE_SIZE_PX) return;
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

export function initOverlays(): void {
  const imgs = document.querySelectorAll<HTMLImageElement>("img");
  for (const img of imgs) {
    attachOverlay(img);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
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
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
