# Gemini Live Voice Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable real-time voice conversation in the side panel using Gemini Live API, proxied through the backend WebSocket endpoint, so users get an in-store shopping assistant experience.

**Architecture:** The side panel captures microphone audio via AudioWorklet (16kHz PCM), streams it over WebSocket to the backend `/live` endpoint. The backend uses `@google/genai` SDK's `ai.live.connect()` to open an upstream Gemini Live session. Audio streams use `sendRealtimeInput()` for low-latency forwarding; text messages use `sendClientContent()` for ordered turn-based delivery (matching the existing chat endpoint's history pattern). The mic toggle pauses/resumes capture and signals `audioStreamEnd` to the upstream — it does NOT tear down the session. Response audio (24kHz PCM) is played back in the side panel. Transcripts update the chat UI in real-time. The backend also handles `goAway` (connection expiry warnings) and `sessionResumptionUpdate` (reconnection tokens) from the upstream.

**Tech Stack:** `@google/genai` SDK (live API), Hono WebSocket (`@hono/node-ws`), Web Audio API (AudioWorklet + AudioContext), React 19 hooks, TypeScript strict mode.

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `packages/shared/src/types.ts` | Expand `WsServerMessage` with `interrupted`, `error`, `goAway`, `session_resumption`, split transcripts; expand `WsClientMessage` with `audioStreamEnd` |
| Modify | `packages/shared/src/constants.ts` | Add voice constants (sample rates, buffer size, session limit) |
| Modify | `packages/extension/src/manifest.json` | Add `web_accessible_resources` for AudioWorklet |
| Modify | `packages/extension/src/test/setup.ts` | Add Audio API mocks for existing tests |
| Modify | `packages/backend/src/services/ai-client.ts` | Export `liveModel` constant |
| Rewrite | `packages/backend/src/ws/live.ts` | Full Gemini Live proxy implementation |
| Create | `packages/backend/src/ws/__tests__/live.test.ts` | Backend WS proxy unit tests |
| Create | `packages/extension/src/sidepanel/hooks/useVoice.ts` | Voice hook: WS + mic + playback lifecycle |
| Create | `packages/extension/src/sidepanel/audio-worklet-processor.js` | AudioWorklet for PCM capture |
| Create | `packages/extension/src/sidepanel/__tests__/useVoice.test.ts` | Voice hook unit tests |
| Modify | `packages/extension/src/sidepanel/components/ChatThread.tsx` | Wire mic button to voice hook |
| Modify | `packages/extension/src/sidepanel/routes.tsx` | Wire voice into ChatRoute + ChatInput |
| Modify | `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx` | Add voice message handling |

---

## Chunk 1: Shared Types + Constants + Backend Proxy

### Task 1: Expand Shared WebSocket Types

**Files:**
- Modify: `packages/shared/src/types.ts` (search for `WsServerMessage`)

The current `WsServerMessage` only has `audio`, `transcript`, and `turn_complete`. We need to:
- Split `transcript` into `input_transcript` (user speech) and `output_transcript` (model speech) — these are delivered independently with **no guaranteed ordering** from the Live API.
- Add `interrupted` (barge-in), `error`, `go_away` (connection expiry warning), and `session_resumption` (reconnection token).
- Add `audioStreamEnd` to `WsClientMessage` so the client can signal end-of-mic-input without closing the session.

> **Note:** Use text matching to locate the type, not line numbers — line numbers may drift as the file evolves.

- [ ] **Step 1: Update `WsServerMessage` type**

In `packages/shared/src/types.ts`, find and replace the existing `WsServerMessage` union:

```typescript
// Old:
export type WsServerMessage =
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 24000; data: string }
  | { type: "transcript"; content: string }
  | { type: "turn_complete" };
```

With:

```typescript
export type WsServerMessage =
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 24000; data: string }
  | { type: "input_transcript"; content: string }
  | { type: "output_transcript"; content: string }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | { type: "go_away"; timeLeftMs: number }
  | { type: "session_resumption"; token: string }
  | { type: "error"; message: string };
```

- [ ] **Step 1b: Update `WsClientMessage` type**

In the same file, find `WsClientMessage` and add `audioStreamEnd`:

```typescript
// Old:
export type WsClientMessage =
  | { type: "config"; context: Record<string, unknown> }
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 16000; data: string }
  | { type: "text"; content: string };
```

With:

```typescript
export type WsClientMessage =
  | { type: "config"; context: Record<string, unknown> }
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 16000; data: string }
  | { type: "text"; content: string }
  | { type: "audioStreamEnd" };
```

- [ ] **Step 2: Run typecheck to identify downstream breakage**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm typecheck`

Expected: The shared package builds fine. Backend `live.ts` may show an error on the old `"transcript"` type — that's expected and will be fixed in Task 3.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): expand WsServerMessage with interrupted, error, split transcripts"
```

---

### Task 2: Add Voice Constants

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Add voice constants to end of file**

Append to `packages/shared/src/constants.ts`:

```typescript
// Voice / Gemini Live API
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000;
export const VOICE_WORKLET_BUFFER_SIZE = 640; // 40ms at 16kHz — Google recommends 20-40ms chunks
export const VOICE_SESSION_MAX_MS = 15 * 60 * 1000; // Gemini Live API audio-only session limit
export const VOICE_SESSION_TIMEOUT_BUFFER_MS = 30 * 1000; // Warn client 30s before expiry
```

- [ ] **Step 2: Build shared**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared`
Expected: Clean build.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): add voice constants for sample rates, buffer size, session limit"
```

---

### Task 3: Export Live Model from AI Client

**Files:**
- Modify: `packages/backend/src/services/ai-client.ts`

- [ ] **Step 1: Add liveModel export**

Add this line to `packages/backend/src/services/ai-client.ts` after the `embeddingModel` export (line 5):

```typescript
export const liveModel =
  process.env.GEMINI_LIVE_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
```

Note: `gemini-2.0-flash-live-001` was **shut down December 9, 2025** per the Gemini deprecations page. The current recommended Live API model is `gemini-2.5-flash-native-audio-preview-12-2025`. The env var allows swapping at deployment time without code changes.

