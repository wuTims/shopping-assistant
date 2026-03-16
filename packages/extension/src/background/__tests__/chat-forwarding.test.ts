import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageListener = (
  message: Record<string, unknown>,
  sender: { tab?: { id?: number } },
  sendResponse: (response: unknown) => void,
) => boolean | void;

let runtimeMessageListener: MessageListener | null = null;

function createChromeStub() {
  return {
    action: {
      onClicked: {
        addListener: vi.fn(),
      },
    },
    sidePanel: {
      open: vi.fn(async () => undefined),
    },
    runtime: {
      getManifest: vi.fn(() => ({
        content_scripts: [{ js: ["assets/index.ts-loader-test.js"] }],
      })),
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => {
          runtimeMessageListener = listener;
        }),
      },
      sendMessage: vi.fn(() => Promise.resolve()),
    },
    scripting: {
      executeScript: vi.fn(async () => undefined),
    },
    tabs: {
      captureVisibleTab: vi.fn(async () => "data:image/png;base64,test"),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    },
  };
}

describe("chat forwarding", () => {
  beforeEach(() => {
    runtimeMessageListener = null;
    vi.resetModules();
    Object.assign(chrome, createChromeStub());
  });

  it("forwards backend fallback replies for non-200 chat responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({
        reply: "Chat quota reached. Please wait about a minute and try again.",
      }),
    })));

    await import("../index");

    const sendResponse = vi.fn();
    const handled = runtimeMessageListener?.(
      {
        type: "CHAT_REQUEST",
        tabId: 17,
        request: {
          message: "what",
          context: { product: null, results: [] },
          history: [],
        },
      },
      {},
      sendResponse,
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        target: "sidepanel",
        tabId: 17,
        type: "chat_response",
        reply: "Chat quota reached. Please wait about a minute and try again.",
      });
    });
  });
});
