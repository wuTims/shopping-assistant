import { useState, useRef, useEffect } from "react";
import type { ChatMessage, RankedResult } from "@shopping-assistant/shared";

interface Props {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isLoading: boolean;
  showComposer?: boolean;
  isVoiceRecording?: boolean;
  voiceStatus?: string;
  voiceInputTranscript?: string;
  voiceOutputTranscript?: string;
  onMicToggle?: () => void;
  toolActivity?: { active: boolean; toolName: string | null };
  voiceToolResults?: RankedResult[][];
}

export function ChatThread({ messages, onSendMessage, isLoading, showComposer = true, isVoiceRecording, voiceStatus, voiceInputTranscript, voiceOutputTranscript, onMicToggle, toolActivity, voiceToolResults }: Props) {
  const isVoiceSessionActive = voiceStatus === "recording" || voiceStatus === "paused" || voiceStatus === "connecting";
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, voiceInputTranscript, voiceOutputTranscript, toolActivity, voiceToolResults]);

  const handleSubmit = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    onSendMessage(text);
    setInput("");
    inputRef.current?.focus();
  };

  const handleMicClick = () => {
    onMicToggle?.();
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
        {isVoiceSessionActive && voiceInputTranscript && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/60 px-3.5 py-2.5 text-sm text-white/90 italic">
              {voiceInputTranscript}
            </div>
          </div>
        )}
        {isVoiceSessionActive && voiceOutputTranscript && (
          <div className="flex justify-start">
            <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-white/80 border border-gray-100 px-3.5 py-2.5 text-sm text-text-main italic shadow-sm">
              {voiceOutputTranscript}
            </div>
          </div>
        )}
        {isVoiceSessionActive && toolActivity?.active && (
          <div className="flex justify-start">
            <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <div className="bg-white/80 border border-gray-100 rounded-2xl rounded-bl-md px-3.5 py-2.5 shadow-sm flex items-center gap-2">
              <span className="material-icons text-sm text-primary animate-pulse">search</span>
              <span className="text-sm text-text-muted">Searching across marketplaces...</span>
            </div>
          </div>
        )}
        {voiceToolResults && voiceToolResults.length > 0 && voiceToolResults.map((batch, batchIdx) => (
          <div key={batchIdx} className="flex justify-start">
            <div className="w-6 h-6 rounded-full bg-accent-green flex items-center justify-center text-white shrink-0 mr-2 mt-1">
              <span className="material-icons text-xs">smart_toy</span>
            </div>
            <div className="space-y-2 max-w-[85%] overflow-y-auto max-h-[280px] pb-1 no-scrollbar">
              {batch.slice(0, 3).map((r) => (
                <a
                  key={r.result.id}
                  href={r.result.productUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex gap-2.5 bg-white border border-gray-100 rounded-xl shadow-sm hover:shadow-md transition-shadow p-2"
                >
                  {r.result.imageUrl && (
                    <img
                      src={r.result.imageUrl}
                      alt={r.result.title}
                      className="w-16 h-16 rounded-lg object-cover shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-text-main font-medium line-clamp-2 leading-tight">{r.result.title}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs font-semibold text-primary">
                        {r.result.price !== null ? `${r.result.currency ?? "USD"} ${r.result.price}` : "See price"}
                      </span>
                      <span className="text-[10px] text-text-muted bg-gray-50 rounded px-1 py-0.5">{r.result.marketplace}</span>
                    </div>
                    {r.savingsPercent !== null && r.savingsPercent > 0 && (
                      <span className="text-[10px] text-accent-green font-medium">{r.savingsPercent}% savings</span>
                    )}
                  </div>
                </a>
              ))}
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

      {showComposer && (
        <div className="px-3 py-2.5 border-t border-gray-100 bg-background">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && handleSubmit()}
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
                className={`w-10 h-10 flex items-center justify-center rounded-xl transition-colors ${
                  isVoiceRecording
                    ? "bg-red-500 text-white animate-pulse"
                    : "bg-gray-100 text-text-muted hover:bg-gray-200"
                }`}
              >
                <span className="material-icons text-lg">
                  {isVoiceRecording ? "stop" : "mic"}
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