- [ ] **Step 2: Run typecheck**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm typecheck`
Expected: Backend compiles cleanly (the old `live.ts` `"transcript"` type error will still appear — fixed next task).

- [ ] **Step 3: Commit**

```bash
git add packages/backend/src/services/ai-client.ts
git commit -m "feat(backend): export configurable liveModel for Gemini Live API"
```

---

### Task 4: Implement Backend Live Proxy

**Files:**
- Rewrite: `packages/backend/src/ws/live.ts`

This is the core of the integration. The backend WS handler:
1. Receives a `config` message from the client with product context.
2. Opens an upstream Gemini Live session via `ai.live.connect()`.
3. Proxies `audio` via `sendRealtimeInput()` (low-latency streaming) and `text` via `sendClientContent()` (ordered turn delivery, matching `chat.ts` history pattern).
4. Forwards `audioStreamEnd` from client to signal mic-off without closing the session.
5. Relays upstream responses (audio, transcripts, turn_complete, interrupted, goAway, sessionResumptionUpdate) back to client.
6. Enforces a server-side session timeout and handles the `closed` race condition (client disconnect during async `ai.live.connect()`).
7. Cleans up on disconnect.

> **Important SDK contract:** The `@google/genai` SDK delivers callbacks with typed objects, NOT DOM events. `callbacks.onmessage` receives `LiveServerMessage` (already parsed), not `MessageEvent`. Do NOT use `JSON.parse(event.data)` — access `message.serverContent`, `message.goAway`, `message.sessionResumptionUpdate`, `message.setupComplete` directly.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/ws/__tests__/live.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @google/genai before importing live module
const mockSession = {
  sendRealtimeInput: vi.fn(),
  sendClientContent: vi.fn(),
  close: vi.fn(),
};

const mockConnect = vi.fn().mockResolvedValue(mockSession);

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    live: { connect: mockConnect },
  })),
  Modality: { AUDIO: "AUDIO" },
}));

// Must import after mocks
// Dynamic import after vi.mock — use .js extension per ESM convention.
// If this fails, try "../live" without extension.
const { liveWebSocket } = await import("../live.js");

function createMockWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
}

describe("liveWebSocket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns WSEvents with onOpen, onMessage, onClose, onError", () => {
    const events = liveWebSocket({});
    expect(events.onOpen).toBeDefined();
    expect(events.onMessage).toBeDefined();
    expect(events.onClose).toBeDefined();
  });

  it("does not open upstream session until config message", () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("opens upstream session on config message with product context", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    const configMsg = JSON.stringify({
      type: "config",
      context: { product: { name: "Test Sneaker" }, results: [] },
    });

    await events.onMessage!({ data: configMsg } as MessageEvent, ws as any);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    const connectArgs = mockConnect.mock.calls[0][0];
    expect(connectArgs.model).toBeDefined();
    expect(connectArgs.config.responseModalities).toContain("AUDIO");
  });

  it("forwards audio messages via sendRealtimeInput", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "config", context: {} }) } as MessageEvent,
      ws as any,
    );

    const audioMsg = JSON.stringify({
      type: "audio",
      encoding: "pcm_s16le",
      sampleRateHz: 16000,
      data: "AAAA",
    });
    await events.onMessage!({ data: audioMsg } as MessageEvent, ws as any);

    expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
      audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" },
    });
  });

  it("forwards text messages via sendClientContent (ordered turns)", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "config", context: {} }) } as MessageEvent,
      ws as any,
    );

    await events.onMessage!(
      { data: JSON.stringify({ type: "text", content: "hello" }) } as MessageEvent,
      ws as any,
    );

    expect(mockSession.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: "user", parts: [{ text: "hello" }] }],
      turnComplete: true,
    });
  });

  it("forwards audioStreamEnd to upstream", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "config", context: {} }) } as MessageEvent,
      ws as any,
    );

    await events.onMessage!(
      { data: JSON.stringify({ type: "audioStreamEnd" }) } as MessageEvent,
      ws as any,
    );

    expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
      audioStreamEnd: true,
    });
  });

  it("sends error if audio/text received before config", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "audio", encoding: "pcm_s16le", sampleRateHz: 16000, data: "AA" }) } as MessageEvent,
      ws as any,
    );

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"error"'),
    );
  });

  it("closes upstream session on client disconnect", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "config", context: {} }) } as MessageEvent,
      ws as any,
    );

    events.onClose!({} as CloseEvent, ws as any);
    expect(mockSession.close).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && npx vitest run packages/backend/src/ws/__tests__/live.test.ts`
Expected: FAIL — current `live.ts` doesn't have the session management logic.

- [ ] **Step 3: Implement the live proxy**

Rewrite `packages/backend/src/ws/live.ts`:

