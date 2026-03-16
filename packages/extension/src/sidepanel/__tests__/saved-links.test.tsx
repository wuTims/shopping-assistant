import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDisplayInfo, SearchResponse } from "@shopping-assistant/shared";
import App from "../App";

const product: ProductDisplayInfo = {
  name: "Compact Leather Tote",
  price: 99.99,
  currency: "USD",
};

const response: SearchResponse = {
  requestId: "req-saved",
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
  results: [
    {
      rank: 1,
      confidence: "high",
      confidenceScore: 0.96,
      priceDelta: -20,
      savingsPercent: 20,
      comparisonNotes: "Near match",
      priceAvailable: true,
      result: {
        id: "res-1",
        source: "brave",
        retrievalLane: "text",
        matchedQueries: [{ query: "compact leather tote", lane: "text", provider: "brave" }],
        title: "Compact Leather Tote Bag",
        price: 79.99,
        currency: "USD",
        imageUrl: "https://example.com/result.jpg",
        productUrl: "https://example.com/result",
        marketplace: "AliExpress",
        snippet: "Near match",
        structuredData: null,
        raw: {},
      },
    },
  ],
  searchMeta: {
    totalFound: 1,
    braveResultCount: 1,
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
      textResultCount: 1,
      imageResultCount: 0,
      hybridResultCount: 0,
    },
    searchDurationMs: 1200,
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

describe("saved links flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
  });

  it("lets a result be saved from home and managed from settings", () => {
    render(
      <App
        initialPath="/"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
          savedLinks: [],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save compact leather tote bag/i }));
    fireEvent.click(screen.getByRole("link", { name: /settings/i }));

    expect(screen.getByText("Compact Leather Tote Bag")).toBeInTheDocument();
    expect(screen.getByText("AliExpress")).toBeInTheDocument();
  });

  it("opens the saved product URL from settings", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    render(
      <App
        initialPath="/settings"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
          savedLinks: [
            {
              id: "res-1",
              name: "Compact Leather Tote Bag",
              marketplace: "AliExpress",
              priceLabel: "$79.99",
              imageUrl: "https://example.com/result.jpg",
              productUrl: "https://example.com/result",
            },
          ],
        }}
      />,
    );

    const openButtons = screen.getAllByRole("button", { name: /open compact leather tote bag/i });
    fireEvent.click(openButtons[openButtons.length - 1]);

    expect(openSpy).toHaveBeenCalledWith("https://example.com/result", "_blank", "noopener");
  });

  it("truncates long saved-link names and keeps the actions area separate", () => {
    render(
      <App
        initialPath="/settings"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
          savedLinks: [
            {
              id: "long-1",
              name: "Mini Pocket Scale 500g 200g 100g 1kg LCD Electronic Jewelry Kitchen Digital Gram Scale",
              marketplace: "AliExpress",
              priceLabel: "$0.99",
              imageUrl: null,
              productUrl: "https://example.com/scale",
            },
          ],
        }}
      />,
    );

    const price = screen.getByText("$0.99");
    const openButtons = screen.getAllByRole("button", {
      name: /open mini pocket scale 500g 200g 100g 1kg lcd electronic jewelry kitchen digital gram scale/i,
    });
    const removeButton = screen.getByRole("button", { name: /remove mini pocket scale/i });

    expect(openButtons[0]).toHaveTextContent("Mini Pocket Scale 500g 200g 100g 1kg LCD …");
    expect(price).toHaveClass("shrink-0");
    expect(openButtons[openButtons.length - 1]).toHaveClass("shrink-0");
    expect(removeButton).toHaveClass("shrink-0");
  });
});
