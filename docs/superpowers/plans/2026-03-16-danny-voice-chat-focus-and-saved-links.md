# 3-16 Danny Voice, Chat Focus, Saved Links, And Deployment Priorities Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the extension's voice-chat quality and continuity, add explicit product focus for chat/voice, make saved links open the real product URL, and keep the existing deployment work grouped as the lowest-priority track for the day.

**Architecture:** Treat chat, voice, and saved-link fixes as one shared context problem rather than isolated UI patches. Introduce an explicit focused-item model in sidepanel state, persist voice transcripts into normal chat history when sessions end, and verify whether saved-link URLs are missing in storage or only missing in rendering before changing the data model. Keep the GCP/Cloud Run deployment work as a separate final chunk with no priority overlap with the product UX work.

**Tech Stack:** React, TypeScript, Chrome Extension APIs, WebSocket Gemini Live proxy, AudioWorklet, Hono backend, Vitest.

---

## Priority Order For Today

1. Voice transcript persistence
2. Saved links open real product URLs
3. Chat product-focus selector
4. Shared focus context for text + voice
5. Voice context expansion
6. Voice audio quality cleanup
7. Deployment track last

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx` | Add focused-item state, transcript persistence hooks, saved-link behavior, and shared context assembly |
| Modify | `packages/extension/src/sidepanel/routes.tsx` | Add chat focus UI, saved-link open actions if rendered here, and any voice status presentation tied to persisted history |
| Modify | `packages/extension/src/sidepanel/components/ChatThread.tsx` | Render persisted voice turns alongside text turns and keep live transcript UI separate from committed history |
| Modify | `packages/extension/src/sidepanel/hooks/useVoice.ts` | Commit live transcripts into durable history callbacks, improve session lifecycle, and adjust audio pipeline behavior |
| Modify | `packages/extension/src/sidepanel/components/ResultCard.tsx` | Ensure bookmark/save actions preserve the real destination URL |
| Modify | `packages/extension/src/sidepanel/state/settings-storage.ts` | Persist any new saved-link fields or focused-item preferences if needed |
| Modify | `packages/extension/src/test/setup.ts` | Expand mocks for audio/permissions/window opening if needed by new tests |
| Modify | `packages/shared/src/types.ts` | Add any minimal shared types for focused chat context or persisted voice turns |
| Modify | `packages/backend/src/ws/live.ts` | Expand voice-session context payload and, only if needed, improve output metadata handling |
| Modify | `packages/backend/src/routes/chat.ts` | Honor focused-item context in text chat if current route payload is too broad |
| Modify | `packages/extension/src/manifest.json` | Only if opening saved links or mic flow requires additional host/runtime handling |
| Test | `packages/extension/src/sidepanel/__tests__/chat.test.tsx` | Chat route rendering, focus selector, voice transcript persistence |
| Test | `packages/extension/src/sidepanel/__tests__/saved-links.test.tsx` | Saved-link creation and clickable/openable behavior |
| Test | `packages/extension/src/sidepanel/__tests__/useVoice.test.ts` | Voice lifecycle, persistence callbacks, and audio-state behavior |
| Test | `packages/backend/src/ws/__tests__/live.test.ts` | Voice websocket context and session-message expectations |
| Doc | `docs/superpowers/plans/2026-03-16-gcp-deployment-cicd.md` | Existing deployment track kept grouped as lowest priority |

---

## Chunk 1: Persist Voice Sessions Into Normal Chat History

### Task 1: Define the persisted voice-turn model

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Test: `packages/extension/src/sidepanel/__tests__/chat.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a test proving that when a voice session ends with input/output transcripts present, the sidepanel state exposes durable chat messages for both turns instead of dropping them when live voice state resets.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/chat.test.tsx
```

Expected: FAIL because current voice transcripts are only transient UI fields.

- [ ] **Step 3: Write minimal implementation**

Add the smallest shared/state shape needed so committed voice turns can be appended into existing chat history with `inputMode: "voice"`.

- [ ] **Step 4: Run test to verify it passes**

Run the same command.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/extension/src/sidepanel/__tests__/chat.test.tsx
git commit -m "feat(extension): persist completed voice turns into chat history"
```

### Task 2: Commit transcripts on voice-session end

**Files:**
- Modify: `packages/extension/src/sidepanel/hooks/useVoice.ts`
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Modify: `packages/extension/src/sidepanel/components/ChatThread.tsx`
- Test: `packages/extension/src/sidepanel/__tests__/useVoice.test.ts`

- [ ] **Step 1: Write the failing test**