```typescript
import type { WSContext, WSEvents } from "hono/ws";
import { Modality } from "@google/genai";
import type { Session, LiveServerMessage } from "@google/genai";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";
import { VOICE_SESSION_MAX_MS, VOICE_SESSION_TIMEOUT_BUFFER_MS } from "@shopping-assistant/shared";
import { ai, liveModel } from "../services/ai-client.js";

function buildSystemInstruction(context: Record<string, unknown>): string {
  const product = context.product as Record<string, unknown> | undefined;
  const results = context.results as unknown[] | undefined;

  let instruction =
    "You are a helpful shopping assistant. The user is browsing a product online " +
    "and has found search results for cheaper alternatives. Help them compare options, " +
    "answer questions about products, and make purchase decisions. Be concise and conversational.";

  if (product) {
    instruction += `\n\nCurrent product: ${JSON.stringify(product)}`;
  }
  if (results && results.length > 0) {
    const top = results.slice(0, 5);
    instruction += `\n\nTop search results:\n${JSON.stringify(top)}`;
  }

  return instruction;
}

function sendToClient(ws: WSContext, message: WsServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Client may have disconnected
  }
}

export function liveWebSocket(_c: unknown): WSEvents {
  let upstream: Session | null = null;
  let configReceived = false;
  let closed = false; // Guards against race: client disconnect during async connect()
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;

  function cleanupTimer(): void {
    if (sessionTimer) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
  }

  return {
    onOpen(_evt, ws) {
      console.log("[live] Client connected");
    },

    async onMessage(evt, ws) {
      if (closed) return;

      let message: WsClientMessage;
      try {
        message = JSON.parse(String(evt.data)) as WsClientMessage;
      } catch {
        sendToClient(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      if (message.type === "config") {
        if (configReceived) {
          sendToClient(ws, { type: "error", message: "Config already sent" });
          return;
        }
        configReceived = true;

        const systemInstruction = buildSystemInstruction(message.context);

        try {
          const session = await ai.live.connect({
            model: liveModel,
            config: {
              responseModalities: [Modality.AUDIO],
              systemInstruction: { parts: [{ text: systemInstruction }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
            callbacks: {
              onopen() {
                console.log("[live] Upstream session opened");
              },
              // SDK delivers LiveServerMessage (pre-parsed), NOT MessageEvent
              onmessage(message: LiveServerMessage) {
                // --- serverContent: audio, transcripts, interruptions ---
                const sc = message.serverContent;
                if (sc) {
                  if (sc.modelTurn?.parts) {
                    for (const part of sc.modelTurn.parts) {
                      if (part.inlineData?.data) {
                        sendToClient(ws, {
                          type: "audio",
                          encoding: "pcm_s16le",
                          sampleRateHz: 24000,
                          data: part.inlineData.data,
                        });
                      }
                    }
                  }

                  // Transcriptions arrive independently — no guaranteed ordering
                  if (sc.inputTranscription?.text) {
                    sendToClient(ws, {
                      type: "input_transcript",
                      content: sc.inputTranscription.text,
                    });
                  }
                  if (sc.outputTranscription?.text) {
                    sendToClient(ws, {
                      type: "output_transcript",
                      content: sc.outputTranscription.text,
                    });
                  }

                  if (sc.interrupted === true) {
                    sendToClient(ws, { type: "interrupted" });
                  }
                  if (sc.turnComplete === true) {
                    sendToClient(ws, { type: "turn_complete" });
                  }
                }

                // --- goAway: upstream warns connection is expiring ---
                if (message.goAway) {
                  const timeLeftMs = message.goAway.timeLeft
                    ? parseInt(String(message.goAway.timeLeft), 10) * 1000
                    : 0;
                  console.log(`[live] GoAway received, ${timeLeftMs}ms remaining`);
                  sendToClient(ws, { type: "go_away", timeLeftMs });
                }

                // --- sessionResumptionUpdate: token for reconnection ---
                if (message.sessionResumptionUpdate?.newHandle) {
                  sendToClient(ws, {
                    type: "session_resumption",
                    token: message.sessionResumptionUpdate.newHandle,
                  });
                }

                // --- setupComplete: upstream ready (informational) ---
                if (message.setupComplete) {
                  console.log("[live] Upstream setup complete");
                }
              },
              onerror(event: ErrorEvent) {
                console.error("[live] Upstream error:", event.message);
                sendToClient(ws, {
                  type: "error",
                  message: "Voice service error",
                });
              },
              onclose() {
                console.log("[live] Upstream session closed");
                upstream = null;
                cleanupTimer();
              },
            },
          });

          // Race condition guard: if client disconnected while we were awaiting
          if (closed) {
            session.close();
            return;
          }

          upstream = session;

          // Enforce server-side session timeout
          sessionTimer = setTimeout(() => {
            console.log("[live] Server-side session timeout reached");
            sendToClient(ws, {
              type: "error",
              message: "Voice session time limit reached",
            });
            if (upstream) {
              upstream.close();
              upstream = null;
            }
            ws.close();
          }, VOICE_SESSION_MAX_MS);

        } catch (err) {
          console.error("[live] Failed to open upstream session:", err);
          sendToClient(ws, {
            type: "error",
            message: "Failed to start voice session",
          });
        }
        return;
      }

      // Reject audio/text/audioStreamEnd before config
      if (!configReceived || !upstream) {
        sendToClient(ws, {
          type: "error",
          message: "Send config message first",
        });
        return;
      }

      if (message.type === "audio") {
        upstream.sendRealtimeInput({
          audio: {
            data: message.data,
            mimeType: `audio/pcm;rate=${message.sampleRateHz}`,
          },
        });
        return;
      }

      // Text uses sendClientContent for ordered turn delivery
      // (matches chat.ts history pattern — guarantees ordering)
      if (message.type === "text") {
        upstream.sendClientContent({
          turns: [{ role: "user", parts: [{ text: message.content }] }],
          turnComplete: true,
        });
        return;
      }

      // audioStreamEnd signals mic-off without closing the session
      if (message.type === "audioStreamEnd") {
        upstream.sendRealtimeInput({ audioStreamEnd: true });
        return;
      }
    },

    onClose() {
      console.log("[live] Client disconnected");
      closed = true;
      cleanupTimer();
      if (upstream) {
        upstream.close();
        upstream = null;
      }
    },

    onError(evt) {
      console.error("[live] Client WS error:", evt);
      closed = true;
      cleanupTimer();
      if (upstream) {
        upstream.close();
        upstream = null;
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && npx vitest run packages/backend/src/ws/__tests__/live.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Run full typecheck**

Run: `pnpm build:shared && pnpm typecheck`
Expected: Clean (no errors). Key type contract: `callbacks.onmessage` receives `LiveServerMessage` (from `@google/genai`), not `MessageEvent`. If `Session` type isn't directly importable, use `Awaited<ReturnType<typeof ai.live.connect>>` to infer it.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/ws/live.ts packages/backend/src/ws/__tests__/live.test.ts
git commit -m "feat(backend): implement Gemini Live API WebSocket proxy

Replaces stub with full bidirectional proxy using @google/genai SDK.
Audio via sendRealtimeInput, text via sendClientContent (ordered turns).
Handles goAway, sessionResumptionUpdate, audioStreamEnd, transcripts,
barge-in interruption, session timeout, and lifecycle cleanup."
```

---

## Chunk 2: Extension Audio Capture + Playback + Voice Hook

### Task 5: Create AudioWorklet Processor

**Files:**
- Create: `packages/extension/src/sidepanel/audio-worklet-processor.js`

