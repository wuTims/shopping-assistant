import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    rankingFailureReason: null,
  },
};

describe("saved links flow", () => {
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
});
