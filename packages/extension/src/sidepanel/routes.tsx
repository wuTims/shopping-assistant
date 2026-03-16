import { useState, type ReactNode } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { ChatThread } from "./components/ChatThread";
import { PriceBar } from "./components/PriceBar";
import { ProductSection } from "./components/ProductSection";
import { ResultCard } from "./components/ResultCard";
import { useSidepanelState } from "./state/SidepanelStateContext";

function Shell({
  title,
  rightAction,
  children,
}: {
  title: string;
  rightAction?: ReactNode;
  children: ReactNode;
}) {
  const { selectedTheme } = useSidepanelState();

  return (
    <div className={`flex h-screen flex-col bg-gradient-to-br ${selectedTheme.shellClassName}`}>
      <header className="flex items-center justify-between border-b border-white/60 bg-white/60 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <span className="material-icons text-lg text-primary">shopping_bag</span>
          <h1 className="text-base font-semibold text-text-main">{title}</h1>
        </div>
        {rightAction ?? <div className="w-10" />}
      </header>
      {children}
    </div>
  );
}

function HomeRoute() {
  const {
    viewState,
    displayResults,
    noPriceCount,
    currentResponse,
    resetToEmpty,
    selectDetectedProduct,
    phaseText,
    savedLinks,
    addSavedLink,
  } = useSidepanelState();

  return (
    <Shell
      title="Personal Shopper"
      rightAction={(
        <Link
          to="/settings"
          aria-label="Settings"
          className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/75 text-text-main shadow-sm"
        >
          <span className="material-icons text-lg">tune</span>
        </Link>
      )}
    >
      {viewState.view === "empty" && (
        <main className="flex flex-1 items-center justify-center px-6">
          <div className="max-w-[280px] text-center">
            <span className="material-icons mb-3 block text-5xl text-gray-300">shopping_bag</span>
            <p className="text-sm text-text-muted">
              Click the extension icon or a product overlay to find better prices.
            </p>
          </div>
        </main>
      )}

      {viewState.view === "identifying" && (
        <main className="flex flex-1 items-center justify-center px-6">
          <div className="text-center">
            <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-white border-t-primary" />
            <p className="text-sm text-text-muted">Identifying products...</p>
          </div>
        </main>
      )}

      {viewState.view === "product_selection" && (
        <main className="flex-1 overflow-y-auto px-4 py-4">
          <section className="rounded-[28px] border border-white/70 bg-white/75 p-4 shadow-xl backdrop-blur-xl">
            <h2 className="text-lg font-semibold text-text-main">Multiple products found</h2>
            <p className="mt-1 text-sm text-text-muted">Choose the product you want to compare.</p>
            <div className="mt-4 max-h-[360px] space-y-2 overflow-y-auto pr-1">
              {viewState.products.map((product, index) => (
                <button
                  key={`${product.name}-${index}`}
                  type="button"
                  onClick={() => selectDetectedProduct(product, viewState.tabId, viewState.screenshotDataUrl, viewState.pageUrl)}
                  className="flex w-full items-center justify-between rounded-2xl border border-amber-100 bg-white/80 px-3 py-3 text-left shadow-sm transition hover:border-primary"
                >
                  <span className="truncate text-sm font-medium text-text-main">{product.name}</span>
                  <span className="ml-3 shrink-0 text-sm font-semibold text-primary">
                    {product.price === null ? "Select" : `${product.currency ?? "$"}${product.price.toFixed(2)}`}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </main>
      )}

      {viewState.view === "loading" && (
        <main className="flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            <ProductSection product={viewState.product} />
            <section className="rounded-[28px] border border-white/70 bg-white/75 px-4 py-8 text-center shadow-xl backdrop-blur-xl">
              <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-white border-t-primary" />
              <p className="text-sm text-text-muted">{phaseText(viewState.phase)}</p>
            </section>
          </div>
        </main>
      )}

      {viewState.view === "error" && (
        <main className="flex flex-1 items-center justify-center px-6">
          <div className="rounded-[28px] border border-white/70 bg-white/80 px-6 py-8 text-center shadow-xl backdrop-blur-xl">
            <span className="material-icons mb-3 block text-4xl text-gray-300">error_outline</span>
            <p className="text-sm text-text-main">{viewState.message}</p>
            <button
              type="button"
              onClick={resetToEmpty}
              className="mt-4 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white"
            >
              Try Again
            </button>
          </div>
        </main>
      )}

      {viewState.view === "results" && (
        <main className="flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            <ProductSection product={viewState.product} />
            <PriceBar productPrice={viewState.product.price} currency={viewState.product.currency} response={viewState.response} />
            <section className="rounded-[28px] border border-white/70 bg-white/75 p-4 shadow-xl backdrop-blur-xl">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-text-main">Top results</h2>
                <span className="text-xs text-text-muted">{displayResults.length} shown</span>
              </div>
              {displayResults.length === 0 ? (
                <p className="text-sm text-text-muted">No close matches found yet.</p>
              ) : (
                <div className="max-h-[260px] space-y-3 overflow-y-auto pr-1">
                  {displayResults.map((ranked) => (
                    <div key={ranked.result.id} className="flex items-center gap-2 rounded-2xl bg-white/80 px-2 py-1 shadow-sm">
                      <div className="min-w-0 flex-1">
                        <ResultCard ranked={ranked} />
                      </div>
                      <button
                        type="button"
                        aria-label={`Save ${ranked.result.title}`}
                        onClick={() => addSavedLink(ranked)}
                        className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${
                          savedLinks.some((link) => link.id === ranked.result.id)
                            ? "bg-orange-100 text-primary"
                            : "bg-white text-text-muted"
                        }`}
                      >
                        <span className="material-icons text-lg">
                          {savedLinks.some((link) => link.id === ranked.result.id) ? "bookmark" : "bookmark_add"}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            {noPriceCount > 0 && (
              <p className="text-center text-xs text-text-muted">
                {noPriceCount} result{noPriceCount === 1 ? "" : "s"} shown without price
              </p>
            )}
            {currentResponse && (
              <p className="text-center text-xs text-text-muted">
                Found {currentResponse.searchMeta.totalFound} results in {(currentResponse.searchMeta.searchDurationMs / 1000).toFixed(1)}s
              </p>
            )}
            <Link
              to="/chat"
              aria-label="Chat Now"
              className="inline-flex w-full items-center justify-center rounded-full bg-primary px-5 py-3 text-sm font-semibold text-white shadow-lg"
            >
              Chat Now
            </Link>
          </div>
        </main>
      )}
    </Shell>
  );
}

function ChatInput() {
  const {
    sendChatMessage, chatLoading, voiceStatus,
    isVoiceRecording, startVoice, pauseVoice, endVoiceSession,
  } = useSidepanelState();
  const [input, setInput] = useState("");

  const handleMicToggle = () => {
    if (voiceStatus === "connecting") return;
    if (isVoiceRecording) {
      pauseVoice();
    } else if (voiceStatus === "paused") {
      endVoiceSession();
    } else {
      void startVoice();
    }
  };

  return (
    <div className="border-t border-white/60 bg-white/70 px-4 py-3 backdrop-blur-xl">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              sendChatMessage(input);
              setInput("");
            }
          }}
          placeholder="Ask about these results..."
          className="flex-1 rounded-full border border-white/80 bg-white/90 px-4 py-2.5 text-sm text-text-main outline-none"
        />
        <button
          type="button"
          aria-label="Voice chat"
          onClick={handleMicToggle}
          disabled={voiceStatus === "connecting"}
          className={`inline-flex h-11 w-11 items-center justify-center rounded-full transition-colors disabled:opacity-60 ${
            isVoiceRecording
              ? "bg-red-500 text-white animate-pulse"
              : voiceStatus === "paused"
                ? "bg-orange-400 text-white"
                : "bg-white text-text-main shadow-sm"
          }`}
        >
          <span className="material-icons text-lg">
            {isVoiceRecording ? "pause" : voiceStatus === "paused" ? "stop" : "mic"}
          </span>
        </button>
        <button
          type="button"
          aria-label="Send message"
          disabled={chatLoading}
          onClick={() => {
            sendChatMessage(input);
            setInput("");
          }}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-primary text-white disabled:opacity-60"
        >
          <span className="material-icons text-lg">send</span>
        </button>
      </div>
    </div>
  );
}

function ChatRoute() {
  const {
    currentProduct, displayResults, chatMessages, chatLoading, sendChatMessage,
    isVoiceRecording, voiceStatus, voiceInputTranscript, voiceOutputTranscript,
  } = useSidepanelState();

  return (
    <Shell
      title="Shopping Assistant"
      rightAction={(
        <div className="flex items-center gap-2">
          <Link
            to="/"
            aria-label="Back Home"
            className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/75 text-text-main shadow-sm"
          >
            <span className="material-icons text-lg">arrow_back</span>
          </Link>
          <Link
            to="/settings"
            aria-label="Settings"
            className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/75 text-text-main shadow-sm"
          >
            <span className="material-icons text-lg">tune</span>
          </Link>
        </div>
      )}
    >
      <div className="flex h-full flex-col">
        <section className="border-b border-white/60 bg-white/55 px-4 py-4 backdrop-blur-xl">
          <div className="overflow-x-auto pb-1" data-testid="chat-results-strip">
            <div className="flex min-w-max gap-3">
              {currentProduct && (
                <div className="w-28 shrink-0 rounded-[24px] border border-white/70 bg-white/90 p-3 shadow-sm">
                  <div className="mb-2 h-16 rounded-2xl bg-gradient-to-br from-stone-200 to-stone-100">
                    {(currentProduct.imageUrl || currentProduct.displayImageDataUrl) && (
                      <img
                        src={currentProduct.imageUrl || currentProduct.displayImageDataUrl}
                        alt={currentProduct.name}
                        className="h-full w-full rounded-2xl object-cover"
                      />
                    )}
                  </div>
                  <p className="truncate text-xs font-medium text-text-main">{currentProduct.name}</p>
                  <p className="mt-1 text-xs text-text-muted">Original</p>
                </div>
              )}
              {displayResults.map((ranked) => (
                <div key={ranked.result.id} className="w-28 shrink-0 rounded-[24px] border border-white/70 bg-white/90 p-3 shadow-sm">
                  <div className="mb-2 h-16 rounded-2xl bg-gradient-to-br from-orange-100 to-amber-50">
                    {ranked.result.imageUrl && (
                      <img
                        src={ranked.result.imageUrl}
                        alt={ranked.result.title}
                        className="h-full w-full rounded-2xl object-cover"
                      />
                    )}
                  </div>
                  <p className="truncate text-xs font-medium text-text-main">{ranked.result.marketplace}</p>
                  <p className="mt-1 truncate text-xs text-text-muted">
                    {ranked.result.price === null ? "See price" : new Intl.NumberFormat(undefined, {
                      style: "currency",
                      currency: ranked.result.currency ?? "USD",
                    }).format(ranked.result.price)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
        <div className="min-h-0 flex-1">
          <ChatThread
            messages={chatMessages}
            onSendMessage={sendChatMessage}
            isLoading={chatLoading}
            showComposer={false}
            isVoiceRecording={isVoiceRecording}
            voiceStatus={voiceStatus}
            voiceInputTranscript={voiceInputTranscript}
            voiceOutputTranscript={voiceOutputTranscript}
          />
        </div>
        <ChatInput />
      </div>
    </Shell>
  );
}

function SettingsRoute() {
  const { availableThemes, savedLinks, selectedTheme, setSelectedThemeId, removeSavedLink } = useSidepanelState();

  return (
    <Shell
      title="Settings"
      rightAction={(
        <Link
          to="/"
          aria-label="Back Home"
          className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white/75 text-text-main shadow-sm"
        >
          <span className="material-icons text-lg">arrow_back</span>
        </Link>
      )}
    >
      <main className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          <section className="rounded-[28px] border border-white/70 bg-white/75 p-4 shadow-xl backdrop-blur-xl">
            <h2 className="text-lg font-semibold text-text-main">Themes</h2>
            <div className="mt-3 space-y-2">
              {availableThemes.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => setSelectedThemeId(theme.id)}
                  aria-label={`Theme ${theme.label}`}
                  aria-pressed={theme.id === selectedTheme.id}
                  className={`flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left ${
                    theme.id === selectedTheme.id ? "bg-orange-100" : "bg-white/80"
                  }`}
                >
                  <span className="text-sm font-medium text-text-main">{theme.label}</span>
                  <span className={`h-8 w-16 rounded-full bg-gradient-to-r ${theme.accentClassName}`} />
                </button>
              ))}
            </div>
          </section>
          <section className="rounded-[28px] border border-white/70 bg-white/75 p-4 shadow-xl backdrop-blur-xl">
            <h2 className="text-lg font-semibold text-text-main">Saved links</h2>
            {savedLinks.length === 0 ? (
              <p className="mt-3 text-sm text-text-muted">No saved links yet.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {savedLinks.map((link) => (
                  <div key={link.id} className="flex items-center justify-between rounded-2xl bg-white/80 px-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-text-main">{link.name}</p>
                      <p className="text-xs text-text-muted">{link.marketplace}</p>
                    </div>
                    <div className="ml-4 flex items-center gap-3">
                      <span className="text-sm font-semibold text-primary">{link.priceLabel}</span>
                      <button
                        type="button"
                        onClick={() => removeSavedLink(link.id)}
                        aria-label={`Remove ${link.name}`}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-red-50 text-red-500"
                      >
                        <span className="material-icons text-base">delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>
    </Shell>
  );
}

export function SidepanelRoutes({ initialPath = "/" }: { initialPath?: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/chat" element={<ChatRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
      </Routes>
    </MemoryRouter>
  );
}
