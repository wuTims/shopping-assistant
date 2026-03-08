import {
  OVERLAY_ICON_SIZE_PX,
  MIN_IMAGE_SIZE_PX,
  OVERLAY_TITLE_HINT_MAX_LENGTH,
} from "@shopping-assistant/shared";

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
  });

  const icon = document.createElement("span");
  icon.textContent = "\u{1F50D}";
  icon.style.fontSize = "14px";
  icon.style.lineHeight = "1";
  el.appendChild(icon);

  el.addEventListener("mouseenter", () => {
    el.style.transform = "scale(1.14)";
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

function showOverlay(img: HTMLImageElement): void {
  if (activeOverlay?.img === img) return;
  hideOverlay();

  const overlay = createOverlayIcon(img);
  positionOverlay(overlay, img);
  img.parentElement!.appendChild(overlay);
  activeOverlay = { el: overlay, img };
}

function hideOverlay(): void {
  if (activeOverlay) {
    activeOverlay.el.remove();
    activeOverlay = null;
  }
}

export function initOverlays(): void {
  const imgs = document.querySelectorAll<HTMLImageElement>("img");

  for (const img of imgs) {
    if (img.naturalWidth < MIN_IMAGE_SIZE_PX || img.naturalHeight < MIN_IMAGE_SIZE_PX) {
      continue;
    }

    img.addEventListener("mouseenter", () => showOverlay(img));
    img.addEventListener("mouseleave", (e) => {
      const related = e.relatedTarget as Node | null;
      if (activeOverlay && related && activeOverlay.el.contains(related)) return;
      hideOverlay();
    });
  }

  // Also hide when mouse leaves the overlay itself
  document.addEventListener("mouseover", (e) => {
    if (!activeOverlay) return;
    const target = e.target as Node;
    if (
      !activeOverlay.el.contains(target) &&
      target !== activeOverlay.img
    ) {
      hideOverlay();
    }
  });
}