Add a hook test proving `endSession()` commits any final user/assistant transcripts through a callback before clearing transient voice state.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/useVoice.test.ts
```

Expected: FAIL because `useVoice` currently clears state without persisting the conversation.

- [ ] **Step 3: Write minimal implementation**

Add a persistence callback from `SidepanelStateContext` into `useVoice`, commit non-empty `voiceInputTranscript` / `voiceOutputTranscript` to normal chat history on session completion, and keep live transcript bubbles visible only while the session is active.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/useVoice.test.ts src/sidepanel/__tests__/chat.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/hooks/useVoice.ts packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/extension/src/sidepanel/components/ChatThread.tsx packages/extension/src/sidepanel/__tests__/useVoice.test.ts packages/extension/src/sidepanel/__tests__/chat.test.tsx
git commit -m "feat(extension): commit completed Gemini Live transcripts to chat history"
```

---

## Chunk 2: Make Saved Links Save And Open The Real Product URL

### Task 3: Verify whether saved-link URL loss is storage or rendering

**Files:**
- Modify: `packages/extension/src/sidepanel/__tests__/saved-links.test.tsx`
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Modify: `packages/extension/src/sidepanel/routes.tsx`

- [ ] **Step 1: Write the failing test**

Add a test that saves a result and asserts the stored saved-link entry includes `productUrl`, then assert the settings screen exposes a clickable/openable action for that URL.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/saved-links.test.tsx
```

Expected: FAIL with either missing stored URL or non-clickable rendering.

- [ ] **Step 3: Write minimal implementation**

If `productUrl` is already stored, only fix rendering and open behavior. If not, update save logic in `SidepanelStateContext` so bookmarks preserve `ranked.result.productUrl`, then render an explicit open action in settings.

- [ ] **Step 4: Run test to verify it passes**

Run the same command.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/extension/src/sidepanel/routes.tsx packages/extension/src/sidepanel/__tests__/saved-links.test.tsx
git commit -m "fix(extension): save and open real product URLs from saved links"
```

### Task 4: Harden saved-link opening behavior

**Files:**
- Modify: `packages/extension/src/sidepanel/routes.tsx`
- Modify: `packages/extension/src/sidepanel/components/ResultCard.tsx`
- Modify: `packages/extension/src/test/setup.ts`
- Test: `packages/extension/src/sidepanel/__tests__/saved-links.test.tsx`

- [ ] **Step 1: Write the failing test**

Add coverage that clicking a saved-link open control uses the stored `productUrl`, does not trigger deletion, and ignores malformed URLs safely.

- [ ] **Step 2: Run test to verify it fails**

Run the saved-links test again.

- [ ] **Step 3: Write minimal implementation**

Use a shared safe-open helper or the existing result-card behavior pattern to open only valid `http/https` URLs.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/saved-links.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/routes.tsx packages/extension/src/sidepanel/components/ResultCard.tsx packages/extension/src/test/setup.ts packages/extension/src/sidepanel/__tests__/saved-links.test.tsx
git commit -m "fix(extension): harden saved-link open behavior"
```

---

## Chunk 3: Add Explicit Product Focus To Chat And Voice

### Task 5: Add focused-item state to the sidepanel model

**Files:**
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Modify: `packages/shared/src/types.ts`
- Test: `packages/extension/src/sidepanel/__tests__/chat.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a test that when multiple result candidates exist, the sidepanel exposes a default focused item and allows switching the focus target without losing chat history.

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/chat.test.tsx
```

- [ ] **Step 3: Write minimal implementation**

Add a focused-item state object that can point at:
- the current source product
- one of the ranked result items

Default to the current source product unless the user changes it.

- [ ] **Step 4: Run test to verify it passes**

Run the same command.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/shared/src/types.ts packages/extension/src/sidepanel/__tests__/chat.test.tsx
git commit -m "feat(extension): add focused chat item state"
```

### Task 6: Render a focus selector on the chat page

**Files:**
- Modify: `packages/extension/src/sidepanel/routes.tsx`
- Modify: `packages/extension/src/sidepanel/components/ChatThread.tsx`
- Test: `packages/extension/src/sidepanel/__tests__/chat.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a UI test proving the chat route renders a focus selector, includes the current product and visible alternatives, and updates the active label when the user changes focus.

- [ ] **Step 2: Run test to verify it fails**

Run the chat test file again.

- [ ] **Step 3: Write minimal implementation**

Implement a compact selector on the chat page. It should:
- clearly show the currently focused item
- allow switching to another visible result
- not navigate away or reset the chat

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/chat.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/routes.tsx packages/extension/src/sidepanel/components/ChatThread.tsx packages/extension/src/sidepanel/__tests__/chat.test.tsx
git commit -m "feat(extension): add chat focus selector for current product and results"
```

