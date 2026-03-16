import { beforeEach, describe, expect, it, vi } from "vitest";

const initOverlays = vi.fn();

vi.mock("../overlay", () => ({
  initOverlays,
}));

describe("content entry", () => {
  beforeEach(() => {
    initOverlays.mockClear();
    vi.resetModules();
  });

  it("exports onExecute for the CRX loader and initializes overlays through it", async () => {
    const mod = await import("../index");

    expect(typeof mod.onExecute).toBe("function");

    mod.onExecute?.({ perf: { injectTime: 0, loadTime: 0 } });

    expect(initOverlays).toHaveBeenCalledTimes(1);
  });
});
