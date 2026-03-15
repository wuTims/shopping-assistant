import { describe, it, expect } from "vitest";
import { cosineSimilarity, blendScores } from "../embedding.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it("handles real-world similarity range", () => {
    const a = [0.1, 0.3, 0.5, 0.7, 0.9];
    const b = [0.2, 0.4, 0.5, 0.6, 0.8];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.95);
    expect(sim).toBeLessThanOrEqual(1.0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("blendScores", () => {
  it("blends text and visual scores with default weights", () => {
    const textScores = { a: 0.8, b: 0.5, c: 0.3 };
    const visualScores = { a: 0.9, b: 0.2 }; // c has no visual score

    const blended = blendScores(textScores, visualScores);

    // a: 0.6 * 0.8 + 0.4 * 0.9 = 0.48 + 0.36 = 0.84
    expect(blended.a).toBeCloseTo(0.84, 2);
    // b: 0.6 * 0.5 + 0.4 * 0.2 = 0.30 + 0.08 = 0.38
    expect(blended.b).toBeCloseTo(0.38, 2);
    // c: no visual score → text score only
    expect(blended.c).toBe(0.3);
  });

  it("returns text scores unchanged when no visual scores", () => {
    const textScores = { a: 0.8, b: 0.5 };
    const blended = blendScores(textScores, {});
    expect(blended).toEqual(textScores);
  });

  it("clamps blended scores to [0, 0.95]", () => {
    const textScores = { a: 0.95 };
    const visualScores = { a: 1.0 };
    const blended = blendScores(textScores, visualScores);
    expect(blended.a).toBeLessThanOrEqual(0.95);
  });
});