---

## Chunk 4: Use Focused Context In Text Chat And Voice Chat

### Task 7: Narrow text-chat context to the focused item

**Files:**
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Modify: `packages/backend/src/routes/chat.ts`
- Test: `packages/extension/src/sidepanel/__tests__/chat.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a test proving that when a result is focused, the chat request payload includes that result as the primary context rather than only the broad current product + all results bundle.

- [ ] **Step 2: Run test to verify it fails**

Run the chat test file.

- [ ] **Step 3: Write minimal implementation**

Extend the chat payload so it preserves existing context but clearly marks the focused item. Keep compatibility with the current backend route by adding fields rather than replacing the whole payload unless the shared type already supports it cleanly.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/chat.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/backend/src/routes/chat.ts packages/extension/src/sidepanel/__tests__/chat.test.tsx
git commit -m "feat(chat): include focused item context in text chat requests"
```

### Task 8: Narrow voice-session context to the focused item

**Files:**
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Modify: `packages/extension/src/sidepanel/hooks/useVoice.ts`
- Modify: `packages/backend/src/ws/live.ts`
- Test: `packages/backend/src/ws/__tests__/live.test.ts`
- Test: `packages/extension/src/sidepanel/__tests__/useVoice.test.ts`

- [ ] **Step 1: Write the failing tests**

Add:
- a backend websocket test proving `config.context` carries focused-item metadata
- a hook/state test proving the voice hook receives updated focused context after user selection

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\backend\node_modules\.bin\vitest.cmd' run packages/backend/src/ws/__tests__/live.test.ts
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/useVoice.test.ts
```

- [ ] **Step 3: Write minimal implementation**

Ensure the voice session config includes:
- current source product
- active focused item
- top results
- enough metadata to explain why the focused item matters

Send this once on session start and restart the voice session only if necessary when focus changes mid-session.

- [ ] **Step 4: Run tests to verify they pass**

Run both commands again.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/extension/src/sidepanel/hooks/useVoice.ts packages/backend/src/ws/live.ts packages/backend/src/ws/__tests__/live.test.ts packages/extension/src/sidepanel/__tests__/useVoice.test.ts
git commit -m "feat(voice): send focused-item context to Gemini Live sessions"
```

---

## Chunk 5: Expand Voice Context Beyond The Bare Minimum

### Task 9: Enrich the live-session product/result context payload

**Files:**
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`
- Modify: `packages/backend/src/ws/live.ts`
- Test: `packages/backend/src/ws/__tests__/live.test.ts`

- [ ] **Step 1: Write the failing test**

Add a websocket test proving the session-start payload includes:
- focused item
- current product
- top ranked results
- price/marketplace summary
- enough concise context for comparative shopping answers

- [ ] **Step 2: Run test to verify it fails**

Run the backend live websocket test file.

- [ ] **Step 3: Write minimal implementation**

Replace the current simple context text assembly with a concise structured summary that makes ranking and focus legible without dumping excessive JSON into the live model.

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\backend\node_modules\.bin\vitest.cmd' run packages/backend/src/ws/__tests__/live.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/state/SidepanelStateContext.tsx packages/backend/src/ws/live.ts packages/backend/src/ws/__tests__/live.test.ts
git commit -m "feat(voice): enrich Gemini Live session context with focused product details"
```

---

## Chunk 6: Improve Voice Audio Quality

### Task 10: Lock down the current voice audio pipeline with tests

**Files:**
- Modify: `packages/extension/src/sidepanel/__tests__/useVoice.test.ts`
- Modify: `packages/extension/src/test/setup.ts`
- Modify: `packages/extension/src/sidepanel/hooks/useVoice.ts`

- [ ] **Step 1: Write the failing test**

Add tests around:
- output sample-rate assumptions
- chunk sizing sent to the backend
- playback buffering behavior when audio frames arrive back-to-back

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/useVoice.test.ts
```

- [ ] **Step 3: Write minimal implementation**

Instrument the voice hook enough to verify whether metallic/raspy playback is likely caused by:
- bad buffer scheduling
- PCM conversion issues
- sample-rate mismatch between `VOICE_OUTPUT_SAMPLE_RATE` and playback context

Make only the smallest change needed to stabilize the pipeline.

- [ ] **Step 4: Run test to verify it passes**

Run the same command.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/__tests__/useVoice.test.ts packages/extension/src/test/setup.ts packages/extension/src/sidepanel/hooks/useVoice.ts
git commit -m "test(voice): cover output buffering and playback assumptions"
```

