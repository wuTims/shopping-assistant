import { beforeEach, describe, expect, it, vi } from "vitest";

type ActionListener = (tab: { id?: number; windowId?: number; url?: string }) => Promise<void> | void;

let actionClickListener: ActionListener | null = null;

function createChromeStub() {
  return {
    action: {
      onClicked: {
        addListener: vi.fn((listener: ActionListener) => {
          actionClickListener = listener;
        }),
      },
    },
    sidePanel: {
      open: vi.fn(async () => undefined),
    },
    runtime: {
      getManifest: vi.fn(() => ({
        content_scripts: [
          { js: ["assets/index.ts-loader-test.js"] },
        ],
      })),
      onMessage: {
        addListener: vi.fn(),
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

describe("action click flow", () => {
  beforeEach(() => {
    actionClickListener = null;
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
    Object.assign(chrome, createChromeStub());
  });

  it("injects the content script and opens the sidepanel without auto-searching", async () => {
    await import("../index");

    expect(actionClickListener).not.toBeNull();

    await actionClickListener?.({ id: 42, windowId: 3, url: "https://www.walmart.com/ip/example" });

    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ["assets/index.ts-loader-test.js"],
    });
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: "sidepanel",
      tabId: 42,
      type: "empty",
    });
  });
});