The AudioWorklet runs in a separate thread and converts Float32 mic samples to Int16 PCM, buffering to 640-sample chunks (40ms at 16kHz, per Google's 20-40ms recommendation) before posting to the main thread.

This file MUST be plain JavaScript (`.js`) because AudioWorklet modules are loaded via `addModule()` URL and cannot be TypeScript. In MV3 extensions, `audioWorklet.addModule()` requires a `chrome-extension://` URL — use `chrome.runtime.getURL()` to resolve it, and declare the file in `web_accessible_resources` in the manifest.

- [ ] **Step 1: Create the worklet processor**

Create `packages/extension/src/sidepanel/audio-worklet-processor.js`:

```javascript
// AudioWorklet processor for PCM capture.
// Buffers Float32 mic input into Int16 PCM chunks of BUFFER_SIZE samples,
// then posts them to the main thread for WebSocket transmission.
// 640 samples at 16kHz = 40ms chunks (Google recommends 20-40ms).

const BUFFER_SIZE = 640;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(BUFFER_SIZE);
    this.writeIndex = 0;
  }

  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      // Clamp and convert Float32 [-1, 1] to Int16 [-32768, 32767]
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.writeIndex++] = s * 32767;

      if (this.writeIndex >= BUFFER_SIZE) {
        // Use Transferable to avoid redundant structured clone of the copy
        const copy = this.buffer.buffer.slice(0);
        this.port.postMessage({ type: "pcm_chunk", buffer: copy }, [copy]);
        this.writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
```

- [ ] **Step 2: Add worklet to `web_accessible_resources` in manifest**

In `packages/extension/src/manifest.json`, add after `"action"`:

```json
"web_accessible_resources": [
  {
    "resources": ["src/sidepanel/audio-worklet-processor.js"],
    "matches": []
  }
]
```

This is **required** for `audioContext.audioWorklet.addModule()` to resolve a valid `chrome-extension://` URL in MV3 sidepanels.

- [ ] **Step 3: Verify the file exists**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && ls packages/extension/src/sidepanel/audio-worklet-processor.js`
Expected: File exists.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/sidepanel/audio-worklet-processor.js packages/extension/src/manifest.json
git commit -m "feat(extension): add AudioWorklet processor for PCM mic capture

Uses 640-sample buffer (40ms at 16kHz) per Google's recommended chunk size.
Declares worklet in web_accessible_resources for MV3 AudioWorklet loading."
```

---

### Task 6: Create Voice Hook

**Files:**
- Create: `packages/extension/src/sidepanel/hooks/useVoice.ts`

This hook encapsulates the entire voice lifecycle:
- WebSocket connection to backend `/live`
- Sending config with product context
- Mic capture via AudioWorklet → base64 → WS send
- Receiving and playing audio responses
- Transcript accumulation (input/output tracked independently — no ordered-delivery assumption)
- Barge-in handling (stop scheduled audio sources when interrupted)
- **Two-level mic control**: `pauseMic()` sends `audioStreamEnd` and stops capture but keeps the session alive; `endSession()` tears down everything
- `goAway` handling (warn user before connection expiry)
- Cleanup on unmount

- [ ] **Step 1: Write the test**

Create `packages/extension/src/sidepanel/__tests__/useVoice.test.ts` (follows existing test location convention — see `__tests__/chat.test.tsx` etc.):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVoice } from "../hooks/useVoice";

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((evt: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  constructor() {
    // Simulate async open
    setTimeout(() => this.onopen?.(), 0);
  }
}

// Mock getUserMedia
const mockMediaStream = {
  getTracks: () => [{ stop: vi.fn() }],
};

const mockGetUserMedia = vi.fn().mockResolvedValue(mockMediaStream);

// Mock AudioContext
const mockAudioWorkletNode = {
  port: { onmessage: null as ((evt: { data: unknown }) => void) | null },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const mockAudioContext = {
  audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
  createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() }),
  createBuffer: vi.fn().mockReturnValue({ copyToChannel: vi.fn(), duration: 0.1 }),
  createBufferSource: vi.fn().mockReturnValue({
    buffer: null,
    connect: vi.fn(),
    start: vi.fn(),
  }),
  currentTime: 0,
  destination: {},
  close: vi.fn(),
  state: "running",
  sampleRate: 24000,
};

vi.stubGlobal("WebSocket", MockWebSocket);
vi.stubGlobal("navigator", {
  mediaDevices: { getUserMedia: mockGetUserMedia },
});
vi.stubGlobal("AudioContext", vi.fn().mockImplementation(() => mockAudioContext));
vi.stubGlobal("AudioWorkletNode", vi.fn().mockImplementation(() => mockAudioWorkletNode));

describe("useVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts in idle state", () => {
    const { result } = renderHook(() =>
      useVoice({ backendUrl: "ws://localhost:8080", context: {} }),
    );
    expect(result.current.status).toBe("idle");
    expect(result.current.isRecording).toBe(false);
  });

  it("transitions to connecting then recording on start", async () => {
    const { result } = renderHook(() =>
      useVoice({ backendUrl: "ws://localhost:8080", context: {} }),
    );

    await act(async () => {
      await result.current.start();
    });

    // After start, should request mic and send config
    expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: { sampleRate: 16000 } });
  });

  it("pauseMic sends audioStreamEnd but keeps session alive", async () => {
    const { result } = renderHook(() =>
      useVoice({ backendUrl: "ws://localhost:8080", context: {} }),
    );

    await act(async () => {
      await result.current.start();
    });

    act(() => {
      result.current.pauseMic();
    });

    // Status should be paused, not idle (session still open)
    expect(result.current.status).toBe("paused");
  });

  it("endSession tears down everything", async () => {
    const { result } = renderHook(() =>
      useVoice({ backendUrl: "ws://localhost:8080", context: {} }),
    );

    await act(async () => {
      await result.current.start();
    });

    act(() => {
      result.current.endSession();
    });

    expect(result.current.status).toBe("idle");
  });

  it("cleans up on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useVoice({ backendUrl: "ws://localhost:8080", context: {} }),
    );

    await act(async () => {
      await result.current.start();
    });

    unmount();
    // Should not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && npx vitest run packages/extension/src/sidepanel/__tests__/useVoice.test.ts`
Expected: FAIL — `useVoice` module does not exist yet.

- [ ] **Step 3: Implement the voice hook**

Create `packages/extension/src/sidepanel/hooks/useVoice.ts`:

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";
import {
  VOICE_INPUT_SAMPLE_RATE,
  VOICE_OUTPUT_SAMPLE_RATE,
} from "@shopping-assistant/shared";

