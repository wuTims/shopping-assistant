# Phase 3: Voice Implementation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add real-time voice conversation via Gemini Live API — backend WebSocket proxy and extension audio capture/playback.

**Architecture:** Side panel connects to backend via WSS → backend proxies bidirectional audio to Gemini Live API. Browser captures mic at 16kHz PCM via ScriptProcessor, backend forwards to Gemini, Gemini responds with 24kHz audio that plays in the browser.

**Tech Stack:** `@google/genai` Live API, Hono WebSocket, Web Audio API, ScriptProcessor

**Prerequisites:** Phase 1 + Phase 2 complete — backend running, extension loaded in Chrome with working search + text chat.

**Validation gate:** Phase is complete when you can click the mic button in the chat view, speak a question, and hear Gemini's audio response.

---

### Task 1: Implement Gemini Live API WebSocket Proxy

**Files:**
- Rewrite: `packages/backend/src/ws/live.ts`

**Step 1: Implement the bidirectional audio proxy**

Replace the entire contents of `packages/backend/src/ws/live.ts` with:

```typescript
import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";
import type { WSContext } from "hono/ws";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

type GeminiSession = Awaited<ReturnType<typeof ai.live.connect>>;

export function liveWebSocket(_c: unknown) {
  let geminiSession: GeminiSession | null = null;

  return {
    async onOpen(_evt: Event, ws: WSContext) {
      console.log("[ws] Client connected, opening Gemini Live session");

      try {
        geminiSession = await ai.live.connect({
          model: "gemini-live-2.5-flash-preview",
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction:
              "You are a helpful shopping assistant. Help users compare products, find deals, and make purchasing decisions. Be concise, friendly, and specific when referencing products and prices.",
          },
          callbacks: {
            onopen: () => {
              console.log("[gemini] Live session opened");
            },

            onmessage: (message: LiveServerMessage) => {
              // Audio output from Gemini
              const parts = message.serverContent?.modelTurn?.parts;
              if (parts) {
                for (const part of parts) {
                  if (part.inlineData?.data) {
                    const audioMsg: WsServerMessage = {
                      type: "audio",
                      encoding: "pcm_s16le",
                      sampleRateHz: 24000,
                      data: part.inlineData.data,
                    };
                    ws.send(JSON.stringify(audioMsg));
                  }
                  if (part.text) {
                    const textMsg: WsServerMessage = {
                      type: "transcript",
                      content: part.text,
                    };
                    ws.send(JSON.stringify(textMsg));
                  }
                }
              }

              // Output transcription
              if (message.serverContent?.outputTranscription?.text) {
                const transcriptMsg: WsServerMessage = {
                  type: "transcript",
                  content: message.serverContent.outputTranscription.text,
                };
                ws.send(JSON.stringify(transcriptMsg));
              }

              // Turn complete
              if (message.serverContent?.turnComplete) {
                const completeMsg: WsServerMessage = { type: "turn_complete" };
                ws.send(JSON.stringify(completeMsg));
              }
            },

            onerror: (e: ErrorEvent) => {
              console.error("[gemini] Live session error:", e.message);
            },

            onclose: (_e: CloseEvent) => {
              console.log("[gemini] Live session closed");
              geminiSession = null;
            },
          },
        });
      } catch (err) {
        console.error("[gemini] Failed to connect Live API:", err);
        ws.close(1011, "Failed to connect to Gemini Live API");
      }
    },

    onMessage(evt: MessageEvent, _ws: WSContext) {
      if (!geminiSession) {
        console.warn("[ws] No active Gemini session, dropping message");
        return;
      }

      const message = JSON.parse(String(evt.data)) as WsClientMessage;

      switch (message.type) {
        case "audio":
          // Forward audio: browser → Gemini (16kHz PCM)
          geminiSession.sendRealtimeInput({
            audio: {
              data: message.data,
              mimeType: "audio/pcm;rate=16000",
            },
          });
          break;

        case "text":
          geminiSession.sendClientContent({
            turns: message.content,
            turnComplete: true,
          });
          break;

        case "config":
          console.log("[ws] Config update received");
          geminiSession.sendClientContent({
            turns: `Product context update: ${JSON.stringify(message.context)}`,
            turnComplete: true,
          });
          break;
      }
    },

    onClose() {
      console.log("[ws] Client disconnected");
      if (geminiSession) {
        geminiSession.close();
        geminiSession = null;
      }
    },
  };
}
```

