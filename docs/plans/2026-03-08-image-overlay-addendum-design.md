# Image Overlay Addendum Design

**Date:** 2026-03-08
**Status:** Approved
**Addendum to:** `2026-03-08-anti-bot-screenshot-design.md`

## Context

The anti-bot screenshot design replaced the content script entirely with `captureVisibleTab()` triggered by the extension icon click. This works well for single product pages (auto-detect) and listing pages (selection grid), but requires Gemini to identify products from a full viewport screenshot.

AliPrice demonstrates a simpler, proven pattern: a magnifying glass icon on product images. The user clicks the icon on the specific image they care about, and the image URL goes directly to search. No DOM parsing, no bot detection risk.

This addendum adds the magnifying glass overlay as a **second entry point** alongside the existing screenshot flow. Everything in the anti-bot branch stays as-is.

## Two Entry Points

| Trigger | Use Case | Flow |
|---------|----------|------|
| **Extension icon click** (existing) | Single product pages, any page | `captureVisibleTab()` → `POST /identify` → auto-select or grid → `POST /search` |
| **Magnifying glass on image** (new) | Any page with product images | Click icon → grab `img.src` + nearby text → `POST /search` directly |

The magnifying glass path is faster (skips `/identify`) and more precise (user already selected the exact product image).

## Content Script

### Scope

Runs on `<all_urls>` at `document_idle`. Minimal footprint — no DOM parsing, no site-specific selectors, no page observation.

### On Page Load

Find all `<img>` elements where `naturalWidth >= 100 && naturalHeight >= 100`. Attach `mouseenter` and `mouseleave` listeners to show/hide the overlay icon. Images that load later (lazy loading) are not detected — this is acceptable for v1.

### Overlay Icon

- 28px circle, white at 90% opacity, 1px light gray border, subtle drop shadow
- Magnifying glass emoji or SVG icon
- Positioned at top-right corner of the image, 8px inset
- On hover: scale to 32px, tooltip "Find cheaper alternatives"
- z-index: 999999

### On Click (Magnifying Glass)

1. Read `img.src` for the image URL
2. Walk up the DOM to the closest container (`a`, `li`, `article`, `div`) and read `innerText`, truncated to 200 characters, as a title hint
3. Send message to service worker: `{ type: "IMAGE_CLICKED", imageUrl, titleHint, pageUrl }`
4. `stopPropagation()` + `preventDefault()` to prevent navigation if the image is inside a link

### What the Script Does NOT Do

- No `querySelectorAll` for site-specific selectors (Amazon, eBay, etc.)
- No JSON-LD or schema.org parsing
- No `MutationObserver` on `document.body`
- No `history.pushState` / `replaceState` monkey-patching
- No automated messages on page load (only sends messages on user click)
- No price extraction from DOM

### Why This Avoids Bot Detection

The script's behavior is indistinguishable from a simple UI enhancement extension. It reads `img.src` (a public attribute), adds a small visual element on hover, and reads `innerText` from a single element on user click. Amazon's anti-bot systems target scraper patterns: structured data parsing, site-specific DOM queries, mutation observation, and automated behavior. This script does none of that.

## Service Worker Changes

Add an `IMAGE_CLICKED` message handler alongside the existing `select_product` handler.

```
chrome.runtime.onMessage: IMAGE_CLICKED
  → open side panel
  → send SearchRequest { imageUrl, title: titleHint, sourceUrl: pageUrl }
  → POST /search (existing endpoint, no changes)
  → notify side panel with results
```

This reuses the existing `searchForProduct()` function and cache logic. The only difference from the screenshot path is that we skip `/identify` and go straight to `/search`.

## Manifest Changes

Re-add `content_scripts` section:

```json
"content_scripts": [
  {
    "matches": ["<all_urls>"],
    "js": ["src/content/index.ts"],
    "run_at": "document_idle"
  }
]
```

Permissions stay the same: `activeTab`, `sidePanel`, `storage`. No host permissions needed — the content script only reads `img.src` and `innerText`, it doesn't make network requests.

## Side Panel Changes

None. The existing side panel already handles `searching` and `results` states from the anti-bot implementation. The `IMAGE_CLICKED` path produces the same message types.

## Backend Changes

None. `POST /search` already accepts `imageUrl` and `title` as optional fields. The image overlay path sends both.

## Shared Type Changes

Add `IMAGE_CLICKED` to the extension message types if a message type union exists, or handle it as an untyped message in the service worker listener.

## Architecture Diagram

```
                    ┌─────────────────────────────────┐
                    │         USER ACTION              │
                    ├────────────────┬────────────────┤
                    │ Click ext icon │ Click 🔍 on img │
                    └───────┬────────┴───────┬────────┘
                            │                │
                            ▼                │
                   captureVisibleTab()       │
                            │                │
                            ▼                │
                     POST /identify          │
                            │                │
                    ┌───────┴───────┐        │
                    │ 1 product     │ N      │
                    │ auto-select   │ grid   │
                    └───────┬───────┘ pick   │
                            │         │      │
                            ▼         ▼      ▼
                         POST /search (same endpoint)
                            │
                            ▼
                    Pipeline (existing)
                    Phase 1: Identify
                    Phase 2: Brave + Grounding + site: queries
                    Phase 3: Merge/dedup
                    Phase 3.5: Price fallback
                    Phase 4: AI ranking
                            │
                            ▼
                      Side panel results
```

## Scope Boundaries

**In scope:**
- Minimal content script with hover overlay on images
- `IMAGE_CLICKED` handler in service worker
- Re-add `content_scripts` to manifest

**Out of scope (future enhancements):**
- Crop/snip tool for user-defined image regions
- Lazy-loaded image detection (MutationObserver — intentionally excluded)
- Shadow DOM encapsulation for overlay (not needed for a single small icon)
- Cached result green dot indicator on overlay icons