export type VoiceStatus = "idle" | "connecting" | "recording" | "paused" | "error";

export interface UseVoiceOptions {
  backendUrl: string;
  context: Record<string, unknown>;
}

export interface UseVoiceReturn {
  status: VoiceStatus;
  isRecording: boolean;
  inputTranscript: string;
  outputTranscript: string;
  error: string | null;
  start: () => Promise<void>;
  pauseMic: () => void;    // Sends audioStreamEnd, stops capture, keeps session alive
  endSession: () => void;  // Full teardown: closes WS, stops mic, releases resources
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Int16 PCM → Float32
  const sampleCount = bytes.length / 2;
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    let sample = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    if (sample >= 32768) sample -= 65536;
    float32[i] = sample / 32768;
  }
  return float32;
}

export function useVoice({ backendUrl, context }: UseVoiceOptions): UseVoiceReturn {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [inputTranscript, setInputTranscript] = useState("");
  const [outputTranscript, setOutputTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxCaptureRef = useRef<AudioContext | null>(null);
  const audioCtxPlaybackRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const cleaningUpRef = useRef(false);

  // Stop mic capture only (disconnect worklet + stop media tracks)
  const stopCapture = useCallback(() => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;

    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;

    if (audioCtxCaptureRef.current?.state !== "closed") {
      audioCtxCaptureRef.current?.close();
    }
    audioCtxCaptureRef.current = null;
  }, []);

  // Full teardown: mic + WS + playback
  const cleanup = useCallback(() => {
    if (cleaningUpRef.current) return;
    cleaningUpRef.current = true;

    stopCapture();

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close();
    }
    wsRef.current = null;

    // Stop all active playback sources
    for (const src of activeSourcesRef.current) {
      try { src.stop(0); src.disconnect(); } catch { /* already stopped */ }
    }
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;

    cleaningUpRef.current = false;
  }, [stopCapture]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
      if (audioCtxPlaybackRef.current?.state !== "closed") {
        audioCtxPlaybackRef.current?.close();
      }
    };
  }, [cleanup]);

  const playAudioChunk = useCallback((base64Data: string) => {
    if (!audioCtxPlaybackRef.current || audioCtxPlaybackRef.current.state === "closed") {
      audioCtxPlaybackRef.current = new AudioContext({ sampleRate: VOICE_OUTPUT_SAMPLE_RATE });
    }
    const ctx = audioCtxPlaybackRef.current;
    const float32 = base64ToFloat32(base64Data);

    const audioBuffer = ctx.createBuffer(1, float32.length, VOICE_OUTPUT_SAMPLE_RATE);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    // Track for barge-in cancellation
    activeSourcesRef.current.push(source);
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== source);
    };

    if (nextPlayTimeRef.current < ctx.currentTime) {
      nextPlayTimeRef.current = ctx.currentTime;
    }
    source.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += audioBuffer.duration;
  }, []);

  // Barge-in: stop all scheduled sources (lighter than destroying AudioContext)
  const clearPlaybackQueue = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try { src.stop(0); src.disconnect(); } catch { /* already stopped */ }
    }
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
  }, []);

  const sendWs = useCallback((msg: WsClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Use ref for context so start() doesn't recreate on context changes.
  // Context is only sent once on session init — changing it mid-session has no effect.
  const contextRef = useRef(context);
  contextRef.current = context;

  const start = useCallback(async () => {
    setError(null);
    setInputTranscript("");
    setOutputTranscript("");
    setStatus("connecting");

    try {
      // 1. Request mic
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: VOICE_INPUT_SAMPLE_RATE },
      });
      mediaStreamRef.current = stream;

      // 2. Open WebSocket
      const ws = new WebSocket(backendUrl + "/live");
      wsRef.current = ws;

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data) as WsServerMessage;

        switch (msg.type) {
          case "audio":
            playAudioChunk(msg.data);
            break;
          case "input_transcript":
            // Transcriptions arrive independently — no guaranteed ordering.
            // Accumulate each independently; do NOT reset one when the other arrives.
            setInputTranscript((prev) => prev + msg.content);
            break;
          case "output_transcript":
            setOutputTranscript((prev) => prev + msg.content);
            break;
          case "interrupted":
            clearPlaybackQueue();
            break;
          case "turn_complete":
            // Both transcripts may still have pending deliveries after turn_complete.
            // Reset only after a short delay to let final transcript chunks arrive.
            setTimeout(() => {
              setInputTranscript("");
              setOutputTranscript("");
            }, 200);
            break;
          case "go_away":
            setError(`Session expiring in ${Math.round(msg.timeLeftMs / 1000)}s`);
            break;
          case "session_resumption":
            // Store token for potential reconnection (future enhancement)
            console.log("[voice] Session resumption token received");
            break;
          case "error":
            setError(msg.message);
            setStatus("error");
            break;
        }
      };

      ws.onerror = () => {
        setError("Connection error");
        setStatus("error");
        cleanup();
      };

      ws.onclose = () => {
        if (status !== "error") setStatus("idle");
      };

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        const prevError = ws.onerror;
        ws.onerror = (e) => {
          prevError?.(e);
          reject(new Error("WebSocket connection failed"));
        };
      });

      // 3. Send config (read from ref to avoid stale closure)
      sendWs({ type: "config", context: contextRef.current });

      // 4. Set up AudioWorklet capture
      const audioCtx = new AudioContext({ sampleRate: VOICE_INPUT_SAMPLE_RATE });
      audioCtxCaptureRef.current = audioCtx;

      // MV3 requires chrome.runtime.getURL for AudioWorklet modules
      const workletUrl = chrome.runtime.getURL("src/sidepanel/audio-worklet-processor.js");
      await audioCtx.audioWorklet.addModule(workletUrl);

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      const workletNode = new AudioWorkletNode(audioCtx, "pcm-capture-processor");
      workletNodeRef.current = workletNode;

      workletNode.port.onmessage = (e: MessageEvent<{ type: string; buffer: ArrayBuffer }>) => {
        if (e.data.type === "pcm_chunk") {
          const base64 = arrayBufferToBase64(e.data.buffer);
          sendWs({
            type: "audio",
            encoding: "pcm_s16le",
            sampleRateHz: 16000,
            data: base64,
          });
        }
      };

      source.connect(workletNode);
      workletNode.connect(audioCtx.destination); // Required for worklet to process

      setStatus("recording");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start voice";
      setError(msg);
      setStatus("error");
      cleanup();
    }
  }, [backendUrl, cleanup, clearPlaybackQueue, playAudioChunk, sendWs, status]);

  // Pause mic: signal end-of-audio-stream, stop capture, keep session alive
  const pauseMic = useCallback(() => {
    sendWs({ type: "audioStreamEnd" });
    stopCapture();
    setStatus("paused");
  }, [sendWs, stopCapture]);

  // Full session teardown
  const endSession = useCallback(() => {
    cleanup();
    setStatus("idle");
    setInputTranscript("");
    setOutputTranscript("");
  }, [cleanup]);

  return {
    status,
    isRecording: status === "recording",
    inputTranscript,
    outputTranscript,
    error,
    start,
    pauseMic,
    endSession,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && npx vitest run packages/extension/src/sidepanel/__tests__/useVoice.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/hooks/useVoice.ts packages/extension/src/sidepanel/__tests__/useVoice.test.ts
git commit -m "feat(extension): add useVoice hook for Gemini Live voice conversation

Two-level mic control: pauseMic() sends audioStreamEnd and keeps session
alive; endSession() tears down everything. Barge-in stops scheduled
AudioBufferSourceNodes instead of destroying AudioContext."
```

---

### Task 7: Wire Voice into ChatThread + ChatRoute

**Files:**
- Modify: `packages/extension/src/sidepanel/components/ChatThread.tsx`
- Modify: `packages/extension/src/sidepanel/routes.tsx`
- Modify: `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`

This task connects the voice hook to the UI. The mic button in ChatThread toggles recording. Voice transcripts appear as chat messages. The ChatRoute and ChatInput pass voice state down.

- [ ] **Step 1: Add voice state to SidepanelStateContext**

In `packages/extension/src/sidepanel/state/SidepanelStateContext.tsx`:

Add to `SidepanelStateValue` interface (after `sendChatMessage`):

```typescript
  voiceStatus: import("../hooks/useVoice").VoiceStatus;
  isVoiceRecording: boolean;
  voiceInputTranscript: string;
  voiceOutputTranscript: string;
  voiceError: string | null;
  startVoice: () => Promise<void>;
  pauseVoice: () => void;     // Sends audioStreamEnd, keeps session alive
  endVoiceSession: () => void; // Full teardown
```

Add to `SidepanelInitialState` interface (for test hydration):

```typescript
  voiceStatus?: import("../hooks/useVoice").VoiceStatus;
```

In `SidepanelStateProvider`, import and use the voice hook:

```typescript
import { useVoice } from "../hooks/useVoice";
```

Inside the provider component, after existing state declarations, add:

```typescript
  // Derive WS URL from the same BACKEND_URL used by the service worker.
  // background/index.ts hardcodes "http://localhost:8080" — keep in sync.
  // In production, this should come from extension settings/storage (wss://).
  const BACKEND_URL = "http://localhost:8080";
  const backendWsUrl = BACKEND_URL.replace(/^http/, "ws");

  const voiceContext = useMemo(() => ({
    product: currentProduct,
    results: displayResults.slice(0, 5).map((r) => ({
      title: r.result.title,
      price: r.result.price,
      marketplace: r.result.marketplace,
    })),
  }), [currentProduct, displayResults]);

  const voice = useVoice({ backendUrl: backendWsUrl, context: voiceContext });
```

> **Note:** The service worker in `packages/extension/src/background/index.ts:12` already hardcodes `const BACKEND_URL = "http://localhost:8080"`. Both should be refactored to a shared config in a follow-up. For now, keep them in sync manually. The manifest's `host_permissions` (`http://localhost:8080/*`) covers HTTP but WebSocket connections from extension pages (sidepanel) don't require separate host permissions.

Add voice-related entries to the `value` memo:

```typescript
    voiceStatus: voice.status,
    isVoiceRecording: voice.isRecording,
    voiceInputTranscript: voice.inputTranscript,
    voiceOutputTranscript: voice.outputTranscript,
    voiceError: voice.error,
    startVoice: voice.start,
    pauseVoice: voice.pauseMic,
    endVoiceSession: voice.endSession,
```

Add the **individual** voice properties to the useMemo dependency array (do NOT add the `voice` object itself — it is recreated every render and would defeat memoization):

```typescript
  ]), [
    addSavedLink,
    chatLoading,
    chatMessages,
    currentProduct,
    currentResponse,
    displayResults,
    noPriceCount,
    priceBarCollapsed,
    removeSavedLink,
    resetToEmpty,
    savedLinks,
    selectDetectedProduct,
    selectedTheme,
    sendChatMessage,
    viewState,
    voice.status,
    voice.isRecording,
    voice.inputTranscript,
    voice.outputTranscript,
    voice.error,
    voice.start,
    voice.pauseMic,
    voice.endSession,
  ]);
```

Transcripts are ephemeral — they show in real-time while the voice turn is active, displayed as live text in the ChatThread UI, not stored as ChatMessage entries. This avoids state management complexity.

- [ ] **Step 2: Update ChatThread to accept voice props**

In `packages/extension/src/sidepanel/components/ChatThread.tsx`, update the Props interface:

```typescript
interface Props {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isLoading: boolean;
  showComposer?: boolean;
  // Voice
  isVoiceRecording?: boolean;
  voiceInputTranscript?: string;
  voiceOutputTranscript?: string;
  onMicToggle?: () => void;
}
```

Replace the `handleMicClick` placeholder with:

```typescript
  const handleMicClick = () => {
    onMicToggle?.();
  };
```

> **Note:** In the current UI, ChatThread's built-in composer (and its mic button) only renders when `showComposer={true}`. In the ChatRoute, `showComposer` is `false` and the separate `ChatInput` component handles mic toggling. If ChatThread is ever rendered with `showComposer={true}` elsewhere, the caller must pass `onMicToggle` for the button to function.

Add live transcript display above the loading indicator (inside the messages scroll area, before the `{isLoading && ...}` block):

```typescript
        {/* Live voice transcripts */}
        {isVoiceRecording && voiceInputTranscript && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/60 px-3.5 py-2.5 text-sm text-white/90 italic">
              {voiceInputTranscript}
            </div>
          </div>
        )}
        {isVoiceRecording && voiceOutputTranscript && (
          <div className="flex justify-start">
            <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white/80 border border-gray-100 px-3.5 py-2.5 text-sm text-text-main italic shadow-sm">
              {voiceOutputTranscript}
            </div>
          </div>
        )}
```

Update the mic button to show recording state (red when active):

```typescript
            ) : (
              <button
                onClick={handleMicClick}
                className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
                  isVoiceRecording
                    ? "bg-red-500 text-white animate-pulse"
                    : "bg-gray-100 text-text-muted hover:bg-gray-200"
                }`}
              >
                <span className="material-icons text-lg">
                  {isVoiceRecording ? "stop" : "mic"}
                </span>
              </button>
            )}
