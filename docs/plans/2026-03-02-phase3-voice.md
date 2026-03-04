# Phase 3: Voice Implementation

**Date:** 2026-03-02
**Depends on:** Phase 1 + Phase 2 complete
**Aligned with:** `docs/plans/2026-03-02-mvp-implementation.md`, `docs/plans/2026-03-02-mvp-implementation-design.md`

## Goal
Add real-time voice conversation in side panel chat using Gemini Live API through backend WebSocket proxy.

Phase complete when users can speak in side panel, receive spoken response audio, and view transcript updates.

## Architecture
- Side panel opens WebSocket to backend `/live`
  - `ws://` for local development
  - `wss://` for production
- Backend opens upstream Gemini Live session and proxies audio/text events.
- Browser captures microphone PCM (16kHz mono) via AudioWorklet pipeline.
- Gemini response audio (24kHz PCM) is queued and played back in side panel.

## Task 1: Backend Live Proxy (`packages/backend/src/ws/live.ts`)
Implement a robust WebSocket bridge that:
1. Creates Gemini Live session on client connect.
2. Accepts client message types from shared `WsClientMessage`:
   - `config`
   - `audio`
   - `text`
3. Emits `WsServerMessage` events back to extension:
   - `audio`
   - `transcript`
   - `turn_complete`
4. Handles lifecycle cleanup on socket close/error.

**Implementation requirements:**
- Use `@google/genai` live API, with model configurable by env (`GEMINI_LIVE_MODEL`).
- Avoid hard-coding preview model IDs where possible.
- Keep payload handling typed to current SDK version (verify with backend typecheck).
- On upstream failures, close client socket with meaningful reason code.

## Task 2: Side Panel Voice Hook (App)
**Files:**
- `packages/extension/src/sidepanel/App.tsx`
- `packages/extension/src/sidepanel/App.css`

Implement voice behavior with a dedicated hook:
1. Open backend `/live` socket.
2. Send initial `config` message with current product/results context.
3. Stream mic audio as 16kHz PCM chunks.
4. Receive and play 24kHz PCM response audio.
5. Append transcript updates into chat UI.
6. Support barge-in behavior (user speech interrupts current playback queue).

**Outdated pattern removed:**
Do not use `ScriptProcessorNode`; use AudioWorklet-based capture for forward compatibility.

## Task 3: AudioWorklet Integration
Add an audio worklet module in extension source and load it from side panel runtime.

**Requirements:**
- Worklet should emit PCM frames suitable for base64 transport.
- Worklet lifecycle must be stopped/cleaned when recording ends.
- Audio playback queue should avoid overlapping fragments unless barge-in is intended.

## Task 4: Permissions and Connectivity Checks
Confirm extension configuration permits live networking to backend origin used in dev.

Validate:
- Background/side panel can reach backend HTTP endpoint.
- Side panel can reach backend WS endpoint.
- Mic permission prompt appears and works in side panel context.

## Task 5: Build + End-to-End Validation
Run:
1. `pnpm build`
2. `pnpm typecheck`

Manual verification:
1. Trigger search flow on product page.
2. Enter chat view.
3. Start mic capture.
4. Speak question and verify transcript progression.
5. Verify audio response playback.
6. Verify stop/restart and barge-in behavior.

## Critical Corrections Applied vs Earlier Draft
- Replaced deprecated `ScriptProcessor` guidance with AudioWorklet requirement.
- Clarified `ws://` dev vs `wss://` production transport.
- Added required `config` handshake and barge-in behavior alignment.
- Added model configurability to reduce breakage from provider model name changes.

## MVP Completion
MVP is complete once all flows pass:
1. Browse -> Detect -> Search -> Compare
2. Compare -> Ask follow-up via text chat
3. Compare -> Ask follow-up via voice
4. Repeat lookup -> cache hit path
