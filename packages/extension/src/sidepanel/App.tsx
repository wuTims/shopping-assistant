import { useState, useEffect, useCallback, useRef } from "react";
import type {
  IdentifiedProduct,
  ProductDisplayInfo,
  SearchResponse,
  ChatMessage,
  ChatRequest,
  BackgroundToSidePanelMessage,
} from "@shopping-assistant/shared";
import { Header } from "./components/Header";
import { ProductSection } from "./components/ProductSection";
import { PriceBar } from "./components/PriceBar";
import { ResultCard } from "./components/ResultCard";
import { ChatThread } from "./components/ChatThread";

type ViewState =
  | { view: "empty" }
  | { view: "identifying" }
  | { view: "product_selection"; products: IdentifiedProduct[]; screenshotDataUrl: string; pageUrl: string; tabId: number }
  | { view: "loading"; product: ProductDisplayInfo; phase: 1 | 2 | 3 }
  | { view: "results"; product: ProductDisplayInfo; response: SearchResponse }
  | { view: "error"; message: string };

export default function App() {
  const [state, setState] = useState<ViewState>({ view: "empty" });
  const [chatActive, setChatActive] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [priceBarCollapsed, setPriceBarCollapsed] = useState(false);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const currentTabIdRef = useRef<number | null>(null);

  // ── Request initial state from service worker ──
  useEffect(() => {
    chrome.runtime.sendMessage(
      { type: "GET_STATE", tabId: currentTabIdRef.current },
      (response: BackgroundToSidePanelMessage | null) => {
        if (chrome.runtime.lastError || !response) return;
        handleMessage(response);
      },
    );
  }, []);

  // ── Listen for messages from service worker ──
  useEffect(() => {
    const listener = (message: Record<string, unknown>) => {
      if (message.target !== "sidepanel") return;
      if (typeof message.tabId === "number") {
        currentTabIdRef.current = message.tabId;
      }
      handleMessage(message as BackgroundToSidePanelMessage);
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      clearPhaseTimers();
    };
  }, []);

  function handleMessage(message: BackgroundToSidePanelMessage) {
    switch (message.type) {
      case "identifying":
        setState({ view: "identifying" });
        setChatActive(false);
        setChatMessages([]);
        break;
      case "product_selection":
        clearPhaseTimers();
        setState({
          view: "product_selection",
          products: message.products,
          screenshotDataUrl: message.screenshotDataUrl,
          pageUrl: message.pageUrl,
          tabId: message.tabId,
        });
        break;
      case "searching":
        setState({ view: "loading", product: message.product, phase: 1 });
        setChatActive(false);
        setChatMessages([]);
        setChatLoading(false);
        setPriceBarCollapsed(false);
        startPhaseTimers();
        break;
      case "results":
        clearPhaseTimers();
        setState({ view: "results", product: message.product, response: message.response });
        break;
      case "error":
        clearPhaseTimers();
        setState({ view: "error", message: message.message });
        break;
      case "chat_response":
        setChatLoading(false);
        setChatMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: message.reply,
            inputMode: "text",
            timestamp: Date.now(),
            context: null,
          },
        ]);
        break;
      case "chat_error":
        setChatLoading(false);
        setChatMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "Sorry, I couldn't respond. Please try again.",
            inputMode: "text",
            timestamp: Date.now(),
            context: null,
          },
        ]);
        break;
    }
  }

  function startPhaseTimers() {
    clearPhaseTimers();
    phaseTimersRef.current = [
      setTimeout(() => setState((s) => s.view === "loading" ? { ...s, phase: 2 } : s), 2000),
      setTimeout(() => setState((s) => s.view === "loading" ? { ...s, phase: 3 } : s), 5000),
    ];
  }

  function clearPhaseTimers() {
    phaseTimersRef.current.forEach(clearTimeout);
    phaseTimersRef.current = [];
  }

  const handleSendMessage = useCallback((text: string) => {
    if (state.view !== "results") return;

    if (!chatActive) {
      setChatActive(true);
      setPriceBarCollapsed(true);
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      inputMode: "text",
      timestamp: Date.now(),
      context: chatMessages.length === 0 ? {
        currentProduct: state.product,
        searchResults: state.response.results,
      } : null,
    };

    const newMessages = [...chatMessages, userMessage];
    setChatMessages(newMessages);
    setChatLoading(true);

    const request: ChatRequest = {
      message: text,
      context: {
        product: state.product,
        results: state.response.results,
      },
      history: chatMessages,
    };

    chrome.runtime.sendMessage({ type: "CHAT_REQUEST", request, tabId: currentTabIdRef.current });
  }, [state, chatActive, chatMessages]);

  const phaseText = (phase: 1 | 2 | 3) => {
    switch (phase) {
      case 1: return "Identifying product...";
      case 2: return "Searching across marketplaces...";
      case 3: return "Comparing results...";
    }
  };

  // Show all results — even those without price — ranked by confidence/similarity
  const displayResults = state.view === "results"
    ? state.response.results
    : [];
  const noPriceCount = state.view === "results"
    ? state.response.results.filter((r) => !r.priceAvailable).length
    : 0;

  return (
    <div className="flex flex-col h-screen bg-background font-display">
      <Header />

      {/* Empty state */}
      {state.view === "empty" && (
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <span className="material-icons text-5xl text-gray-300 mb-3 block">shopping_bag</span>
            <p className="text-text-muted text-sm">Click the extension icon or a product overlay to find better prices.</p>
          </div>
        </main>
      )}

      {/* Identifying state */}
      {state.view === "identifying" && (
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <div className="w-10 h-10 border-4 border-gray-200 border-t-primary rounded-full animate-spin mb-4 mx-auto" />
            <p className="text-sm text-text-muted animate-pulse">Identifying products...</p>
          </div>
        </main>
      )}

      {/* Product selection */}
      {state.view === "product_selection" && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar">
          <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
            <h3 className="font-semibold text-base mb-2 text-text-main">Multiple products found</h3>
            <p className="text-sm text-text-muted mb-4">Which product are you looking for?</p>
            <div className="space-y-2">
              {state.products.map((product, i) => (
                <button
                  key={i}
                  onClick={() => {
                    chrome.runtime.sendMessage({
                      type: "select_product",
                      tabId: state.tabId,
                      product,
                      screenshotDataUrl: state.screenshotDataUrl,
                      pageUrl: state.pageUrl,
                    });
                    setState({
                      view: "loading",
                      product: { name: product.name, price: product.price, currency: product.currency },
                      phase: 1,
                    });
                    startPhaseTimers();
                  }}
                  className="w-full flex items-center justify-between p-3 rounded-xl border border-gray-100 hover:border-primary hover:bg-orange-50 transition-colors text-left group"
                >
                  <p className="text-sm font-medium text-text-main group-hover:text-primary truncate">{product.name}</p>
                  {product.price != null && (
                    <span className="text-sm font-bold text-text-main shrink-0 ml-2">
                      {product.currency ?? "$"}{product.price.toFixed(2)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        </main>
      )}

      {/* Loading state */}
      {state.view === "loading" && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-10 h-10 border-4 border-gray-200 border-t-primary rounded-full animate-spin mb-4" />
            <p className="text-sm text-text-muted animate-pulse">{phaseText(state.phase)}</p>
          </div>
        </main>
      )}

      {/* Error state */}
      {state.view === "error" && (
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <span className="material-icons text-4xl text-gray-300 mb-3 block">error_outline</span>
            <p className="text-sm text-text-main mb-1">{state.message}</p>
            <button
              onClick={() => setState({ view: "empty" })}
              className="mt-4 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors"
            >
              Try Again
            </button>
          </div>
        </main>
      )}

      {/* Results — full view (no chat) */}
      {state.view === "results" && !chatActive && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 pb-40 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <PriceBar productPrice={state.product.price} currency={state.product.currency} response={state.response} />

          <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
            <h3 className="font-semibold text-base mb-3 text-text-main">
              Top results ({displayResults.length})
            </h3>
            {displayResults.length === 0 ? (
              <p className="text-sm text-text-muted">No alternatives with pricing found.</p>
            ) : (
              <div className="space-y-3 divide-y divide-gray-100">
                {displayResults.map((ranked) => (
                  <div key={ranked.result.id} className="pt-3 first:pt-0">
                    <ResultCard ranked={ranked} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {noPriceCount > 0 && (
            <p className="text-xs text-text-muted text-center">
              {noPriceCount} result{noPriceCount > 1 ? "s" : ""} shown without price
            </p>
          )}

          <p className="text-xs text-text-muted text-center pb-2">
            Found {state.response.searchMeta.totalFound} results in{" "}
            {(state.response.searchMeta.searchDurationMs / 1000).toFixed(1)}s
          </p>
        </main>
      )}

      {/* Results — split view (with chat) */}
      {state.view === "results" && chatActive && (
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Compressed results (top ~40%) */}
          <div className="h-[40%] overflow-y-auto px-4 pt-3 pb-2 space-y-2 border-b border-gray-200 no-scrollbar">
            <ProductSection product={state.product} />
            <PriceBar
              productPrice={state.product.price}
              currency={state.product.currency}
              response={state.response}
              collapsed={priceBarCollapsed}
              onToggle={() => setPriceBarCollapsed(!priceBarCollapsed)}
            />
            <div className="space-y-0.5">
              {displayResults.map((ranked) => (
                <ResultCard key={ranked.result.id} ranked={ranked} compact />
              ))}
            </div>
          </div>

          {/* Chat area (bottom ~60%) */}
          <div className="h-[60%] flex flex-col">
            <ChatThread
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              isLoading={chatLoading}
            />
          </div>
        </main>
      )}

      {/* Input bar for results view (pre-chat) */}
      {state.view === "results" && !chatActive && (
        <div className="sticky bottom-0 left-0 right-0 bg-background border-t border-gray-100">
          {/* Nudge */}
          <div className="px-4 pt-3 pb-1">
            <div className="bg-orange-50 border border-orange-100 rounded-xl p-2.5 flex items-center gap-2.5">
              <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0">
                <span className="material-icons text-xs">smart_toy</span>
              </div>
              <p className="text-xs text-text-main">I can help you compare — hold mic or type below.</p>
            </div>
          </div>

          {/* Input */}
          <div className="px-3 py-2.5">
            <ChatInputBar onSend={handleSendMessage} />
          </div>
        </div>
      )}
    </div>
  );
}

function ChatInputBar({ onSend }: { onSend: (text: string) => void }) {
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  const handleMicClick = () => {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed", bottom: "70px", right: "20px",
      background: "#1a202c", color: "white", padding: "6px 12px",
      borderRadius: "8px", fontSize: "12px", zIndex: "9999",
    } as CSSStyleDeclaration);
    el.textContent = "Voice coming soon";
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && handleSubmit()}
        placeholder="Ask about these..."
        className="flex-1 bg-white border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-text-main placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
      />
      {input.trim() ? (
        <button
          onClick={handleSubmit}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary-dark transition-colors"
        >
          <span className="material-icons text-lg">send</span>
        </button>
      ) : (
        <button
          onClick={handleMicClick}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-gray-100 text-text-muted hover:bg-gray-200 transition-colors"
        >
          <span className="material-icons text-lg">mic</span>
        </button>
      )}
    </div>
  );
}
