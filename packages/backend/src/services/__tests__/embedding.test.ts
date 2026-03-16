import { describe, it, expect, vi, afterEach } from "vitest";

// Mock ai-client to avoid requiring GEMINI_API_KEY
vi.mock("../ai-client.js", () => ({
  ai: {
    models: {
      embedContent: vi.fn(),
    },
  },
  geminiModel: "gemini-2.5-flash",
  embeddingModel: "gemini-embedding-2-preview",
}));

import { cosineSimilarity, blendScores, embedImage } from "../embedding.js";
import { ai } from "../ai-client.js";

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

  it("returns 0 for dimension mismatch", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
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

describe("embedImage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns embedding vector for an image", async () => {
    const mockVector = [0.1, 0.2, 0.3, 0.4];
    vi.mocked(ai.models.embedContent).mockResolvedValue({
      embeddings: [{ values: mockVector }],
    } as any);

    const result = await embedImage({ data: "base64data", mimeType: "image/jpeg" });

    expect(result).toEqual(mockVector);
    expect(ai.models.embedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gemini-embedding-2-preview",
        contents: [{ inlineData: { mimeType: "image/jpeg", data: "base64data" } }],
      }),
    );
  });

  it("returns empty array when embeddings response is empty", async () => {
    vi.mocked(ai.models.embedContent).mockResolvedValue({
      embeddings: [],
    } as any);

    const result = await embedImage({ data: "base64data", mimeType: "image/jpeg" });
    expect(result).toEqual([]);
  });

  it("returns empty array when values are undefined", async () => {
    vi.mocked(ai.models.embedContent).mockResolvedValue({
      embeddings: [{ values: undefined }],
    } as any);

    const result = await embedImage({ data: "base64data", mimeType: "image/jpeg" });
    expect(result).toEqual([]);
  });

  it("propagates API errors", async () => {
    vi.mocked(ai.models.embedContent).mockRejectedValue(new Error("quota exceeded"));

    await expect(
      embedImage({ data: "base64data", mimeType: "image/jpeg" }),
    ).rejects.toThrow("quota exceeded");
  });

  it("rejects images with empty data", async () => {
    await expect(embedImage({ data: "", mimeType: "image/png" })).rejects.toThrow("empty");
  });

  it("rejects images with unsupported MIME type", async () => {
    await expect(embedImage({ data: "abc", mimeType: "text/html" })).rejects.toThrow("Unsupported");
  });
});
