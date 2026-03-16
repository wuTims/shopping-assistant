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
