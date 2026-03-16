import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductDisplayInfo, SearchResponse } from "@shopping-assistant/shared";
import App from "../App";

const product: ProductDisplayInfo = {
  name: "Compact Leather Tote",
  price: 99.99,
  currency: "USD",
};

const response: SearchResponse = {
  requestId: "req-settings",
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
  results: [],
  searchMeta: {
    totalFound: 0,
    braveResultCount: 0,
    groundingResultCount: 0,
    sourceStatus: {
      brave: "ok",
      grounding: "ok",
    },
    sourceDiagnostics: {
      brave: {
        totalQueries: 0,
        successfulQueries: 0,
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
      imageResultCount: 0,
      hybridResultCount: 0,
    },
    searchDurationMs: 0,
    rankingDurationMs: 0,
    rankingStatus: "ok",
    imageQueryDiagnostics: {
      rawQueryCount: 0,
      acceptedQueries: [],
      rejectedQueries: [],
    },
    rankingFailureReason: null,
  },
};

describe("settings persistence", () => {
  beforeEach(() => {
    let stored = {
      sidepanelSettings: {
        selectedThemeId: "sage-gold",
        savedLinks: [
          {
            id: "saved-1",
            name: "Compact Tote Alt",
            marketplace: "AliExpress",
            priceLabel: "$79.99",
            imageUrl: null,
            productUrl: "https://example.com/saved-1",
          },
        ],
      },
    };

    chrome.storage.local.get = vi.fn(async () => stored);
    chrome.storage.local.set = vi.fn(async (value: Record<string, unknown>) => {
      stored = { ...stored, ...value };
    });
  });

  it("loads saved links and persists theme changes across remounts", async () => {
    const { unmount } = render(
      <App
        initialPath="/settings"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText("Compact Tote Alt")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /theme sage & gold/i })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: /remove compact tote alt/i }));
    await waitFor(() => expect(screen.queryByText("Compact Tote Alt")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /theme cognac & cream/i }));
    await waitFor(() => expect(chrome.storage.local.set).toHaveBeenCalled());

    unmount();

    render(
      <App
        initialPath="/settings"
        initialState={{
          view: "results",
          product,
          response,
          chatMessages: [],
          chatLoading: false,
        }}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /theme cognac & cream/i })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByText("Compact Tote Alt")).not.toBeInTheDocument();
  });
});
