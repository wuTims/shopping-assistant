import { useState, useEffect, useCallback, useRef } from "react";
import type {
  DetectedProduct,
  SearchResponse,
  ChatMessage,
  PanelState,
  BackgroundToSidePanelMessage,
  ChatRequest,
} from "@shopping-assistant/shared";
import { Header } from "./components/Header";
import { ProductSection } from "./components/ProductSection";
import { PriceBar } from "./components/PriceBar";
import { ResultCard } from "./components/ResultCard";
import { ChatThread } from "./components/ChatThread";

type ViewState =
  | { view: "empty" }
  | { view: "loading"; product: DetectedProduct; phase: 1 | 2 | 3 }
  | { view: "results"; product: DetectedProduct; response: SearchResponse }
  | { view: "error"; product: DetectedProduct; errorMessage: string };

export default function App() {
  const [state, setState] = useState<ViewState>({ view: "empty" });
  const [chatActive, setChatActive] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [priceBarCollapsed, setPriceBarCollapsed] = useState(false);
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ── Request initial state from service worker ──
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response: PanelState) => {
      if (chrome.runtime.lastError || !response) return;
      switch (response.view) {
        case "loading":
          setState({ view: "loading", product: response.product!, phase: response.loadingPhase ?? 1 });
          startPhaseTimers();
          break;
        case "results":
          setState({ view: "results", product: response.product!, response: response.response! });
          break;
        case "error":
          setState({ view: "error", product: response.product!, errorMessage: response.error ?? "Search failed" });
          break;
        default:
          setState({ view: "empty" });
      }
    });
  }, []);

  // ── Listen for messages from service worker ──
  useEffect(() => {
    const listener = (message: BackgroundToSidePanelMessage) => {
      switch (message.type) {
        case "SEARCH_STARTED":
          setState({ view: "loading", product: message.product, phase: 1 });
          setChatActive(false);
          setChatMessages([]);
          setChatLoading(false);
          setPriceBarCollapsed(false);
          startPhaseTimers();
          break;
        case "SEARCH_COMPLETE":
          clearPhaseTimers();
          setState({ view: "results", product: message.product, response: message.response });
          break;
        case "SEARCH_ERROR":
          clearPhaseTimers();
          setState({ view: "error", product: message.product, errorMessage: message.error });
          break;
        case "CHAT_RESPONSE":
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
        case "CHAT_ERROR":
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
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  function startPhaseTimers() {
    clearPhaseTimers();
    const t1 = setTimeout(() => setState((s) => s.view === "loading" ? { ...s, phase: 2 } : s), 2000);
    const t2 = setTimeout(() => setState((s) => s.view === "loading" ? { ...s, phase: 3 } : s), 5000);
    phaseTimerRef.current = t2; // store last one for cleanup
    // Store t1 in a closure — cleaned up via clearPhaseTimers if SEARCH_COMPLETE arrives
  }

  function clearPhaseTimers() {
    if (phaseTimerRef.current) clearTimeout(phaseTimerRef.current);
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
      history: newMessages,
    };

    chrome.runtime.sendMessage({ type: "CHAT_REQUEST", request });
  }, [state, chatActive, chatMessages]);

  const handleRetry = () => {
    if (state.view === "error") {
      chrome.runtime.sendMessage({ type: "PRODUCT_CLICKED", product: state.product });
    }
  };

  // ── Loading phase text ──
  const phaseText = (phase: 1 | 2 | 3) => {
    switch (phase) {
      case 1: return "Identifying product...";
      case 2: return "Searching across marketplaces...";
      case 3: return "Comparing results...";
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background font-display">
      <Header />

      {state.view === "empty" && (
        <main className="flex-1 flex items-center justify-center px-6">
          <div className="text-center">
            <span className="material-icons text-5xl text-gray-300 mb-3 block">shopping_bag</span>
            <p className="text-text-muted text-sm">Click a product overlay to find better prices.</p>
          </div>
        </main>
      )}

      {state.view === "loading" && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <div className="flex flex-col items-center justify-center py-12">
            <div className="w-10 h-10 border-4 border-gray-200 border-t-primary rounded-full animate-spin mb-4" />
            <p className="text-sm text-text-muted animate-pulse">{phaseText(state.phase)}</p>
          </div>
        </main>
      )}

      {state.view === "error" && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="material-icons text-4xl text-gray-300 mb-3">error_outline</span>
            <p className="text-sm text-text-main mb-1">Couldn't find alternatives for this product.</p>
            <button
              onClick={handleRetry}
              className="mt-4 bg-primary hover:bg-primary-dark text-white text-sm font-semibold px-6 py-2.5 rounded-xl transition-colors"
            >
              Try Again
            </button>
          </div>
        </main>
      )}

      {state.view === "results" && !chatActive && (
        <main className="flex-1 overflow-y-auto px-4 pt-4 pb-40 space-y-4 no-scrollbar">
          <ProductSection product={state.product} />
          <PriceBar product={state.product} response={state.response} />

          {/* Results list */}
          <section className="bg-surface rounded-2xl p-4 shadow-soft border border-gray-100">
            <h3 className="font-semibold text-base mb-3 text-text-main">
              Top results ({state.response.results.length})
            </h3>
            <div className="space-y-3 divide-y divide-gray-100">
              {state.response.results.map((ranked) => (
                <div key={ranked.result.id} className="pt-3 first:pt-0">
                  <ResultCard ranked={ranked} />
                </div>
              ))}
            </div>
          </section>
        </main>
      )}

      {state.view === "results" && chatActive && (
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Compressed results (top ~40%) */}
          <div className="h-[40%] overflow-y-auto px-4 pt-3 pb-2 space-y-2 border-b border-gray-200 no-scrollbar">
            <ProductSection product={state.product} />
            <PriceBar
              product={state.product}
              response={state.response}
              collapsed={priceBarCollapsed}
              onToggle={() => setPriceBarCollapsed(!priceBarCollapsed)}
            />
            <div className="space-y-0.5">
              {state.response.results.map((ranked) => (
                <ResultCard key={ranked.result.id} ranked={ranked} compact />
              ))}
            </div>
          </div>

          {/* Chat area (bottom ~60%) */}
          <div className="h-[60%] flex flex-col">
            <ChatThread
              product={state.product}
              results={state.response.results}
              messages={chatMessages}
              onSendMessage={handleSendMessage}
              isLoading={chatLoading}
            />
          </div>
        </main>
      )}

      {/* Input bar for results view (pre-split) */}
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
            <ChatInputBar
              onSend={(text) => handleSendMessage(text)}
            />
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
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
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
