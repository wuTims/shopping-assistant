# Extension Multi-Screen UI Port Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the extension sidepanel to the approved three-screen UX design while preserving all current extension behavior, including product selection, loading states, result rendering, chat, saved links, and settings persistence.

**Architecture:** Introduce a routed sidepanel shell with shared state above the router so `home`, `chat`, and `settings` render the same live extension data without resetting on navigation. Adapt the design bundle’s visual structure to the current extension data flow instead of transplanting the whole generated app stack.

**Tech Stack:** React, React Router, TypeScript, Chrome extension APIs, existing extension sidepanel components, shared package types

---

## File Map

- Modify: `packages/extension/src/sidepanel/index.tsx`
  - Mount router and shared sidepanel state provider.
- Replace/Modify: `packages/extension/src/sidepanel/App.tsx`
  - Convert from monolithic view switcher into app shell composition or remove in favor of routed shell.
- Create: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
  - Centralize message handling, current search state, chat state, saved links, and theme settings.
- Create: `packages/extension/src/sidepanel/routes.tsx`
  - Define `home`, `chat`, and `settings` routes.
- Create: `packages/extension/src/sidepanel/pages/HomePage.tsx`
  - Render the live home/results/product-selection/loading/error experience using the new design language.
- Create: `packages/extension/src/sidepanel/pages/ChatPage.tsx`
  - Render dedicated chat screen with horizontally scrollable compact results strip.
- Create: `packages/extension/src/sidepanel/pages/SettingsPage.tsx`
  - Render theme selection and saved links management.
- Create: `packages/extension/src/sidepanel/components/design/*`
  - Focused presentational components adapted from the design bundle only where needed.
- Modify: `packages/extension/src/sidepanel/index.css`
  - Port theme tokens, gradients, typography, scrollbar styles, and any required layout primitives.
- Optional Modify: `packages/extension/package.json`
  - Add minimal new dependencies if router or icons are not already available in the extension package.
- Create/Modify Tests:
  - `packages/extension/src/sidepanel/__tests__/...`
  - Add targeted route/state/settings tests if the current extension setup supports them cleanly.

## Chunk 1: Shared Routed Shell

### Task 1: Add routed sidepanel shell and shared state provider

**Files:**
- Create: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Create: `packages/extension/src/sidepanel/routes.tsx`
- Modify: `packages/extension/src/sidepanel/index.tsx`
- Modify or Remove: `packages/extension/src/sidepanel/App.tsx`

- [ ] **Step 1: Write the failing route/state test**

Add a test that renders the sidepanel root and expects:
- `/` to render home content
- navigating to `/chat` does not clear existing result state
- navigating to `/settings` does not clear existing result state

- [ ] **Step 2: Run the targeted extension test to verify it fails**

Run the extension-side targeted test command used by this repo.

Expected: FAIL because the sidepanel currently has no router or shared provider.

- [ ] **Step 3: Create the shared state provider**

Move from the current monolithic app into a provider that owns:
- backend message handling
- current tab id
- loading phase timers
- results/product selection state
- chat state and send handler
- saved links
- theme selection

Expose typed hooks such as:

```ts
useSidepanelState()
useSidepanelActions()
```

- [ ] **Step 4: Create router definitions**

Add three routes:

```ts
/
/chat
/settings
```

Wrap them in the provider so route changes do not reset state.

- [ ] **Step 5: Update `index.tsx` to mount the routed shell**

Mount the shared provider + router in place of the old single-screen app entry.

- [ ] **Step 6: Run the route/state test to verify it passes**

Run the same targeted test command from Step 2.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/sidepanel/index.tsx packages/extension/src/sidepanel/App.tsx packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/extension/src/sidepanel/routes.tsx
git commit -m "feat: add routed sidepanel shell"
```

## Chunk 2: Home Screen Port

### Task 2: Port the home screen design onto live extension states

**Files:**
- Create: `packages/extension/src/sidepanel/pages/HomePage.tsx`
- Create/Modify: `packages/extension/src/sidepanel/components/design/Home*.tsx`
- Modify: `packages/extension/src/sidepanel/index.css`

- [ ] **Step 1: Write the failing home-screen rendering tests**

Add tests for:
- empty state renders the designed home shell
- loading state renders product summary plus loading treatment
- product selection renders a scrollable list of products
- results state renders price analysis and a scrollable top-results section

- [ ] **Step 2: Run the targeted home tests to verify they fail**

Expected: FAIL because the new routed home screen does not exist yet.

- [ ] **Step 3: Build the new `HomePage`**

Map current state into the design shell:
- empty
- identifying/loading
- product selection
- error
- results

Preserve:
- multiple product selection behavior
- top-results scrolling
- source product summary
- result count and timing text

- [ ] **Step 4: Port the design styling into extension CSS**

Bring over:
- gradients
- rounded glass cards
- typography scale
- scrollbar styling
- theme variables needed for the home screen

Keep the extension container responsive to sidepanel width instead of hard-coding the full design demo dimensions.

- [ ] **Step 5: Run the home tests to verify they pass**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/sidepanel/pages/HomePage.tsx packages/extension/src/sidepanel/components/design packages/extension/src/sidepanel/index.css
git commit -m "feat: port multi-state home screen design"
```

