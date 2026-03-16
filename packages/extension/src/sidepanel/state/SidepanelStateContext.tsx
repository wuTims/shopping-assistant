import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  BackgroundToSidePanelMessage,
  ChatMessage,
  ChatRequest,
  IdentifiedProduct,
  ProductDisplayInfo,
  RankedResult,
  SearchResponse,
} from "@shopping-assistant/shared";
import { loadSidepanelSettings, saveSidepanelSettings } from "./settings-storage";
import { useVoice } from "../hooks/useVoice";
import type { VoiceStatus } from "../hooks/useVoice";

export type ViewState =
  | { view: "empty" }
  | { view: "identifying" }
  | { view: "product_selection"; products: IdentifiedProduct[]; screenshotDataUrl: string; pageUrl: string; tabId: number }
  | { view: "loading"; product: ProductDisplayInfo; phase: 1 | 2 | 3 }
  | { view: "results"; product: ProductDisplayInfo; response: SearchResponse }
  | { view: "error"; product: ProductDisplayInfo | null; message: string };

export interface SavedLink {
  id: string;
  name: string;
  marketplace: string;
  priceLabel: string;
  imageUrl: string | null;
  productUrl: string;
}

export interface ThemeOption {
  id: string;
  label: string;
  shellClassName: string;
  accentClassName: string;
}

export interface SidepanelInitialState {
  view: ViewState["view"];
  product?: ProductDisplayInfo;
  response?: SearchResponse;
  message?: string;
  products?: IdentifiedProduct[];
  screenshotDataUrl?: string;
  pageUrl?: string;
  tabId?: number;
  savedLinks?: SavedLink[];
  chatMessages?: ChatMessage[];
  chatLoading?: boolean;
  selectedThemeId?: string;
}

interface RuntimeBridge {
  sendMessage: (message: unknown, callback?: (response: BackgroundToSidePanelMessage | null) => void) => void;
  onMessage: {
    addListener: (listener: (message: Record<string, unknown>) => void) => void;
    removeListener: (listener: (message: Record<string, unknown>) => void) => void;
  };
}

interface SidepanelStateValue {
  viewState: ViewState;
  displayResults: RankedResult[];
  noPriceCount: number;
  chatMessages: ChatMessage[];
  chatLoading: boolean;
  priceBarCollapsed: boolean;
  savedLinks: SavedLink[];
  selectedTheme: ThemeOption;
  availableThemes: ThemeOption[];
  currentProduct: ProductDisplayInfo | null;
  currentResponse: SearchResponse | null;
  phaseText: (phase: 1 | 2 | 3) => string;
  resetToEmpty: () => void;
  selectDetectedProduct: (product: IdentifiedProduct, tabId: number, screenshotDataUrl: string, pageUrl: string) => void;
  sendChatMessage: (text: string) => void;
  voiceStatus: VoiceStatus;
  isVoiceRecording: boolean;
  voiceInputTranscript: string;
  voiceOutputTranscript: string;
  voiceError: string | null;
  startVoice: () => Promise<void>;
  pauseVoice: () => void;
  endVoiceSession: () => void;
  setPriceBarCollapsed: (collapsed: boolean) => void;
  addSavedLink: (ranked: RankedResult) => void;
  removeSavedLink: (id: string) => void;
  setSelectedThemeId: (id: string) => void;
}

const themes: ThemeOption[] = [
  {
    id: "warm-amber",
    label: "Warm Amber",
    shellClassName: "from-orange-100 via-amber-50 to-stone-50",
    accentClassName: "from-orange-500 to-amber-600",
  },
  {
    id: "sage-gold",
    label: "Sage & Gold",
    shellClassName: "from-emerald-100 via-teal-50 to-amber-50",
    accentClassName: "from-emerald-500 to-teal-600",
  },
  {
    id: "cognac-cream",
    label: "Cognac & Cream",
    shellClassName: "from-orange-200 via-amber-100 to-yellow-50",
    accentClassName: "from-orange-700 to-amber-700",
  },
];

const defaultTheme = themes[0];
const SidepanelStateContext = createContext<SidepanelStateValue | null>(null);

// Keep in sync with packages/extension/src/background/index.ts:12
const BACKEND_WS_URL = "http://localhost:8080".replace(/^http/, "ws");

function toPriceLabel(price: number | null, currency: string | null) {
  if (price === null) return "See price";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency ?? "USD",
  }).format(price);
}

function normalizeInitialViewState(initialState?: SidepanelInitialState): ViewState {
  if (!initialState) return { view: "empty" };

  switch (initialState.view) {
    case "results":
      if (initialState.product && initialState.response) {
        return {
          view: "results",
          product: initialState.product,
          response: initialState.response,
        };
      }
      return { view: "empty" };
    case "loading":
      if (initialState.product) {
        return { view: "loading", product: initialState.product, phase: 1 };
      }
      return { view: "empty" };
    case "product_selection":
      if (
        initialState.products &&
        initialState.screenshotDataUrl &&
        initialState.pageUrl &&
        typeof initialState.tabId === "number"
      ) {
        return {
          view: "product_selection",
          products: initialState.products,
          screenshotDataUrl: initialState.screenshotDataUrl,
          pageUrl: initialState.pageUrl,
          tabId: initialState.tabId,
        };
      }
      return { view: "empty" };
    case "error":
      return {
        view: "error",
        product: initialState.product ?? null,
        message: initialState.message ?? "Something went wrong.",
      };
    case "identifying":
      return { view: "identifying" };
    case "empty":
    default:
      return { view: "empty" };
  }
}

