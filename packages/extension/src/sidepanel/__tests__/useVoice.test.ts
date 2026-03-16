import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { applyPlaybackEnvelope, useVoice } from "../hooks/useVoice";
import { MockWebSocket } from "./MockWebSocket";

vi.stubGlobal("WebSocket", MockWebSocket);

// AudioContext, AudioWorkletNode, and navigator.mediaDevices are provided by test/setup.ts

describe("useVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    Object.defineProperty(navigator, "permissions", {
      value: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
      configurable: true,
    });
    Object.assign(chrome, {
      tabs: {
        create: vi.fn(),
      },
    });
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

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { sampleRate: 16000 } });
    expect(result.current.status).toBe("recording");
  });

  it("pauseMic sends audioStreamEnd but keeps session alive", async () => {
    const { result } = renderHook(() =>
      useVoice({ backendUrl: "ws://localhost:8080", context: {} }),
    );

    await act(async () => {
      await result.current.start();
    });

    const ws = MockWebSocket.instances[0];

    await act(async () => {
      result.current.pauseMic();
      // Wait for flush acknowledgement (setTimeout(0) in AudioWorkletNode mock)
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.status).toBe("paused");
    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"audioStreamEnd"'),
    );
  });

  it("endSession tears down everything", async () => {
    const { result } = renderHook(() =>
      useVoice({ backendUrl: "ws://localhost:8080", context: {} }),
    );

    await act(async () => {
      await result.current.start();
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      result.current.endSession();
    });

    expect(result.current.status).toBe("idle");
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("commits completed transcripts before clearing them on turn completion", async () => {
    const onConversationCommit = vi.fn();
    const { result } = renderHook(() =>
      useVoice({
        backendUrl: "ws://localhost:8080",
        context: {},
        onConversationCommit,
      }),
    );

    await act(async () => {
      await result.current.start();
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: "input_transcript", content: "Is this the best price?" }) });
      ws.onmessage?.({ data: JSON.stringify({ type: "output_transcript", content: "This is currently the cheapest match." }) });
      ws.onmessage?.({ data: JSON.stringify({ type: "turn_complete" }) });
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    expect(onConversationCommit).toHaveBeenCalledWith({
      inputTranscript: "Is this the best price?",
      outputTranscript: "This is currently the cheapest match.",
    });
    expect(result.current.inputTranscript).toBe("");
    expect(result.current.outputTranscript).toBe("");
  });

  it("commits pending transcripts when the session ends before turn completion arrives", async () => {
    const onConversationCommit = vi.fn();
    const { result } = renderHook(() =>
      useVoice({
        backendUrl: "ws://localhost:8080",
        context: {},
        onConversationCommit,
      }),
    );

    await act(async () => {
      await result.current.start();
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: "input_transcript", content: "Compare this against Home Depot." }) });
      ws.onmessage?.({ data: JSON.stringify({ type: "output_transcript", content: "Home Depot is slightly higher for this item." }) });
      result.current.endSession();
    });

    expect(onConversationCommit).toHaveBeenCalledWith({
      inputTranscript: "Compare this against Home Depot.",
      outputTranscript: "Home Depot is slightly higher for this item.",
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

    const ws = MockWebSocket.instances[0];

    unmount();

    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("softens playback chunk edges without adding buffering", () => {
    const input = new Float32Array(16).fill(1);
    const output = applyPlaybackEnvelope(input, 4);

    expect(output[0]).toBeLessThan(1);
    expect(output[1]).toBeLessThan(1);
    expect(output[7]).toBeGreaterThan(0.8);
    expect(output[7]).toBeLessThan(0.93);
    expect(output[14]).toBeLessThan(1);
    expect(output[15]).toBeLessThan(1);
  });
});
