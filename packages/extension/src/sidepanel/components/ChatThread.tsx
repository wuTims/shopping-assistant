import { useState, useRef, useEffect } from "react";
import type { ChatMessage, DetectedProduct, RankedResult } from "@shopping-assistant/shared";

interface Props {
  product: DetectedProduct;
  results: RankedResult[];
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isLoading: boolean;
}

export function ChatThread({ product, results, messages, onSendMessage, isLoading }: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    onSendMessage(text);
    setInput("");
    inputRef.current?.focus();
  };

  const handleMicClick = () => {
    // Phase 3 placeholder — show tooltip
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
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar">
        {messages.length === 0 && (
          <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 flex items-center gap-3">
            <div className="w-7 h-7 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <p className="text-sm text-text-main">I can help you compare — hold mic or type below.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
                <span className="material-icons text-xs">smart_toy</span>
              </div>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-primary text-white rounded-br-md"
                  : "bg-white border border-gray-100 text-text-main rounded-bl-md shadow-sm"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="px-3 py-2.5 border-t border-gray-100 bg-background">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            placeholder="Ask about these..."
            className="flex-1 bg-white border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-text-main placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            disabled={isLoading}
          />
          {input.trim() ? (
            <button
              onClick={handleSubmit}
              disabled={isLoading}
              className="w-10 h-10 flex items-center justify-center rounded-xl bg-primary text-white hover:bg-primary-dark transition-colors disabled:opacity-50"
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
      </div>
    </div>
  );
}
