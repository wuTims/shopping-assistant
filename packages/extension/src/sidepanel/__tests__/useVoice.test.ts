import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useVoice } from "../hooks/useVoice";

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

const mockMediaStream = {
  getTracks: () => [{ stop: vi.fn() }],
};

const mockGetUserMedia = vi.fn().mockResolvedValue(mockMediaStream);

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
    buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(),
    onended: null,
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