```

- [ ] **Step 3: Wire voice in ChatRoute and ChatInput**

In `packages/extension/src/sidepanel/routes.tsx`, update the `ChatRoute` function to destructure voice state:

```typescript
function ChatRoute() {
  const {
    currentProduct, displayResults, chatMessages, chatLoading, sendChatMessage,
    voiceStatus, isVoiceRecording, voiceInputTranscript, voiceOutputTranscript,
    startVoice, pauseVoice, endVoiceSession,
  } = useSidepanelState();
```

Pass voice props to `ChatThread` (note: `showComposer` is `false` in ChatRoute, so the mic button inside ChatThread's composer won't render here — the ChatInput component below handles mic toggling in this view; the voice transcript display in ChatThread still works regardless of `showComposer`):

```typescript
          <ChatThread
            messages={chatMessages}
            onSendMessage={sendChatMessage}
            isLoading={chatLoading}
            showComposer={false}
            isVoiceRecording={isVoiceRecording}
            voiceInputTranscript={voiceInputTranscript}
            voiceOutputTranscript={voiceOutputTranscript}
          />
```

Update `ChatInput` to include mic toggle with two-level control:

```typescript
function ChatInput() {
  const {
    sendChatMessage, chatLoading, voiceStatus,
    isVoiceRecording, startVoice, pauseVoice, endVoiceSession,
  } = useSidepanelState();
  const [input, setInput] = useState("");

  // Mic button: tap to start, tap again to pause (keeps session alive for response).
  // Long-press or second tap while paused ends session entirely.
  const handleMicToggle = () => {
    if (isVoiceRecording) {
      // Pause: sends audioStreamEnd, waits for model response, keeps session
      pauseVoice();
    } else if (voiceStatus === "paused") {
      // If already paused, end the session
      endVoiceSession();
    } else {
      void startVoice();
    }
  };
```

Add a mic button to the ChatInput JSX (after the send button):

```typescript
        <button
          type="button"
          onClick={handleMicToggle}
          className={`inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
            isVoiceRecording
              ? "bg-red-500 text-white animate-pulse"
              : voiceStatus === "paused"
                ? "bg-orange-400 text-white"
                : "bg-gray-100 text-text-muted hover:bg-gray-200"
          }`}
        >
          <span className="material-icons text-lg">
            {isVoiceRecording ? "pause" : voiceStatus === "paused" ? "stop" : "mic"}
          </span>
        </button>
```

- [ ] **Step 3b: Add Audio API mocks to extension test setup**

The `SidepanelStateProvider` now calls `useVoice` internally, which references `AudioContext`, `AudioWorkletNode`, `navigator.mediaDevices`, and `chrome.runtime.getURL` — none of which exist in jsdom. Without these mocks, **all existing extension tests** (`chat.test.tsx`, `shell.test.tsx`, etc.) will break.

Append to `packages/extension/src/test/setup.ts`:

```typescript
// Audio API mocks (required because SidepanelStateProvider calls useVoice)
Object.defineProperty(globalThis, "AudioContext", {
  value: vi.fn().mockImplementation(() => ({
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createMediaStreamSource: vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() }),
    createBuffer: vi.fn().mockReturnValue({ copyToChannel: vi.fn(), duration: 0.1 }),
    createBufferSource: vi.fn().mockReturnValue({
      buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(),
      onended: null,
    }),
    currentTime: 0,
    destination: {},
    close: vi.fn(),
    state: "running",
    sampleRate: 24000,
  })),
  writable: true,
});

