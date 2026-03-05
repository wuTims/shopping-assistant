# Shopping Source Discovery Agent — Frontend Interface & UX Specification

## Design Philosophy

The extension should feel like a knowledgeable shopping companion, not a data dashboard. The UI is minimal when idle, informative when active, and conversational when the user wants depth. Every interaction should reduce friction in the user's decision-making process.

**Core UX principles:**
- Silent by default — no interruptions until the user engages
- Results over chrome — product data is the hero, not the UI
- Progressive reveal — show what matters first, let users dig deeper
- Respect the host page — overlays are subtle, never block content

---

## UI Components

### 1. Product Overlay Icon

**What it is:** A small circular icon injected over detected product images on the host page.

**Appearance:**
- 28x28px circle with subtle drop shadow
- Semi-transparent background (white at 90% opacity) with the extension logo or a recognizable search/compare icon
- Positioned at the top-right corner of the product image element
- Slight border (1px, light gray) for visibility on white backgrounds
- On hover: scale to 32x32px with full opacity and a tooltip ("Find cheaper alternatives")

**Behavior:**
- Appears after DOM heuristic detection completes (< 200ms after page load)
- Click triggers the search flow and opens the side panel
- If results are already cached for this product, the icon shows a small green dot indicator (results ready)
- Icons should not appear on non-product images (brand logos, banners, UI elements). Detection heuristics filter for images that are near price text or within product schema markup.

**Z-index strategy:** Use a high z-index (999999) but below common modal/overlay values. If the host page uses higher z-indexes for its own UI (modals, popups), the overlay may be hidden — this is acceptable. The extension should not fight the host page for visual priority.

**Injection rules:**
- Only inject on images above a minimum size threshold (100x100px) to avoid decorative images
- Only inject if the image is within or adjacent to a detected product context (price element, schema markup, product container)
- Maximum overlays per page: 20 (prevent clutter on large catalog pages)
- Remove overlays on page navigation (SPA-aware: observe URL changes via `popstate` and `MutationObserver`)

---

### 2. Side Panel

The primary interface for results and interaction. Opens when user clicks a product overlay or the extension icon.

**Layout structure (top to bottom):**

#### Header Bar
- `shopping_bag` icon + "Personal Shopper" branding (left)
- Settings gear icon (right) — opens minimal settings (clear cache, about)

#### Original Product Section
- Small thumbnail of the detected product image (48x48, rounded corners)
- Product title (truncated to 2 lines if needed)
- Detected price with currency
- Source marketplace label (e.g., "on Amazon")

#### Price Context Bar
- Visual price range indicator (horizontal gradient bar: green → yellow → red)
- Current price position marked on the bar
- Low and high bounds of the range (derived from search results)
- Label: "This price is **high/fair/low**" based on where it falls in the range

#### Results List
- Section header: "Top results" with count (e.g., "Top results (5)")
- Each result is a **Product Card** (see below)
- Results sorted by rank (confidence × savings)
- Scrollable if more than 3-4 results

#### Product Card
- Product image thumbnail (48x48, rounded corners)
- Product title (truncated to 2 lines)
- Price in bold, with savings badge ("39% less" in green)
- Marketplace label (e.g., "AliExpress", "eBay", "Temu")
- Confidence indicator: subtle visual treatment
  - High confidence: no indicator needed (default state)
  - Medium confidence: small yellow dot or "Similar" label
  - Low confidence: small gray dot or "May differ" label
- Click anywhere on the card → opens product URL in a new tab

#### Input & Chat Section
- Fixed input bar at the bottom of the side panel (always visible once results load)
- Text input field with send button + hold-to-talk microphone button
- On results load, a text nudge bubble appears above input: "I can help you compare — hold 🎤 or type below."
- First interaction (voice or text) splits the panel: results compress to ~40% top, chat takes ~60% bottom
- Chat messages displayed in a standard conversational thread layout within the split
- Assistant messages can include inline product references (clickable links to results)
- Voice messages show 🔊 icon; text-only responses do not

> **Revised 2026-03-05:** Replaced separate "Chat Now" → chat view pattern with integrated split panel.
> See `docs/plans/2026-03-05-voice-interaction-design.md` for full voice interaction design.

#### Voice Input (Hold-to-Talk)
- User holds mic button to record (mousedown/touchstart), releases to send (mouseup/touchend)
- While held: mic button pulses red, live waveform + timer replaces text input area
- Audio streams to backend via WebSocket → Gemini Live API
- On release: user speech appears as transcript bubble, assistant responds with audio + transcript
- Barge-in: pressing mic during audio playback stops playback and starts new recording
- Text input remains available as secondary input method, using REST `/chat` endpoint

---

## User Flows

### Flow A: Browse → Detect → Search → Compare

```
1. User browses a product page (e.g., Amazon product detail page)
2. Extension detects the product via DOM heuristics
3. Small overlay icon appears on the product image (< 200ms)
4. User notices the icon and clicks it
5. Side panel opens with:
   - Original product info at top
   - Loading state: "Identifying product..." → "Searching marketplaces..." → "Ranking results..."
   - Each phase updates the loading text to give feedback
6. Results render after ranking completes:
   - Price context bar renders once results are available
   - Product cards appear together in final ranked order
7. User scans results, sees a 39% cheaper option on AliExpress
8. User clicks the product card → opens AliExpress listing in a new tab
```

**Total time from click to first result:** < 10 seconds
**Time from click to loading feedback:** < 500ms (side panel opens immediately with loading state)

### Flow B: Compare → Ask Questions (Text)

