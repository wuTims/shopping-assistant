import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @google/genai before importing live module
const mockSession = {
  sendRealtimeInput: vi.fn(),
  sendClientContent: vi.fn(),
  close: vi.fn(),
};

const mockConnect = vi.fn().mockResolvedValue(mockSession);

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    live = { connect: mockConnect };
  },
  Modality: { AUDIO: "AUDIO" },
}));

const { liveWebSocket } = await import("../live.js");

function createMockWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
}

describe("liveWebSocket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns WSEvents with onOpen, onMessage, onClose, onError", () => {
    const events = liveWebSocket({});
    expect(events.onOpen).toBeDefined();
    expect(events.onMessage).toBeDefined();
    expect(events.onClose).toBeDefined();
  });

  it("does not open upstream session until config message", () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("opens upstream session on config message with product context", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    const configMsg = JSON.stringify({
      type: "config",
      context: { product: { name: "Test Sneaker" }, results: [] },
    });

    await events.onMessage!({ data: configMsg } as MessageEvent, ws as any);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    const connectArgs = mockConnect.mock.calls[0][0];
    expect(connectArgs.model).toBeDefined();
    expect(connectArgs.config.responseModalities).toContain("AUDIO");
  });

  it("forwards audio messages via sendRealtimeInput", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "config", context: {} }) } as MessageEvent,
      ws as any,
    );

    const audioMsg = JSON.stringify({
      type: "audio",
      encoding: "pcm_s16le",
      sampleRateHz: 16000,
      data: "AAAA",
    });
    await events.onMessage!({ data: audioMsg } as MessageEvent, ws as any);

    expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
      audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" },
    });
  });

  it("forwards text messages via sendClientContent (ordered turns)", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "config", context: {} }) } as MessageEvent,
      ws as any,
    );

    await events.onMessage!(
      { data: JSON.stringify({ type: "text", content: "hello" }) } as MessageEvent,
      ws as any,
    );

    expect(mockSession.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: "user", parts: [{ text: "hello" }] }],
      turnComplete: true,
    });
  });

  it("forwards audioStreamEnd to upstream", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "config", context: {} }) } as MessageEvent,
      ws as any,
    );

    await events.onMessage!(
      { data: JSON.stringify({ type: "audioStreamEnd" }) } as MessageEvent,
      ws as any,
    );

    expect(mockSession.sendRealtimeInput).toHaveBeenCalledWith({
      audioStreamEnd: true,
    });
  });

  it("sends error if audio/text received before config", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "audio", encoding: "pcm_s16le", sampleRateHz: 16000, data: "AA" }) } as MessageEvent,
      ws as any,
    );

    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining('"type":"error"'),
    );
  });

  it("closes upstream session on client disconnect", async () => {
    const events = liveWebSocket({});
    const ws = createMockWs();
    events.onOpen!({} as Event, ws as any);

    await events.onMessage!(
      { data: JSON.stringify({ type: "config", context: {} }) } as MessageEvent,
      ws as any,
    );

    events.onClose!({} as Event, ws as any);
    expect(mockSession.close).toHaveBeenCalled();
  });
});