Object.defineProperty(globalThis, "AudioWorkletNode", {
  value: vi.fn().mockImplementation(() => ({
    port: { onmessage: null },
    connect: vi.fn(),
    disconnect: vi.fn(),
  })),
  writable: true,
});

Object.defineProperty(globalThis, "navigator", {
  value: {
    ...globalThis.navigator,
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
  },
  writable: true,
});

// Add chrome.runtime.getURL stub (needed for AudioWorklet URL resolution)
if (globalThis.chrome) {
  (globalThis.chrome as any).runtime.getURL = (path: string) => `chrome-extension://test-id/${path}`;
}
```

Also add `import { vi } from "vitest";` at the top of setup.ts if not already imported.

- [ ] **Step 4: Run typecheck**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm typecheck`
Expected: Clean. If there are type errors in the voice hook imports (e.g., constants path), fix the import to match the shared package's export structure.

- [ ] **Step 5: Run all extension tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && npx vitest run packages/extension/`
Expected: All existing tests pass (with new Audio API mocks). New voice tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/sidepanel/components/ChatThread.tsx \
       packages/extension/src/sidepanel/routes.tsx \
       packages/extension/src/sidepanel/state/SidepanelStateContext.tsx \
       packages/extension/src/test/setup.ts
git commit -m "feat(extension): wire voice hook into ChatThread and ChatRoute UI

Mic button: tap to start recording, tap to pause (sends audioStreamEnd,
keeps session alive for response), tap again to end session.
Live transcripts shown inline during voice turns.
Adds Audio API mocks to test setup for existing test compatibility."
```

---

## Chunk 3: Build Verification + Integration Notes

### Task 8: Full Build + Typecheck

**Files:** None (verification only)

- [ ] **Step 1: Build all packages**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build`
Expected: All three packages build successfully. Watch for:
- Shared types compile first
- Extension Vite build includes `audio-worklet-processor.js` as an asset
- Backend compiles with the new `live.ts`

- [ ] **Step 2: Run full typecheck**

Run: `pnpm typecheck`
Expected: Zero errors across all packages.

- [ ] **Step 3: Run all tests**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && npx vitest run`
Expected: All tests pass (existing + new voice tests).