```
1. User has search results displayed in side panel (from Flow A)
2. Assistant nudge visible: "I can help you compare — hold mic or type below."
3. User types in input bar: "Is the AliExpress one the same quality?"
4. Panel splits: results compress to top ~40%, chat appears in bottom ~60%
5. Assistant responds with comparison analysis, referencing specific products
6. User types: "What about shipping time?"
7. Assistant provides estimated shipping comparison
8. Results remain scrollable above the chat thread
```

### Flow C: Compare → Voice Conversation

```
1. User has search results displayed in side panel
2. User holds microphone button (mousedown/touchstart)
3. Panel splits, mic button pulses red, waveform + timer appear
4. User speaks: "Which one of these is the best deal?"
5. User releases mic button (mouseup/touchend)
6. Audio streams to Cloud Run → Gemini Live API
7. User's speech appears as transcript bubble
8. Assistant responds via audio (auto-plays) + transcript appears in chat
9. User holds mic again while audio plays → barge-in (audio stops, new recording)
10. Can seamlessly switch to text input without losing context
```

### Flow D: Cached Result — Instant Display

```
1. User previously searched for a product on this page
2. User navigates away, then returns to the same page
3. Overlay icon appears with green dot (cached results available)
4. User clicks the overlay icon
5. Side panel opens immediately with cached results (0ms search time)
6. Results display exactly as before
```

---

## Loading States

Loading feedback is critical because the search takes 4-10 seconds. The user must always know something is happening.

**Phase 1: Side panel opens (0-500ms)**
- Side panel slides open
- Original product info displayed immediately (from DOM data)
- Animated loading indicator below product info
- Text: "Identifying product..."

**Phase 2: Identification complete (500ms-3s)**
- Loading text updates: "Searching across marketplaces..."
- Optionally show Gemini's identified product category/description as confirmation ("Looking for: white leather crossbody bag with gold chain strap")

**Phase 3: Search processing (3s-7s)**
- Loading text updates: "Comparing results..."
- Continue showing loading state until ranked results are returned

**Phase 4: Complete (7s-10s)**
- Loading indicator disappears
- Price context bar renders
- All product cards visible
- "Chat Now" button appears

**Error state:**
- If search fails or times out: "Couldn't find alternatives for this product. Try again?" with retry button.
- If partial results: show what was found with note "Some sources didn't respond — results may be incomplete."

---

## Color & Visual Language

Keep the visual treatment clean and product-focused. The extension UI should not compete with the host page or the product images.

**Palette:**
- Background: warm cream (#FDFAF5)
- Card/surface: white (#FFFFFF)
- Primary accent: orange (#D95A00) — buttons, branding, active states
- Primary hover: dark orange (#B34800)
- Savings indicator: green (#10B981) — percentage badges, "fair/low price" labels
- Warning/high price: red (#EF4444)
- Caution: yellow (#F59E0B)
- Neutral text: dark gray (#1A202C)
- Secondary text: medium gray (#4A5568)
- Borders: light gray (#E5E7EB)

**Typography:**
- Font family: Inter (Google Fonts), sans-serif fallback
- Product titles: 14px, medium weight
- Prices: 16px, bold
- Body text / chat: 14px, regular
- Labels / badges: 12px

**Spacing:**
- Card padding: 12px
- Section gaps: 16px
- Side panel width: 360px (Chrome's default side panel width, not customizable)

**Border radius:**
- Cards: 8px
- Product thumbnails: 8px
- Buttons: 8px
- Overlay icon: 50% (circle)

---

## Interaction Details

### Product Card Interactions
- **Hover:** Subtle elevation change (shadow increase) to indicate clickability
- **Click:** Opens product URL in new tab. Brief press feedback (scale down slightly).

### Chat Input
- **Text mode (default):** Standard text input. Enter key or send button submits via REST `/chat` endpoint.
- **Voice mode (hold-to-talk):** Hold mic button to record. Waveform + timer replace text input while held. Release sends audio via WebSocket `/live`. Assistant responds with audio + transcript.
- **Seamless switching:** Text and voice messages interleave in the same chat thread. No mode toggle needed.

### Side Panel Transitions
- Results → Results+Chat: smooth split animation on first interaction (results compress upward, chat area expands from bottom)
- Price context bar collapses on split (expandable on tap)
- Result cards switch to compact single-row format
- Chat history preserved for the session

---

## Responsive Considerations

The side panel has a fixed width (~360px) determined by Chrome. All layouts are designed for this single width. No responsive breakpoints needed.

**Content overflow:**
- Product titles: truncate with ellipsis at 2 lines
- Results list: scrollable within the panel
- Chat thread: scrollable, auto-scrolls to newest message
- Price context bar: fixed width, scales price markers proportionally

---

## Accessibility

- All interactive elements have visible focus states
- Overlay icons have aria-labels ("Search for cheaper alternatives")
- Product cards are keyboard-navigable (tab order, Enter to activate)
- Chat input supports standard keyboard shortcuts
- Savings percentages and confidence levels are communicated via text, not color alone
- Voice mode has visual feedback (waveform, transcript) alongside audio

---

## Scope Boundaries

**In scope:**
- Overlay icon injection on product images
- Side panel with results view and chat view
- Loading states with phase feedback
- Product cards with price comparison data
- Text and voice chat interface
- Local session caching with visual indicator (green dot)

**Out of scope:**
- Custom themes or dark mode
- Extension popup (side panel is the sole interface)
- Settings page beyond cache clear
- Onboarding flow or tutorial
- Notification system (no push notifications or badges beyond product count)
- Comparison table view (single-product results only for MVP)
- Favorites/bookmarks list
