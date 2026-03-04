import { describe, it, expect } from "vitest";
import { isLikelyTimeoutError } from "../errors.js";

describe("isLikelyTimeoutError", () => {
  it("returns false for non-Error values", () => {
    expect(isLikelyTimeoutError("timeout")).toBe(false);
    expect(isLikelyTimeoutError(null)).toBe(false);
    expect(isLikelyTimeoutError(undefined)).toBe(false);
  });

  it("detects timeout by error name", () => {
    const err = new Error("request failed");
    err.name = "TimeoutError";
    expect(isLikelyTimeoutError(err)).toBe(true);
  });

  it("detects AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isLikelyTimeoutError(err)).toBe(true);
  });

  it("detects timeout in message", () => {
    expect(isLikelyTimeoutError(new Error("Request timed out after 5000ms"))).toBe(true);
    expect(isLikelyTimeoutError(new Error("Connection timeout"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isLikelyTimeoutError(new Error("Network error"))).toBe(false);
    expect(isLikelyTimeoutError(new Error("404 Not Found"))).toBe(false);
  });
});
