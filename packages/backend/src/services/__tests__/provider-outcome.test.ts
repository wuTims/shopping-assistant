import { describe, it, expect } from "vitest";
import { resolveProviderStatus } from "../provider-outcome.js";

describe("resolveProviderStatus", () => {
  it("returns ok when no failures", () => {
    expect(resolveProviderStatus(3, 0, 0)).toBe("ok");
  });

  it("returns timeout when all failures are timeouts and no successes", () => {
    expect(resolveProviderStatus(0, 2, 2)).toBe("timeout");
  });

  it("returns error when some failures are not timeouts", () => {
    expect(resolveProviderStatus(0, 3, 1)).toBe("error");
  });

  it("returns error when there are failures but also successes", () => {
    expect(resolveProviderStatus(1, 2, 2)).toBe("error");
  });

  it("returns error when all fail but none are timeouts", () => {
    expect(resolveProviderStatus(0, 2, 0)).toBe("error");
  });
});
