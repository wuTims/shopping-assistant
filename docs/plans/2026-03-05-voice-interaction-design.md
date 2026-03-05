# Voice Interaction & Side Panel UI Design

**Date:** 2026-03-05
**Depends on:** Phase 1 (backend) complete, Phase 2 (extension) in progress
**Aligned with:** `docs/frontend-ux-spec.md`, `docs/plans/2026-03-02-phase3-voice.md`

## Design Decisions

Decisions made during brainstorming that override or refine the original UX spec:

1. **No separate chat view.** Results stay visible at all times. Chat is integrated as a split panel below results, not a view that replaces them.
2. **No "Chat Now" button.** Input bar (text + mic) is always visible at the bottom of the results view. First interaction triggers the split.
3. **Hold-to-talk, not tap-to-toggle.** User holds the mic button to record, releases to send. Avoids always-on streaming costs and feels natural.
4. **Audio + transcript responses.** Assistant speaks back via audio AND shows transcript in chat bubbles. Full voice conversation feel.
5. **Text nudge on load.** When results appear, a small assistant bubble says "I can help you compare — hold 🎤 or type below." Panel doesn't split until user interacts.
6. **WebSocket opens on first mic press, not on results load.** Saves resources.

## Visual Language

Adopted from teammate wireframes (`ui-drafts/`), refined for 360px Chrome side panel constraint.

### Color Palette

| Token | Light | Usage |
|---|---|---|
| `primary` | `#d95a00` | Buttons, accents, brand color |
| `primary-dark` | `#b34800` | Hover/active states |
| `background` | `#fdfaf5` | Warm cream panel background |
| `surface` | `#ffffff` | Cards, sections |
| `text-main` | `#1a202c` | Primary text |
| `text-muted` | `#4a5568` | Secondary text, labels |
| `accent-green` | `#10b981` | Savings badges, positive indicators |
| `accent-red` | `#ef4444` | High price warning |
| `accent-yellow` | `#f59e0b` | Medium/warning indicators |

### Typography

- **Font:** Inter (loaded from Google Fonts)
- Product titles: 14px medium
- Prices: 16px bold
- Body/chat: 14px regular
- Labels/badges: 12px

### Icons

Material Icons throughout. Key icons:
- `shopping_bag` — header branding
- `smart_toy` — AI assistant avatar
- `mic` / `mic_off` — voice input
- `send` — text send
- `warning_amber` — price alerts
- `open_in_new` — external links

### Component Styling

- Cards: `rounded-2xl`, `shadow-soft`, `border border-gray-100`
- Product thumbnails: `rounded-xl`, `object-cover`, `mix-blend-multiply`
- Buttons: `rounded-xl`
- Panel width: 360px (Chrome side panel constraint)

## Branding

- **Name:** "Personal Shopper" (not "Shopping Assistant")
- **Header:** `shopping_bag` icon + "Personal Shopper" text
- **Assistant avatar:** Green circle with `smart_toy` icon

## Side Panel States

### State 1: Empty

Side panel open, no product selected.

```
┌────────────────────────────────┐
│ 🛍 Personal Shopper    ⚙ ✕    │
├────────────────────────────────┤
│                                │
│                                │
│    Click a product overlay     │
│    to find better prices.      │
│                                │
│                                │
└────────────────────────────────┘
```

### State 2: Loading

Search in progress. Three phases of progressive feedback.

```
┌────────────────────────────────┐
│ 🛍 Personal Shopper    ⚙ ✕    │
├────────────────────────────────┤
│ [img] Sony WH-1000XM5         │
│ $298 on Amazon   [You're Here] │
├────────────────────────────────┤
│                                │
│         ◌ (spinner)            │
│   "Identifying product..."     │
│                                │
│ Phase 2: "Searching across     │
│          marketplaces..."      │
│ Phase 3: "Comparing results.." │
│                                │
└────────────────────────────────┘
```

### State 3: Results (initial)

Search complete. Full results with nudge and input bar. No split yet.

```
┌────────────────────────────────┐
│ 🛍 Personal Shopper    ⚙ ✕    │
├────────────────────────────────┤
│ [img] Sony WH-1000XM5         │
│ $298 on Amazon   [You're Here] │
├────────────────────────────────┤
│ ⚠ This price is HIGH           │
│ ▓▓▓▓▓▓▓▓░░ $150 ———————— $500 │
│ 🤖 41% above avg. Best on eBay│
├────────────────────────────────┤
│ Top results (5)                │
│ ┌────────────────────────────┐ │
│ │[img] Sony WH-1000XM5      │ │
│ │eBay           $219  27%less│ │
│ ├────────────────────────────┤ │
│ │[img] Sony WH-1000XM5      │ │
│ │AliExpress     $189  37%less│ │
│ ├────────────────────────────┤ │
│ │[img] Sony WH1000XM5       │ │
│ │Walmart        $278   7%less│ │
│ └────────────────────────────┘ │
├────────────────────────────────┤
│ 🤖 I can help you compare —   │
│    hold 🎤 or type below.     │
├────────────────────────────────┤
│ [Ask about these...     ] [🎤]│
└────────────────────────────────┘
```

### State 4: Recording (hold-to-talk)

User is holding the mic button. Panel splits to make room.

```
┌────────────────────────────────┐
│ 🛍 Personal Shopper    ⚙ ✕    │
├────────────────────────────────┤
│ [img] Sony WH-1000XM5         │
│ $298 on Amazon   [You're Here] │
├─── Results (scroll) ──────────┤
│ [img] eBay          $219  -27%│
│ [img] AliExpress    $189  -37%│
│ [img] Walmart       $278   -7%│
├────────────────────────────────┤
│                                │
│   ≋≋≋▌▌▌▌▌≋≋≋   0:03         │
│                                │
│ [     🔴 Hold to talk        ]│
└────────────────────────────────┘
```

