# Chat Voice Button And Badge Removal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `"You're Here"` badge from the current product card and add a clickable, non-functional voice chat button to the dedicated chat-page composer.

**Architecture:** Keep the current routed sidepanel structure intact. Make the UI change in the existing `ProductSection` and `ChatInput` paths only, then add focused tests covering the removed badge and the new composer controls.

**Tech Stack:** React 19, React Router 7, TypeScript, Tailwind CSS, Vitest, Testing Library

---

## File Structure

**Modify:**
- `packages/extension/src/sidepanel/components/ProductSection.tsx`
- `packages/extension/src/sidepanel/routes.tsx`
- `packages/extension/src/sidepanel/__tests__/shell.test.tsx`
- `packages/extension/src/sidepanel/__tests__/chat.test.tsx`

---

## Chunk 1: Tests First

### Task 1: Add failing assertions for the removed badge and new voice button

**Files:**
- Modify: `packages/extension/src/sidepanel/__tests__/shell.test.tsx`
- Modify: `packages/extension/src/sidepanel/__tests__/chat.test.tsx`

- [ ] **Step 1: Write the failing tests**
Add assertions that:
- the results screen does not render `"You're Here"`
- the chat page renders a `Voice chat` button
- the chat page renders a `Send message` button
- the voice button appears before the send button in DOM order

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @shopping-assistant/extension test -- src/sidepanel/__tests__/shell.test.tsx src/sidepanel/__tests__/chat.test.tsx
```

Expected: FAIL

## Chunk 2: Minimal UI Implementation

### Task 2: Remove the badge and add the clickable voice button

**Files:**
- Modify: `packages/extension/src/sidepanel/components/ProductSection.tsx`
- Modify: `packages/extension/src/sidepanel/routes.tsx`

- [ ] **Step 1: Remove the product-card badge**
Delete the right-side `"You're Here"` pill from `ProductSection.tsx` while preserving the current layout.

- [ ] **Step 2: Add the voice button**
Update `ChatInput()` in `routes.tsx` to add:
- a `type="button"` mic button
- `aria-label="Voice chat"`
- placement immediately left of the send button
- a no-op click handler

Also add `aria-label="Send message"` to the send button for stable testing.

- [ ] **Step 3: Run tests to verify they pass**

Run:
```bash
pnpm --filter @shopping-assistant/extension test -- src/sidepanel/__tests__/shell.test.tsx src/sidepanel/__tests__/chat.test.tsx
```

Expected: PASS

## Chunk 3: Final Verification

### Task 3: Verify the extension build

**Files:**
- Verify only

- [ ] **Step 1: Run focused tests**

Run:
```bash
pnpm --filter @shopping-assistant/extension test -- src/sidepanel/__tests__/shell.test.tsx src/sidepanel/__tests__/chat.test.tsx
```

Expected: PASS

- [ ] **Step 2: Run extension typecheck**

Run:
```bash
pnpm --filter @shopping-assistant/extension typecheck
```

Expected: PASS

- [ ] **Step 3: Run extension build**

Run:
```bash
pnpm --filter @shopping-assistant/extension build
```

Expected: PASS
