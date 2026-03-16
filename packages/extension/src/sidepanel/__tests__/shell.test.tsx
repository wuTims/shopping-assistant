import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProductDisplayInfo, SearchResponse } from "@shopping-assistant/shared";
import App from "../App";

const product: ProductDisplayInfo = {
  name: "Compact Leather Tote",
  price: 99.99,
  currency: "USD",
  imageUrl: "https://example.com/product.jpg",
  marketplace: "Original Store",
};

const response: SearchResponse = {
  requestId: "req-1",
  originalProduct: {
    title: product.name,
    price: product.price,
    currency: product.currency,
    imageUrl: product.imageUrl ?? "",
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
      confidenceScore: 0.94,
      priceDelta: -20,
      savingsPercent: 20,
      comparisonNotes: "Same silhouette and material",
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

describe("sidepanel routed shell", () => {
  it("preserves search results while navigating between home, chat, and settings", () => {
    render(
      <App
        initialPath="/"
        initialState={{
          view: "results",
          product,
          response,
          savedLinks: [],
          chatMessages: [],
          chatLoading: false,
        }}
      />,
    );

    expect(screen.getByText("Top results")).toBeInTheDocument();
    expect(screen.getByText("Compact Leather Tote Bag")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /chat now/i }));
    expect(screen.getByText(/shopping assistant/i)).toBeInTheDocument();
    expect(screen.getByText("AliExpress")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /settings/i }));
    expect(screen.getByText("Settings")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /back home/i }));
    expect(screen.getByText("Top results")).toBeInTheDocument();
    expect(screen.getByText("Compact Leather Tote Bag")).toBeInTheDocument();
  });
});