- [ ] **Step 4: Commit any fixes if needed**

If build/typecheck revealed issues, fix and commit:
```bash
git add -u
git commit -m "fix: resolve build/typecheck issues in voice integration"
```

---

### Task 9: Verify AudioWorklet Loading in MV3 Build

**Files:**
- Possibly modify: `packages/extension/vite.config.ts`

The `web_accessible_resources` and `chrome.runtime.getURL()` approach was already set up in Tasks 5 and 6. This task verifies the worklet file appears in the build output.

> **Important:** Do NOT attempt to relax MV3 CSP (e.g., adding `'wasm-unsafe-eval'` to `extension_pages`). Chrome's MV3 documentation states that `extension_pages` CSP **cannot be relaxed** beyond the minimum policy. The default `script-src 'self'` already permits loading scripts from the extension's own origin, which is sufficient for AudioWorklet modules loaded via `chrome-extension://` URLs.

- [ ] **Step 1: Verify worklet is included in build output**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build && find packages/extension/dist/ -name "*worklet*" -o -name "*audio*processor*"`

If the file is NOT in dist, CRXJS may need explicit asset configuration. Add to `vite.config.ts`:

```typescript
build: {
  rollupOptions: {
    input: {
      "audio-worklet-processor": "src/sidepanel/audio-worklet-processor.js",
    },
  },
},
```

- [ ] **Step 2: Verify the worklet loads at runtime**

Load the extension in Chrome, open a sidepanel, check the console for errors related to `addModule`. If `chrome.runtime.getURL()` returns a valid URL and the file is in dist, this should work under the default `script-src 'self'` CSP.

- [ ] **Step 3: Commit if Vite config changes were needed**

```bash
git add packages/extension/vite.config.ts
git commit -m "fix(extension): ensure AudioWorklet is included in CRXJS build output"
```

---

## Implementation Notes

### Backend URL Configuration

The `SidepanelStateProvider` derives the WS URL from a hardcoded `BACKEND_URL` matching the service worker's `http://localhost:8080`. Both locations must stay in sync. For production:

- Refactor `BACKEND_URL` into a shared config (e.g., `chrome.storage.local` settings page)
- The `http→ws` / `https→wss` replacement in the provider handles scheme conversion automatically
- Cloud Run supports WebSocket connections up to 60 minutes
- The manifest's `host_permissions` (`http://localhost:8080/*`) covers HTTP; WebSocket connections from extension pages (sidepanel) do not require separate host permissions

### Backend Origin Validation

The backend CORS middleware (`index.ts:30-38`) excludes the `/live` WebSocket endpoint by design. However, the WS upgrade handler currently accepts connections from **any origin**. Before production deployment:

- Add `Origin` header validation in the WS upgrade middleware
- Development: allow `chrome-extension://*` and `http://localhost:*`
- Production: restrict to the specific extension ID (`chrome-extension://<your-extension-id>`)
- Without this, any webpage can open a WS to the backend and trigger Gemini API calls using the server's credentials (Cross-Site WebSocket Hijacking / CWE-1385)

### Gemini Live API Session Limits

- Audio-only sessions: 15-minute max
- Sessions with video: 2-minute max
- WebSocket connections may be limited to ~10 minutes even if sessions can be resumed
- The backend enforces a server-side timeout via `setTimeout` and relays `goAway` warnings from upstream
- The client should show a user-friendly message and allow reconnecting

### GoAway and Session Resumption

- Upstream sends `goAway` before closing the connection, with a `timeLeft` field
- Backend relays this as `{ type: "go_away", timeLeftMs }` to the client
- Upstream may also send `sessionResumptionUpdate` with a `newHandle` token
- The client receives `{ type: "session_resumption", token }` and should store it
- **Session resumption is not implemented in MVP** but the plumbing is in place: a future `start()` could accept a resumption token and pass it in the `ai.live.connect()` config

### Mic Toggle Behavior

The mic button has three states:
1. **Idle** → tap to start (opens WS, starts mic capture, sends config)
2. **Recording** → tap to pause (sends `audioStreamEnd` to upstream via backend, stops mic capture, keeps WS open so the model can finish responding)
3. **Paused** → tap to end session (full teardown: closes WS, releases resources)

This is critical: **closing the WebSocket while the model is still generating a response will drop that response**. The `audioStreamEnd` signal tells the Live API "user stopped talking" which triggers the model to begin/complete its response — the session must stay alive to receive it.

### Barge-in Behavior

When the user speaks while the model is responding:
1. Gemini detects voice activity (automatic VAD)
2. Sends `interrupted: true` in `serverContent`
3. Backend relays `{ type: "interrupted" }` to client
4. Client calls `clearPlaybackQueue()` — stops all active `AudioBufferSourceNode`s via `.stop(0)` and `.disconnect()` (lighter than destroying the AudioContext; avoids platform AudioContext limits)
5. New model response begins

### Transcript Ordering

Input and output transcriptions are delivered **independently with no guaranteed ordering** from the Gemini Live API. The plan handles this by:
- Accumulating input and output transcripts independently (never resetting one when the other arrives)
- On `turn_complete`, waiting 200ms before clearing both transcripts, to allow final transcript chunks to arrive
- Never assuming that `input_transcript` will finish before `output_transcript` starts

### Audio Format Reference

| Direction | Format | Sample Rate | Chunk Size | Encoding |
|-----------|--------|-------------|------------|----------|
| Client → Server | PCM Int16 LE | 16 kHz | 640 samples (40ms) | base64 in JSON |
| Server → Client | PCM Int16 LE | 24 kHz | varies | base64 in JSON |

### What's NOT in Scope

- Session resumption / reconnection logic (plumbing is in place via `session_resumption` messages; full implementation is a future enhancement)
- Voice activity indicator UI animation (can be added later)
- Saving voice conversation transcripts to chat history (ephemeral for now)
- Video input support (Gemini Live supports it but not needed for MVP)
- Voice selection / personalization settings
- WebSocket backpressure monitoring (`bufferedAmount` checks — add if bandwidth issues arise)
- WS origin validation middleware (required before production deployment, see "Backend Origin Validation" above)