### Task 11: Fix the metallic/raspy voice issue at the source

**Files:**
- Modify: `packages/extension/src/sidepanel/hooks/useVoice.ts`
- Modify: `packages/backend/src/ws/live.ts`
- Test: `packages/extension/src/sidepanel/__tests__/useVoice.test.ts`
- Test: `packages/backend/src/ws/__tests__/live.test.ts`

- [ ] **Step 1: Form the root-cause hypothesis**

Use the failing/diagnostic tests from Task 10 to identify the precise defect before changing code. Common expected causes:
- wrong PCM interpretation
- output resampling mismatch
- frame boundaries producing audible artifacts

- [ ] **Step 2: Write the smallest failing test for the confirmed cause**

Add or refine one targeted test that reproduces the exact pipeline defect.

- [ ] **Step 3: Implement the minimal fix**

Adjust the output pipeline only as far as required. Do not mix in unrelated voice UX changes in this task.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/useVoice.test.ts
& 'C:\dev\repos\shopping-assistant\packages\backend\node_modules\.bin\vitest.cmd' run packages/backend/src/ws/__tests__/live.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/hooks/useVoice.ts packages/backend/src/ws/live.ts packages/extension/src/sidepanel/__tests__/useVoice.test.ts packages/backend/src/ws/__tests__/live.test.ts
git commit -m "fix(voice): improve Gemini Live playback quality"
```

---

## Chunk 7: Lowest Priority Today — Keep Deployment Work Grouped

### Task 12: Preserve the deployment track as a separate end-of-day bucket

**Files:**
- Reference: `docs/superpowers/plans/2026-03-16-gcp-deployment-cicd.md`

- [ ] **Step 1: Keep the deployment work grouped and deferred**

When executing this plan, do not start the deployment track until the voice/chat/saved-link work above is complete or explicitly deprioritized by the user.

- [ ] **Step 2: Treat these as one grouped deployment bucket**

Deployment bucket contents:
- Cloud Run deployment
- Secret Manager wiring
- Dockerfile/runtime packaging fixes
- GitHub Actions CI/CD
- configurable production CORS
- basic backend rate limiting
- extension production backend URL/host permissions
- AliExpress Secret Manager token write-back

- [ ] **Step 3: Use the existing deployment plan as the source of truth**

Implementation details live in:

`docs/superpowers/plans/2026-03-16-gcp-deployment-cicd.md`

No duplicate deployment sub-plan is needed unless the deployment scope changes.

---

## Verification Matrix

- Voice transcripts remain visible in chat after ending a voice session.
- Focus selection changes what both text chat and voice chat talk about.
- Saved links open the actual saved product page.
- Voice session startup sends stronger focused context.
- Voice playback quality is improved or, at minimum, instrumented with a verified root cause before further changes.
- Deployment work remains grouped and lowest priority for the day.

## Final Verification Commands

```powershell
& 'C:\dev\repos\shopping-assistant\packages\extension\node_modules\.bin\vitest.cmd' run src/sidepanel/__tests__/chat.test.tsx src/sidepanel/__tests__/saved-links.test.tsx src/sidepanel/__tests__/useVoice.test.ts
& 'C:\dev\repos\shopping-assistant\packages\backend\node_modules\.bin\vitest.cmd' run packages/backend/src/ws/__tests__/live.test.ts
& 'C:\Users\dand5\AppData\Roaming\npm\pnpm.cmd' --filter @shopping-assistant/extension typecheck
& 'C:\Users\dand5\AppData\Roaming\npm\pnpm.cmd' --filter @shopping-assistant/extension build
& 'C:\Users\dand5\AppData\Roaming\npm\pnpm.cmd' --filter @shopping-assistant/backend typecheck
```

Expected:
- all targeted tests pass
- extension typecheck/build pass
- backend typecheck passes

## Suggested Commit Sequence

1. `feat(extension): persist completed voice turns into chat history`
2. `fix(extension): save and open real product URLs from saved links`
3. `feat(extension): add chat focus selector for current product and results`
4. `feat(chat): include focused item context in text chat requests`
5. `feat(voice): send focused-item context to Gemini Live sessions`
6. `feat(voice): enrich Gemini Live session context with focused product details`
7. `fix(voice): improve Gemini Live playback quality`