**Step 2: Verify backend typecheck**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build:shared && pnpm --filter @shopping-assistant/backend typecheck`
Expected: No type errors.

**Step 3: Commit**

```bash
git add packages/backend/src/ws/live.ts
git commit -m "feat: implement Gemini Live API WebSocket proxy for voice"
```

---

### Task 2: Add Voice UI to Side Panel

**Files:**
- Modify: `packages/extension/src/sidepanel/App.tsx`
- Modify: `packages/extension/src/sidepanel/App.css`

**Step 1: Add the useVoice hook**

In `packages/extension/src/sidepanel/App.tsx`, add the `WsServerMessage` and `WsClientMessage` imports at the top:

```typescript
import type {
  DetectedProduct,
  SearchResponse,
  RankedResult,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  WsServerMessage,
  WsClientMessage,
} from "@shopping-assistant/shared";
```

Add the `useVoice` hook function before the `export default function App()`:

```typescript
function useVoice(onTranscript: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const playbackQueue = useRef<Float32Array[]>([]);
  const isPlaying = useRef(false);

  const startRecording = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_BACKEND_URL" });
      const wsUrl = (response as { url: string }).url.replace("http", "ws") + "/live";

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data) as WsServerMessage;
        if (msg.type === "audio") {
          playAudioChunk(msg.data);
        } else if (msg.type === "transcript") {
          onTranscript(msg.content);
        }
      };

      ws.onopen = () => console.log("[voice] WebSocket connected");
      ws.onerror = () => stopRecording();
      ws.onclose = () => console.log("[voice] WebSocket closed");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(inputData[i] * 32767)));
        }
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }

        const audioMsg: WsClientMessage = {
          type: "audio",
          encoding: "pcm_s16le",
          sampleRateHz: 16000,
          data: btoa(binary),
        };
        wsRef.current.send(JSON.stringify(audioMsg));
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      setRecording(true);
    } catch (err) {
      console.error("[voice] Failed to start recording:", err);
    }
  };

  const stopRecording = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    wsRef.current?.close();
    wsRef.current = null;
    audioContextRef.current = null;
    streamRef.current = null;
    setRecording(false);
  };

  const playAudioChunk = (base64Data: string) => {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }

    playbackQueue.current.push(float32);
    if (!isPlaying.current) drainPlaybackQueue();
  };

  const drainPlaybackQueue = async () => {
    if (!playbackCtxRef.current) {
      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
    }
    isPlaying.current = true;
    const ctx = playbackCtxRef.current;

    while (playbackQueue.current.length > 0) {
      const chunk = playbackQueue.current.shift()!;
      const buffer = ctx.createBuffer(1, chunk.length, 24000);
      buffer.getChannelData(0).set(chunk);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
      await new Promise((resolve) => { source.onended = resolve; });
    }

    isPlaying.current = false;
  };

  const toggle = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  return { recording, toggle };
}
```

**Step 2: Update ChatView to include mic button**

Replace the `ChatView` component with:

```tsx
function ChatView({
  messages,
  input,
  loading,
  onInputChange,
  onSend,
  onVoiceMessage,
  chatEndRef,
}: {
  messages: ChatMessage[];
  input: string;
  loading: boolean;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onVoiceMessage: (content: string) => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  const voice = useVoice((transcript) => {
    onVoiceMessage(transcript);
  });

  return (
    <div className="chat-view">
      <div className="chat-thread">
        {messages.length === 0 && (
          <div className="chat-greeting">
            <p>Hi! Ask me anything about these products.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`chat-bubble chat-${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {loading && (
          <div className="chat-bubble chat-assistant">
            <span className="typing-indicator">...</span>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      <div className="chat-input-area">
        <button
          className={`mic-btn ${voice.recording ? "mic-recording" : ""}`}
          onClick={voice.toggle}
          title={voice.recording ? "Stop recording" : "Start voice"}
        >
          🎤
        </button>
        {voice.recording ? (
          <div className="listening-text">Listening...</div>
        ) : (
          <>
            <input
              type="text"
              className="chat-input"
              placeholder="Ask about these products..."
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSend()}
              disabled={loading}
            />
            <button
              className="send-btn"
              onClick={onSend}
              disabled={loading || !input.trim()}
            >
              Send
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

**Step 3: Update ChatView usage in App**

Where `ChatView` is rendered in the `App` component, pass the new `onVoiceMessage` prop:

```tsx
<ChatView
  messages={state.chatMessages}
  input={state.chatInput}
  loading={state.chatLoading}
  onInputChange={(v) => setState((prev) => ({ ...prev, chatInput: v }))}
  onSend={handleSendChat}
  onVoiceMessage={(content) => {
    const msg: ChatMessage = {
      id: `msg-voice-${Date.now()}`,
      role: "assistant",
      content,
      inputMode: "voice",
      timestamp: Date.now(),
      context: null,
    };
    setState((prev) => ({
      ...prev,
      chatMessages: [...prev.chatMessages, msg],
    }));
  }}
  chatEndRef={chatEndRef}
/>
```

**Step 4: Add mic button CSS**

Append to `packages/extension/src/sidepanel/App.css`:

```css
/* Mic Button */
.mic-btn {
  width: 40px;
  height: 40px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: white;
  cursor: pointer;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.mic-btn:hover {
  background: #f3f4f6;
}

.mic-recording {
  background: #fef2f2;
  border-color: #ef4444;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.listening-text {
  flex: 1;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 14px;
  color: #ef4444;
  font-style: italic;
}
```

**Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/App.tsx packages/extension/src/sidepanel/App.css
git commit -m "feat: add voice recording and playback to chat view"
```

---

### Task 3: Full Build and Verification

**Step 1: Build everything**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm build`
Expected: All three packages build cleanly.

**Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: No type errors. Fix any that arise.

**Step 3: Fix issues and commit**

```bash
git add -A
git commit -m "chore: fix build and typecheck issues from voice implementation"
```

---

### Task 4: Manual Integration Test — Full MVP

**Step 1: Start backend**

Run: `cd /workspaces/web-dev-playground/shopping-assistant && pnpm dev:backend`

**Step 2: Reload extension in Chrome**

1. Go to `chrome://extensions`
2. Click reload on "Shopping Source Discovery"

**Step 3: Test search flow**

1. Navigate to an Amazon product page
2. Click overlay icon → side panel opens → loading phases → results appear

**Step 4: Test text chat**

1. Click "Chat Now" → ask a question → get response

**Step 5: Test voice**

1. Click mic button in chat view
2. Speak a question about the products
3. Hear Gemini's audio response
4. See transcript appear in chat thread
5. Click mic again to stop

**Step 6: Report issues**

Note any issues for follow-up. The MVP is complete when all five user flows from the frontend-ux-spec work:
- Browse → Detect → Search → Compare
- Compare → Ask questions (text)
- Compare → Voice conversation
- Cached result (instant)
