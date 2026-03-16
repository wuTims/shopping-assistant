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
  getURL: (path: string) => `chrome-extension://test-id/${path}`,
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
  value: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    this.createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() });
    this.createBuffer = vi.fn().mockReturnValue({ copyToChannel: vi.fn(), duration: 0.1 });
    this.createBufferSource = vi.fn().mockReturnValue({
      buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(),
      onended: null,
    });
    this.currentTime = 0;
    this.destination = {};
    this.close = vi.fn().mockResolvedValue(undefined);
    this.state = "running";
    this.sampleRate = 24000;
  }),
  writable: true,
});

Object.defineProperty(globalThis, "AudioWorkletNode", {
  value: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    const listeners = new Map<string, Set<Function>>();
    this.port = {
      onmessage: null,
      postMessage: vi.fn((data: unknown) => {
        // Simulate worklet responding to flush
        if (data && typeof data === "object" && (data as Record<string, unknown>).type === "flush") {
          setTimeout(() => {
            const flushedListeners = listeners.get("message");
            if (flushedListeners) {
              for (const listener of flushedListeners) {
                listener({ data: { type: "flushed" } });
              }
            }
          }, 0);
        }
      }),
      addEventListener: vi.fn((type: string, fn: Function) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      }),
      removeEventListener: vi.fn((type: string, fn: Function) => {
        listeners.get(type)?.delete(fn);
      }),
    };
    this.connect = vi.fn();
    this.disconnect = vi.fn();
  }),
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
