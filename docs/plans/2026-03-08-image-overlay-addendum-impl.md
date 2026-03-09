# Image Overlay Addendum Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a magnifying glass overlay on product images as a second entry point for search, complementing the existing screenshot-based flow on the `feat/anti-bot-screenshot` branch.

**Architecture:** Minimal content script finds `<img>` elements >= 100x100px, shows a magnifying glass icon on hover, and on click sends `img.src` + nearby text to the service worker which routes directly to `POST /search` (skipping `/identify`). All existing anti-bot functionality stays untouched.

**Tech Stack:** Chrome Extension MV3 content script, TypeScript, existing Hono backend

**Branch:** Work on `feat/anti-bot-screenshot` (all changes are additive to that branch)

---

## Tasks

### Task 1: Add Overlay Constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

**Step 1: Add overlay icon constants**

Add at the end of the file:

```typescript
export const OVERLAY_ICON_SIZE_PX = 28;
export const OVERLAY_ICON_HOVER_SIZE_PX = 32;
export const MIN_IMAGE_SIZE_PX = 100;
export const OVERLAY_TITLE_HINT_MAX_LENGTH = 200;
```

**Step 2: Build shared**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): add overlay icon constants for image overlay addendum"
```

---

### Task 2: Create Content Script — Overlay Logic

**Files:**
- Create: `packages/extension/src/content/overlay.ts`

**Step 1: Write the overlay module**

Create `packages/extension/src/content/overlay.ts`:

```typescript
import {
  OVERLAY_ICON_SIZE_PX,
  OVERLAY_ICON_HOVER_SIZE_PX,
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
      container?.innerText?.trim().slice(0, OVERLAY_TITLE_HINT_MAX_LENGTH) ?? null;

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
```

**Step 2: Typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS (module not imported anywhere yet, but should compile).

**Step 3: Commit**

```bash
git add packages/extension/src/content/overlay.ts
git commit -m "feat(extension): add minimal image overlay module with magnifying glass icon"
```

---

### Task 3: Create Content Script — Entry Point

**Files:**
- Create: `packages/extension/src/content/index.ts`

**Step 1: Write the content script entry point**

Create `packages/extension/src/content/index.ts`:

```typescript
import { initOverlays } from "./overlay";

console.log("[Shopping Assistant] Content script loaded");

initOverlays();
```

**Step 2: Typecheck**

Run: `pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/extension/src/content/index.ts
git commit -m "feat(extension): add content script entry point for image overlays"
```

---

### Task 4: Re-add Content Script to Manifest

**Files:**
- Modify: `packages/extension/src/manifest.json`

**Step 1: Add content_scripts section**

In `packages/extension/src/manifest.json`, add the `content_scripts` block after `"action"`:

```json
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/index.ts"],
      "run_at": "document_idle"
    }
  ]
```

The full manifest should be:

```json
{
  "manifest_version": 3,
  "name": "Shopping Source Discovery",
  "version": "0.1.0",
  "description": "Find cheaper alternatives for any product you see online.",
  "permissions": ["sidePanel", "storage", "activeTab"],
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/index.ts"],
      "run_at": "document_idle"
    }
  ],
  "side_panel": {
    "default_path": "src/sidepanel/index.html"
  },
  "action": {
    "default_title": "Shopping Source Discovery"
  },
  "icons": {}
}
```

**Step 2: Build extension**

Run: `pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS.

**Step 3: Commit**

```bash
git add packages/extension/src/manifest.json
git commit -m "feat(extension): re-add content_scripts to manifest for image overlay"
```

---

### Task 5: Add IMAGE_CLICKED Handler to Service Worker

**Files:**
- Modify: `packages/extension/src/background/index.ts`

**Step 1: Add IMAGE_CLICKED handler to the existing onMessage listener**

In `packages/extension/src/background/index.ts`, find the existing `chrome.runtime.onMessage.addListener` block (around line 68). Replace it with a handler that covers both `select_product` and `IMAGE_CLICKED`:

```typescript
// Listen for product selection from side panel AND image clicks from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "select_product") {
    const { tabId, product, screenshotDataUrl, pageUrl } = message;
    searchForProduct(tabId, product, screenshotDataUrl, pageUrl).then(() =>
      sendResponse({ status: "ok" }),
    );
    return true;
  }

  if (message.type === "IMAGE_CLICKED") {
    const tabId = sender.tab?.id;
    if (!tabId) return false;

    const { imageUrl, titleHint, pageUrl } = message;

    (async () => {
      await chrome.sidePanel.open({ tabId });

      const product = {
        name: titleHint || "Product",
        price: null as number | null,
        currency: null as string | null,
      };

      notifySidePanel(tabId, { type: "searching", product });
      await searchForProduct(tabId, product, "", pageUrl, imageUrl);
      sendResponse({ status: "ok" });
    })();

    return true;
  }

  return false;
});
```

**Step 2: Update searchForProduct to accept optional imageUrl**

Modify the `searchForProduct` function signature (around line 79) to accept an optional `imageUrl` parameter. When provided, use it as `SearchRequest.imageUrl` instead of the screenshot:

Replace the existing `searchForProduct` function with:

```typescript
async function searchForProduct(
  tabId: number,
  product: { name: string; price: number | null; currency: string | null },
  screenshotDataUrl: string,
  pageUrl: string,
  imageUrl?: string,
): Promise<void> {
  // Check cache first
  const cacheKey = `search:${product.name}:${pageUrl}`;
  const cached = await getCached(cacheKey);
  if (cached) {
    notifySidePanel(tabId, { type: "results", response: cached });
    return;
  }

  try {
    const searchReq: SearchRequest = {
      imageUrl: imageUrl ?? "",
      imageBase64: !imageUrl && screenshotDataUrl
        ? (screenshotDataUrl.includes(",")
          ? screenshotDataUrl.split(",")[1]
          : screenshotDataUrl)
        : null,
      title: product.name !== "Product" ? product.name : null,
      price: product.price,
      currency: product.currency,
      sourceUrl: pageUrl,
    };

    notifySidePanel(tabId, { type: "searching", product });

    const searchRes = await fetch(`${BACKEND_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(searchReq),
    });

    if (!searchRes.ok) {
      notifySidePanel(tabId, {
        type: "error",
        message: "Search failed. Please try again.",
      });
      return;
    }

    const response: SearchResponse = await searchRes.json();
    await setCache(cacheKey, response);
    notifySidePanel(tabId, { type: "results", response });
  } catch (err) {
    console.error("[Shopping Assistant] Search failed:", err);
    notifySidePanel(tabId, {
      type: "error",
      message: "Search failed. Please try again.",
    });
  }
}
```

**Step 3: Typecheck**

Run: `pnpm build:shared && pnpm --filter @shopping-assistant/extension typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add packages/extension/src/background/index.ts
git commit -m "feat(extension): add IMAGE_CLICKED handler to service worker for overlay search"
```

---

### Task 6: Build and Verify

**Step 1: Full build**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm build`
Expected: All packages build successfully.

**Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS across all packages.

**Step 3: Run backend tests**

Run: `pnpm --filter @shopping-assistant/backend test`
Expected: All existing tests PASS (no backend changes in this addendum).

**Step 4: Verify content script is in extension build output**

Run: `ls -la packages/extension/dist/assets/ 2>/dev/null || echo "Check build output for content script bundle"`
Expected: Content script bundle exists in the dist output.

**Step 5: Commit if any fixes were needed**

```bash
git add -A && git commit -m "fix: resolve issues found during build verification"
```
