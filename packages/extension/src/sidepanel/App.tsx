import { useState, useEffect } from "react";
import type {
  IdentifiedProduct,
  SearchResponse,
  RankedResult,
} from "@shopping-assistant/shared";

type PanelState =
  | { kind: "idle" }
  | { kind: "identifying" }
  | { kind: "product_selection"; products: IdentifiedProduct[]; screenshotDataUrl: string; pageUrl: string }
  | { kind: "searching"; product: IdentifiedProduct }
  | { kind: "results"; response: SearchResponse }
  | { kind: "error"; message: string };

export default function App() {
  const [state, setState] = useState<PanelState>({ kind: "idle" });

  useEffect(() => {
    const listener = (message: Record<string, unknown>) => {
      if (message.target !== "sidepanel") return;

      switch (message.type) {
        case "product_selection":
          setState({
            kind: "product_selection",
            products: message.products as IdentifiedProduct[],
            screenshotDataUrl: message.screenshotDataUrl as string,
            pageUrl: message.pageUrl as string,
          });
          break;
        case "searching":
          setState({
            kind: "searching",
            product: message.product as IdentifiedProduct,
          });
          break;
        case "results":
          setState({
            kind: "results",
            response: message.response as SearchResponse,
          });
          break;
        case "error":
          setState({
            kind: "error",
            message: (message.message as string) || "Something went wrong.",
          });
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <div className="panel">
      <header className="header">
        <h1>Shopping Assistant</h1>
      </header>
      <main className="main">
        {state.kind === "idle" && (
          <p className="placeholder">
            Click the extension icon on any product page to find cheaper alternatives.
          </p>
        )}

        {state.kind === "identifying" && (
          <p className="status">Identifying products...</p>
        )}

        {state.kind === "product_selection" && (
          <ProductSelectionGrid
            products={state.products}
            onSelect={(product) => {
              chrome.runtime.sendMessage({
                type: "select_product",
                tabId: null, // Service worker will use sender tab
                product,
                screenshotDataUrl: state.screenshotDataUrl,
                pageUrl: state.pageUrl,
              });
              setState({ kind: "searching", product });
            }}
          />
        )}

        {state.kind === "searching" && (
          <div className="status">
            <p>Searching for cheaper alternatives...</p>
            <p className="product-name">{state.product.name}</p>
            {state.product.price != null && (
              <p className="product-price">
                {state.product.currency ?? "$"}{state.product.price.toFixed(2)}
              </p>
            )}
          </div>
        )}

        {state.kind === "results" && (
          <ResultsList response={state.response} />
        )}

        {state.kind === "error" && (
          <div className="error">
            <p>{state.message}</p>
            <button onClick={() => setState({ kind: "idle" })}>Try again</button>
          </div>
        )}
      </main>
    </div>
  );
}

function ProductSelectionGrid({
  products,
  onSelect,
}: {
  products: IdentifiedProduct[];
  onSelect: (product: IdentifiedProduct) => void;
}) {
  return (
    <div className="product-grid">
      <p>Multiple products found. Which one?</p>
      {products.map((product, i) => (
        <button
          key={i}
          className="product-card"
          onClick={() => onSelect(product)}
        >
          <span className="product-name">{product.name}</span>
          {product.price != null && (
            <span className="product-price">
              {product.currency ?? "$"}{product.price.toFixed(2)}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function ResultsList({ response }: { response: SearchResponse }) {
  // Filter to only show results with prices
  const displayResults = response.results.filter((r) => r.priceAvailable);
  const hiddenCount = response.results.length - displayResults.length;

  return (
    <div className="results">
      <div className="original-product">
        <h2>{response.originalProduct.title ?? "Product"}</h2>
        {response.originalProduct.price != null && (
          <p className="original-price">
            {response.originalProduct.currency ?? "$"}
            {response.originalProduct.price.toFixed(2)}
          </p>
        )}
      </div>

      {displayResults.length === 0 ? (
        <p className="no-results">No alternatives with pricing found.</p>
      ) : (
        <ul className="result-list">
          {displayResults.map((ranked: RankedResult) => (
            <li key={ranked.result.id} className="result-item">
              <a
                href={ranked.result.productUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="result-title">{ranked.result.title}</span>
                <span className="result-marketplace">{ranked.result.marketplace}</span>
                <span className="result-price">
                  {ranked.result.currency ?? "$"}
                  {ranked.result.price?.toFixed(2)}
                </span>
                {ranked.savingsPercent != null && ranked.savingsPercent > 0 && (
                  <span className="savings">
                    Save {ranked.savingsPercent.toFixed(0)}%
                  </span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}

      {hiddenCount > 0 && (
        <p className="hidden-count">
          {hiddenCount} result{hiddenCount > 1 ? "s" : ""} hidden (no price available)
        </p>
      )}

      <p className="meta">
        Found {response.searchMeta.totalFound} results in{" "}
        {(response.searchMeta.searchDurationMs / 1000).toFixed(1)}s
      </p>
    </div>
  );
}
