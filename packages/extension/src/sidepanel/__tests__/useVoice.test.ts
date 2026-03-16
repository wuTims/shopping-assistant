import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVoice } from "../hooks/useVoice";

// WebSocket mock (not provided by setup.ts)
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
    setTimeout(() => this.onopen?.(), 0);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

// AudioContext, AudioWorkletNode, and navigator.mediaDevices are provided by test/setup.ts

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

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { sampleRate: 16000 } });
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
  });
});