## Chunk 3: Dedicated Chat Screen

### Task 3: Port the chat screen and preserve existing chat functionality

**Files:**
- Create: `packages/extension/src/sidepanel/pages/ChatPage.tsx`
- Create/Modify: `packages/extension/src/sidepanel/components/design/Chat*.tsx`
- Reuse or Adapt: `packages/extension/src/sidepanel/components/ChatThread.tsx`

- [ ] **Step 1: Write the failing chat tests**

Add tests asserting:
- chat screen renders current messages from shared state
- sending a message uses the existing chat action
- compact product/results strip is horizontally scrollable when result count exceeds 3

- [ ] **Step 2: Run the targeted chat tests to verify they fail**

Expected: FAIL because chat is not yet a dedicated route/screen.

- [ ] **Step 3: Build the dedicated `ChatPage`**

Requirements:
- top bar with back navigation to home
- compact product/result card strip above chat
- preserve current chat thread and input behavior
- make the compact product/result strip horizontally scrollable for more than 3 items

Implementation note:
- use a horizontal overflow container with fixed/min widths per compact card
- do not clip excess items

- [ ] **Step 4: Run the chat tests to verify they pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/pages/ChatPage.tsx packages/extension/src/sidepanel/components/design
git commit -m "feat: port dedicated chat screen"
```

## Chunk 4: Settings Screen and Persistence

### Task 4: Port settings screen with theme and saved links persistence

**Files:**
- Create: `packages/extension/src/sidepanel/pages/SettingsPage.tsx`
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Optional Create: `packages/extension/src/sidepanel/state/settings-storage.ts`

- [ ] **Step 1: Write the failing settings tests**

Add tests asserting:
- saved links render on the settings page
- removing a saved link updates shared state
- changing theme persists and survives provider remount

- [ ] **Step 2: Run the targeted settings tests to verify they fail**

Expected: FAIL because settings route and persistence layer do not exist yet.

- [ ] **Step 3: Build the settings page**

Implement:
- back navigation
- theme palette selection
- saved links list
- saved-link removal

Adapt the design’s theme options, but keep them grounded in extension-safe CSS variables or class tokens.

- [ ] **Step 4: Add persistence**

Persist:
- selected theme
- saved links

Use extension-friendly storage, preferably `chrome.storage.local`, with a lightweight fallback for tests if needed.

- [ ] **Step 5: Run the settings tests to verify they pass**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/sidepanel/pages/SettingsPage.tsx packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/extension/src/sidepanel/state/settings-storage.ts
git commit -m "feat: port settings screen and persistence"
```

## Chunk 5: Cleanup, Integration, and Verification

### Task 5: Remove obsolete UI paths and align existing components

**Files:**
- Modify or Delete: legacy single-screen sidepanel component usage in `packages/extension/src/sidepanel/App.tsx`
- Modify: `packages/extension/src/sidepanel/components/*` as needed

- [ ] **Step 1: Write or update any failing integration tests**

Cover:
- home to chat navigation
- chat back to home
- home to settings navigation
- no state reset across route changes

- [ ] **Step 2: Run targeted integration tests to verify current failures**

Expected: FAIL where old UI assumptions still leak through.

- [ ] **Step 3: Remove obsolete UI glue**

Eliminate duplicated rendering paths from the old one-screen layout while preserving reusable low-level components that still fit the new design.

- [ ] **Step 4: Run the integration tests to verify they pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel
git commit -m "refactor: remove legacy sidepanel flow"
```

### Task 6: Final verification

**Files:**
- Verify only

- [ ] **Step 1: Run targeted extension UI tests**

Run the extension-side test command(s) covering:
- routed shell
- home screen states
- chat page
- settings page

Expected: PASS.

- [ ] **Step 2: Run extension typecheck/build**

Run the extension package verification command(s) used by this repo.

Expected: PASS.

- [ ] **Step 3: Manual verification checklist**

Verify:
- opening sidepanel lands on designed home screen
- product selection list scrolls when many products are present
- results list scrolls properly
- chat route preserves current results context
- compact result strip on chat scrolls horizontally when result count > 3
- settings route shows saved links and theme options
- theme persists after reload
- saved links persist after reload

- [ ] **Step 4: Final commit**

```bash
git add packages/extension/src/sidepanel packages/extension/package.json
git commit -m "feat: port multi-screen extension sidepanel design"
```
