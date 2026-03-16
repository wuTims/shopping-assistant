import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDisplayInfo, RankedResult, SearchResponse } from "@shopping-assistant/shared";
import App from "../App";

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((evt: unknown) => void) | null = null;
  send = vi.fn((payload: string) => {
    const message = JSON.parse(payload) as { type?: string };
    if (message.type === "config") {
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
      }, 0);
    }
  });
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  constructor() {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

const product: ProductDisplayInfo = {
  name: "Compact Leather Tote",
  price: 99.99,
  currency: "USD",
};

const results: RankedResult[] = Array.from({ length: 4 }, (_, index) => ({
  rank: index + 1,
  confidence: "high",
  confidenceScore: 0.95 - index * 0.05,
  priceDelta: -20,
  savingsPercent: 20,
  comparisonNotes: "Near match",
  priceAvailable: true,
  result: {
    id: `res-${index + 1}`,
    source: "brave",
    retrievalLane: "image",
    matchedQueries: [{ query: "compact leather tote", lane: "image", provider: "brave" }],
    title: `Compact Leather Tote Variant ${index + 1}`,
    price: 79.99 + index,
    currency: "USD",
    imageUrl: "https://example.com/result.jpg",
    productUrl: `https://example.com/result-${index + 1}`,
    marketplace: `Marketplace ${index + 1}`,
    snippet: "Near match",
    structuredData: null,
    raw: {},
  },
}));

const response: SearchResponse = {
  requestId: "req-chat",
  originalProduct: {
    title: product.name,
    price: product.price,
    currency: product.currency,
    imageUrl: "",
    identification: {
      category: "bag",
      description: "Structured leather tote",
      brand: "Example",
      attributes: {
        color: "tan",
        material: "leather",
        style: "structured",
        size: "medium",
      },
      searchQueries: ["compact leather tote"],
      estimatedPriceRange: {
        low: 70,
        high: 120,
        currency: "USD",
      },
    },
  },
  results,
  searchMeta: {
    totalFound: 4,
    braveResultCount: 4,
    groundingResultCount: 0,
    sourceStatus: {
      brave: "ok",
      grounding: "ok",
    },
    sourceDiagnostics: {
      brave: {
        totalQueries: 1,
        successfulQueries: 1,
        failedQueries: 0,
        timedOutQueries: 0,
      },
      grounding: {
        totalQueries: 0,
        successfulQueries: 0,
        failedQueries: 0,
        timedOutQueries: 0,
      },
    },
    laneDiagnostics: {
      textResultCount: 0,
      imageResultCount: 4,
      hybridResultCount: 0,
    },
    searchDurationMs: 1500,
    rankingDurationMs: 200,
    rankingStatus: "ok",
    imageQueryDiagnostics: {
      rawQueryCount: 0,
      acceptedQueries: [],
      rejectedQueries: [],
    },
    rankingFailureReason: null,
  },
};

describe("chat page", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    Object.defineProperty(navigator, "permissions", {
      value: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
      configurable: true,
    });
    Object.assign(chrome, {
      tabs: {
        create: vi.fn(),
      },
      runtime: {
        ...chrome.runtime,
        sendMessage: vi.fn(),
      },
    });
  });

  it("shows a horizontal compact-results strip and a single dedicated composer", () => {
    render(
      <App
        initialPath="/chat"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
        }}
      />,
    );

    expect(screen.getByTestId("chat-results-strip")).toHaveClass("overflow-x-auto");
    expect(screen.getByText("Marketplace 4")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    const voiceButton = screen.getByRole("button", { name: /voice chat/i });
    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(voiceButton).toBeInTheDocument();
    expect(sendButton).toBeInTheDocument();
    expect(voiceButton.compareDocumentPosition(sendButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "How do these compare?" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" });

    expect(screen.getByText("How do these compare?")).toBeInTheDocument();
  });

  it("keeps completed voice turns in chat after the voice session is stopped", async () => {
    render(
      <App
        initialPath="/chat"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
        }}
      />,
    );

    await act(async () => {
      const voiceButtons = screen.getAllByRole("button", { name: /voice chat/i });
      fireEvent.click(voiceButtons[voiceButtons.length - 1]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.onmessage?.({ data: JSON.stringify({ type: "input_transcript", content: "Which one is the best value?" }) });
      ws.onmessage?.({ data: JSON.stringify({ type: "output_transcript", content: "Marketplace 1 looks like the best value right now." }) });
      ws.onmessage?.({ data: JSON.stringify({ type: "turn_complete" }) });
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    const voiceButtons = screen.getAllByRole("button", { name: /voice chat/i });
    fireEvent.click(voiceButtons[voiceButtons.length - 1]);
    fireEvent.click(screen.getAllByRole("button", { name: /voice chat/i }).slice(-1)[0]);

    expect(screen.getByText("Which one is the best value?")).toBeInTheDocument();
    expect(screen.getByText("Marketplace 1 looks like the best value right now.")).toBeInTheDocument();
  });

  it("defaults chat focus to the current product and lets the user switch it from the result strip", () => {
    render(
      <App
        initialPath="/chat"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
        }}
      />,
    );

    const currentProductButton = screen.getByRole("button", { name: /^focus compact leather tote$/i });
    const resultButton = screen.getByRole("button", { name: /^focus compact leather tote variant 2$/i });

    expect(currentProductButton).toHaveAttribute("aria-pressed", "true");
    expect(resultButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(resultButton);

    expect(currentProductButton).toHaveAttribute("aria-pressed", "false");
    expect(resultButton).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the selected focused result in the chat request context", () => {
    render(
      <App
        initialPath="/chat"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^focus compact leather tote variant 2$/i }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Tell me about this option" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "CHAT_REQUEST",
      request: expect.objectContaining({
        message: "Tell me about this option",
        context: expect.objectContaining({
          product: expect.objectContaining({
            title: "Compact Leather Tote Variant 2",
            price: 80.99,
            currency: "USD",
            marketplace: "Marketplace 2",
            imageUrl: "https://example.com/result.jpg",
          }),
          results,
        }),
      }),
    }));
  });

  it("opens the product link from the chat strip without changing focus", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <App
        initialPath="/chat"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
        }}
      />,
    );

    const resultButton = screen.getByRole("button", { name: /^focus compact leather tote variant 2$/i });
    expect(resultButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: /^open compact leather tote variant 2$/i }));

    expect(openSpy).toHaveBeenCalledWith("https://example.com/result-2", "_blank", "noopener");
    expect(resultButton).toHaveAttribute("aria-pressed", "false");
  });
});