**Details:**
- Results section compresses (price bar collapses, cards become compact single-line rows)
- Waveform + timer replace the text input area
- Mic button turns red and pulses
- Audio streams to backend via WebSocket

### State 5: Results + Chat (split panel)

After first interaction. Persistent split layout.

```
┌────────────────────────────────┐
│ 🛍 Personal Shopper    ⚙ ✕    │
├────────────────────────────────┤
│ [img] Sony WH-1000XM5         │
│ $298 on Amazon   [You're Here] │
├─── Results (scroll) ──────────┤
│ [img] eBay          $219  -27%│
│ [img] AliExpress    $189  -37%│
│ [img] Walmart       $278   -7%│
├─── Chat (scroll) ─────────────┤
│ 🗣 "Which is the best deal?"  │
│                                │
│ 🔊🤖 "The eBay listing at     │
│      $219 is 27% cheaper and  │
│      appears to be the same   │
│      model. AliExpress is     │
│      cheaper but ships from   │
│      China."                   │
├────────────────────────────────┤
│ [Type a message...      ] [🎤]│
└────────────────────────────────┘
```

**Details:**
- Results area: ~40% of scroll space, scrollable, compact card rows
- Chat area: ~60% of scroll space, scrollable, auto-scrolls to latest
- Original product section stays pinned at top
- Price context bar collapses to save space (expandable on tap)
- 🔊 icon on assistant messages indicates audio was played

### State 6: Error

```
┌────────────────────────────────┐
│ 🛍 Personal Shopper    ⚙ ✕    │
├────────────────────────────────┤
│ [img] Sony WH-1000XM5         │
│ $298 on Amazon   [You're Here] │
├────────────────────────────────┤
│                                │
│    Couldn't find alternatives  │
│    for this product.           │
│                                │
│    [ Try Again ]               │
│                                │
├────────────────────────────────┤
│ [Ask about these...     ] [🎤]│
└────────────────────────────────┘
```

## Hold-to-Talk Interaction

### Recording flow

```
mousedown/touchstart on 🎤
  → Request mic permission (first time only)
  → Open WebSocket to /live (if not already open)
  → Send config message with product context + results
  → Start AudioWorklet capture (16kHz PCM mono)
  → UI: button turns red + pulses, waveform appears, timer starts
  → Audio frames stream to backend → Gemini Live API

mouseup/touchend
  → Stop AudioWorklet capture
  → Send turn-complete signal
  → UI: button returns to normal, waveform disappears
  → User's speech appears as 🗣 transcript bubble

Backend streams response:
  → Audio chunks arrive → queue and play through speaker
  → Transcript chunks arrive → 🤖 bubble updates progressively
  → Turn complete → 🔊 icon appears on assistant bubble
```

### Barge-in

If user presses mic while assistant audio is playing:
- Audio playback stops immediately
- New recording starts
- Previous assistant bubble keeps its transcript (no 🔊 icon since interrupted)

### Text input

- Always visible when not recording
- Enter or send button submits via REST `/chat` endpoint (not WebSocket)
- Response appears as text-only 🤖 bubble (no audio, no 🔊 icon)
- Seamlessly interleaved with voice messages in the same chat thread

### WebSocket lifecycle

- Opens on first mic press (not on results load)
- Initial `config` message includes: product identification, ranked results, original price
- Stays open for 30s after last voice interaction
- Idle timeout → close, reopen on next mic press
- No visible connection indicator (keep it simple for hackathon)

## Error Handling

| Scenario | Behavior |
|---|---|
| **Mic permission denied** | Tooltip on mic button: "Mic access needed". Button grayed with ⚠. Text input still works. |
| **WebSocket failure** | Inline message in chat: "Voice unavailable — try text instead". Mic grayed, retry on next press. |
| **Recording < 0.5s** | Ignored as accidental. Brief tooltip: "Hold to talk". |
| **Recording > 30s** | Auto-release at 30s. Timer turns yellow at 25s. |
| **Network loss mid-chat** | Existing bubbles persist. New interactions show "Connection lost". Auto-retry on next mic press. |
| **No results found** | Input bar visible. Nudge: "No alternatives found. Ask me to try different search terms." |
| **Audio playback failure** | Transcript still appears normally. No 🔊 icon. |

## Compact Card Layout

When the panel splits, result cards switch from full to compact format:

**Full card (pre-split):**
```
┌────────────────────────────────┐
│ [img]  Sony WH-1000XM5        │
│        eBay         $219  -27%│
└────────────────────────────────┘
```

**Compact card (post-split):**
```
│ [img] eBay Sony WH-10.. $219 -27%│
```

Single row: 32x32 thumbnail, marketplace, truncated title, price, savings badge. Reduces card height from ~60px to ~40px to maximize chat space.

## Out of Scope (hackathon)

- Dark mode (designed but deferred)
- Bookmark/favorites on result cards
- Settings page beyond cache clear
- Onboarding/tutorial
- Audio waveform visualization during playback (only during recording)
- Typing indicator for text responses (voice has progressive transcript instead)

## Implementation Notes

- The existing `WsClientMessage`/`WsServerMessage` types in shared already support this flow (`config`, `audio`, `text` / `audio`, `transcript`, `turn_complete`)
- Text chat uses REST `/chat` endpoint; voice uses WebSocket `/live`. Both produce bubbles in the same thread.
- `GEMINI_LIVE_MODEL` env var needs to be wired up in `ai-client.ts` for Phase 3
- AudioWorklet must emit PCM frames as base64 for transport over WebSocket
