import { vi } from "vitest";
import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "scrollTo", {
  value: () => {},
  writable: true,
});

Object.defineProperty(window, "open", {
  value: () => null,
  writable: true,
});

Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  value: () => {},
  writable: true,
});

const runtimeStub = {
  sendMessage: (_message: unknown, callback?: (response: null) => void) => {
    callback?.(null);
  },
  onMessage: {
    addListener: () => {},
    removeListener: () => {},
  },
  lastError: undefined,
};

Object.defineProperty(globalThis, "chrome", {
  value: {
    runtime: runtimeStub,
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
  },
  writable: true,
});

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

// Add mediaDevices to existing navigator (don't replace navigator — React DOM needs userAgent)
if (!globalThis.navigator.mediaDevices) {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
    writable: true,
    configurable: true,
  });
}

// Add chrome.runtime.getURL stub (needed for AudioWorklet URL resolution)
if (globalThis.chrome) {
  (globalThis.chrome as any).runtime.getURL = (path: string) => `chrome-extension://test-id/${path}`;
}
