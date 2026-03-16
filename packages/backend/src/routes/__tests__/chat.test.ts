import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContentMock = vi.fn();

vi.mock("../../services/ai-client.js", () => ({
  ai: {
    models: {
      generateContent: generateContentMock,
    },
  },
  geminiModel: "test-model",
}));

describe("/chat route", () => {
  beforeEach(() => {
    vi.resetModules();
    generateContentMock.mockReset();
  });

  it("returns retry guidance when the Gemini chat quota is exhausted", async () => {
    generateContentMock.mockRejectedValue({
      status: 429,
      message: "Quota exceeded",
    });

    const { chatRoute } = await import("../chat.js");
    const response = await chatRoute.request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "what",
        context: {
          product: null,
          results: [],
        },
        history: [],
      }),
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      reply: expect.stringMatching(/quota/i),
    });
  });
});