function getRuntime(): RuntimeBridge | null {
  if (typeof chrome === "undefined" || !chrome.runtime) {
    return null;
  }
  return chrome.runtime;
}

export function SidepanelStateProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState?: SidepanelInitialState;
}) {
  const [viewState, setViewState] = useState<ViewState>(() => normalizeInitialViewState(initialState));
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(initialState?.chatMessages ?? []);
  const [chatLoading, setChatLoading] = useState(initialState?.chatLoading ?? false);
  const [priceBarCollapsed, setPriceBarCollapsed] = useState(false);
  const [savedLinks, setSavedLinks] = useState<SavedLink[]>(initialState?.savedLinks ?? []);
  const [selectedThemeId, setSelectedThemeId] = useState(initialState?.selectedThemeId ?? defaultTheme.id);
  const settingsHydratedRef = useRef(false);
  const phaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const currentTabIdRef = useRef<number | null>(initialState?.tabId ?? null);

  const clearPhaseTimers = useCallback(() => {
    phaseTimersRef.current.forEach(clearTimeout);
    phaseTimersRef.current = [];
  }, []);

  const startPhaseTimers = useCallback(() => {
    clearPhaseTimers();
    phaseTimersRef.current = [
      setTimeout(() => setViewState((state) => (state.view === "loading" ? { ...state, phase: 2 } : state)), 2000),
      setTimeout(() => setViewState((state) => (state.view === "loading" ? { ...state, phase: 3 } : state)), 5000),
    ];
  }, [clearPhaseTimers]);

  const handleMessage = useCallback((message: BackgroundToSidePanelMessage) => {
    switch (message.type) {
      case "empty":
        clearPhaseTimers();
        setViewState({ view: "empty" });
        setChatMessages([]);
        setChatLoading(false);
        setPriceBarCollapsed(false);
        break;
      case "identifying":
        clearPhaseTimers();
        setViewState({ view: "identifying" });
        setChatMessages([]);
        setChatLoading(false);
        setPriceBarCollapsed(false);
        break;
      case "product_selection":
        clearPhaseTimers();
        setViewState({
          view: "product_selection",
          products: message.products,
          screenshotDataUrl: message.screenshotDataUrl,
          pageUrl: message.pageUrl,
          tabId: message.tabId,
        });
        setChatMessages([]);
        setChatLoading(false);
        break;
      case "searching":
        setViewState({ view: "loading", product: message.product, phase: 1 });
        setChatMessages([]);
        setChatLoading(false);
        setPriceBarCollapsed(false);
        startPhaseTimers();
        break;
      case "results":
        clearPhaseTimers();
        setViewState({ view: "results", product: message.product, response: message.response });
        break;
      case "error":
        clearPhaseTimers();
        setViewState({ view: "error", product: message.product, message: message.message });
        break;
      case "chat_response":
        setChatLoading(false);
        setChatMessages((messages) => [
          ...messages,
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
        setChatMessages((messages) => [
          ...messages,
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
  }, [clearPhaseTimers, startPhaseTimers]);

  useEffect(() => {
    let cancelled = false;

    void loadSidepanelSettings().then((settings) => {
      if (cancelled) return;
      if (settings.selectedThemeId) {
        setSelectedThemeId(settings.selectedThemeId);
      }
      if (settings.savedLinks) {
        setSavedLinks(settings.savedLinks);
      }
      settingsHydratedRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    void saveSidepanelSettings({
      selectedThemeId,
      savedLinks,
    });
  }, [savedLinks, selectedThemeId]);

  useEffect(() => {
    if (initialState) return;

    const runtime = getRuntime();
    if (!runtime) return;

    runtime.sendMessage(
      { type: "GET_STATE", tabId: currentTabIdRef.current },
      (response: BackgroundToSidePanelMessage | null) => {
        if (chrome.runtime.lastError || !response) return;
        handleMessage(response);
      },
    );

    const listener = (message: Record<string, unknown>) => {
      if (message.target !== "sidepanel") return;
      if (typeof message.tabId === "number") {
        currentTabIdRef.current = message.tabId;
      }
      handleMessage(message as BackgroundToSidePanelMessage);
    };

    runtime.onMessage.addListener(listener);
    return () => {
      runtime.onMessage.removeListener(listener);
      clearPhaseTimers();
    };
  }, [clearPhaseTimers, handleMessage, initialState]);

  const resetToEmpty = useCallback(() => {
    clearPhaseTimers();
    setViewState({ view: "empty" });
    setChatMessages([]);
    setChatLoading(false);
    setPriceBarCollapsed(false);
  }, [clearPhaseTimers]);

  const selectDetectedProduct = useCallback((
    product: IdentifiedProduct,
    tabId: number,
    screenshotDataUrl: string,
    pageUrl: string,
  ) => {
    const runtime = getRuntime();
    runtime?.sendMessage({
      type: "select_product",
      tabId,
      product,
      screenshotDataUrl,
      pageUrl,
    });
    setViewState({
      view: "loading",
      product: {
        name: product.name,
        price: product.price,
        currency: product.currency,
      },
      phase: 1,
    });
    startPhaseTimers();
  }, [startPhaseTimers]);

  const sendChatMessage = useCallback((text: string) => {
    if (viewState.view !== "results") return;

    const trimmed = text.trim();
    if (!trimmed) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      inputMode: "text",
      timestamp: Date.now(),
      context: chatMessages.length === 0 ? {
        currentProduct: viewState.product,
        searchResults: viewState.response.results,
      } : null,
    };

    setChatMessages((messages) => [...messages, userMessage]);
    setChatLoading(true);
    setPriceBarCollapsed(true);

    const request: ChatRequest = {
      message: trimmed,
      context: {
        product: viewState.product,
        results: viewState.response.results,
      },
      history: chatMessages,
    };

    getRuntime()?.sendMessage({ type: "CHAT_REQUEST", request, tabId: currentTabIdRef.current });
  }, [chatMessages, viewState]);

  const addSavedLink = useCallback((ranked: RankedResult) => {
    setSavedLinks((links) => {
      if (links.some((link) => link.id === ranked.result.id)) {
        return links;
      }
      return [
        ...links,
        {
          id: ranked.result.id,
          name: ranked.result.title,
          marketplace: ranked.result.marketplace,
          priceLabel: toPriceLabel(ranked.result.price, ranked.result.currency),
          imageUrl: ranked.result.imageUrl,
          productUrl: ranked.result.productUrl,
        },
      ];
    });
  }, []);

  const removeSavedLink = useCallback((id: string) => {
    setSavedLinks((links) => links.filter((link) => link.id !== id));
  }, []);

  const displayResults = viewState.view === "results" ? viewState.response.results : [];
  const noPriceCount = viewState.view === "results"
    ? viewState.response.results.filter((result) => !result.priceAvailable).length
    : 0;
  const selectedTheme = themes.find((theme) => theme.id === selectedThemeId) ?? defaultTheme;
  const currentProduct =
    viewState.view === "results" || viewState.view === "loading" || viewState.view === "error"
      ? viewState.product
      : null;
  const currentResponse = viewState.view === "results" ? viewState.response : null;

  const voiceContext = useMemo(() => ({
    product: currentProduct ? {
      name: currentProduct.name,
      price: currentProduct.price,
      currency: currentProduct.currency,
      marketplace: currentProduct.marketplace,
    } : null,
    results: displayResults.slice(0, 5).map((r) => ({
      title: r.result.title,
      price: r.result.price,
      marketplace: r.result.marketplace,
    })),
  }), [currentProduct, displayResults]);

  const voice = useVoice({ backendUrl: BACKEND_WS_URL, context: voiceContext });

  useEffect(() => {
    if (viewState.view !== "results") {
      voice.endSession();
    }
  }, [viewState.view, voice.endSession]);

  const value = useMemo<SidepanelStateValue>(() => ({
    viewState,
    displayResults,
    noPriceCount,
    chatMessages,
    chatLoading,
    priceBarCollapsed,
    savedLinks,
    selectedTheme,
    availableThemes: themes,
    currentProduct,
    currentResponse,
    phaseText: (phase: 1 | 2 | 3) => {
      switch (phase) {
        case 1:
          return "Identifying product...";
        case 2:
          return "Searching across marketplaces...";
        case 3:
          return "Comparing results...";
      }
    },
    resetToEmpty,
    selectDetectedProduct,
    sendChatMessage,
    setPriceBarCollapsed,
    addSavedLink,
    removeSavedLink,
    setSelectedThemeId,
    voiceStatus: voice.status,
    isVoiceRecording: voice.isRecording,
    voiceInputTranscript: voice.inputTranscript,
    voiceOutputTranscript: voice.outputTranscript,
    voiceError: voice.error,
    startVoice: voice.start,
    pauseVoice: voice.pauseMic,
    endVoiceSession: voice.endSession,
  }), [
    addSavedLink,
    chatLoading,
    chatMessages,
    currentProduct,
    currentResponse,
    displayResults,
    noPriceCount,
    priceBarCollapsed,
    removeSavedLink,
    resetToEmpty,
    savedLinks,
    selectDetectedProduct,
    selectedTheme,
    sendChatMessage,
    viewState,
    voice.status,
    voice.isRecording,
    voice.inputTranscript,
    voice.outputTranscript,
    voice.error,
    voice.start,
    voice.pauseMic,
    voice.endSession,
  ]);

  return (
    <SidepanelStateContext.Provider value={value}>
      {children}
    </SidepanelStateContext.Provider>
  );
}

export function useSidepanelState() {
  const context = useContext(SidepanelStateContext);
  if (!context) {
    throw new Error("useSidepanelState must be used within SidepanelStateProvider");
  }
  return context;
}
