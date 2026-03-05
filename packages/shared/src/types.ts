// === Detection ===

/** Plain serializable rect — do NOT use DOMRect (not structured-clone safe across extension contexts). */
export interface SerializableRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DetectedProduct {
  id: string;
  imageUrl: string;
  title: string | null;
  price: number | null;
  currency: string | null;
  pageUrl: string;
  marketplace: string | null;
  schemaData: Record<string, unknown> | null;
  boundingRect: SerializableRect;
  detectedAt: number;
}

// === Search Request/Response ===

export interface SearchRequest {
  imageUrl: string;
  imageBase64: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  sourceUrl: string;
}

export interface ProductIdentification {
  category: string;
  description: string;
  brand: string | null;
  attributes: {
    color: string | null;
    material: string | null;
    style: string | null;
    size: string | null;
    [key: string]: string | null;
  };
  searchQueries: string[];
  estimatedPriceRange: {
    low: number;
    high: number;
    currency: string;
  } | null;
}

export interface SearchResult {
  id: string;
  source: "gemini_grounding" | "brave";
  title: string;
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string;
  marketplace: string;
  snippet: string | null;
  structuredData: {
    brand: string | null;
    availability: string | null;
    rating: number | null;
    reviewCount: number | null;
  } | null;
  raw: Record<string, unknown>;
}

export interface RankedResult {
  result: SearchResult;
  confidence: "high" | "medium" | "low";
  confidenceScore: number;
  priceDelta: number | null;
  savingsPercent: number | null;
  comparisonNotes: string;
  rank: number;
}

export interface SearchResponse {
  requestId: string;
  originalProduct: {
    title: string | null;
    price: number | null;
    currency: string | null;
    imageUrl: string;
    identification: ProductIdentification;
  };
  results: RankedResult[];
  searchMeta: {
    totalFound: number;
    braveResultCount: number;
    groundingResultCount: number;
    sourceStatus: {
      brave: "ok" | "timeout" | "error";
      grounding: "ok" | "timeout" | "error";
    };
    sourceDiagnostics: {
      brave: {
        totalQueries: number;
        successfulQueries: number;
        failedQueries: number;
        timedOutQueries: number;
      };
      grounding: {
        totalQueries: number;
        successfulQueries: number;
        failedQueries: number;
        timedOutQueries: number;
      };
    };
    searchDurationMs: number;
    rankingDurationMs: number;
    rankingStatus: "ok" | "fallback";
    rankingFailureReason: string | null;
  };
}

// === Cache ===

export interface CachedSearch {
  productId: string;
  response: SearchResponse;
  cachedAt: number;
  lastAccessedAt: number;
  ttl: number;
}

// === Chat ===

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  inputMode: "text" | "voice";
  timestamp: number;
  context: {
    currentProduct: DetectedProduct | null;
    searchResults: RankedResult[] | null;
  } | null;
}

// === API Contracts ===

export interface ChatRequest {
  message: string;
  context: {
    product: DetectedProduct | null;
    results: RankedResult[] | null;
  };
  history: ChatMessage[];
}

export interface ChatResponse {
  reply: string;
}

// === Extension Internal Messages ===

/** Content Script → Service Worker */
export type ContentToBackgroundMessage =
  | { type: "PRODUCT_CLICKED"; product: DetectedProduct }
  | { type: "PRODUCTS_DETECTED"; products: DetectedProduct[] };

/** Service Worker → Side Panel */
export type BackgroundToSidePanelMessage =
  | { type: "SEARCH_STARTED"; product: DetectedProduct }
  | { type: "SEARCH_COMPLETE"; product: DetectedProduct; response: SearchResponse }
  | { type: "SEARCH_ERROR"; product: DetectedProduct; error: string }
  | { type: "CHAT_RESPONSE"; reply: string }
  | { type: "CHAT_ERROR"; error: string };

/** Side Panel → Service Worker */
export type SidePanelToBackgroundMessage =
  | { type: "GET_STATE" }
  | { type: "CHAT_REQUEST"; request: ChatRequest }
  | { type: "GET_BACKEND_URL" };

/** Service Worker → Side Panel: response to GET_STATE */
export interface PanelState {
  view: "empty" | "loading" | "results" | "error";
  product: DetectedProduct | null;
  response: SearchResponse | null;
  error: string | null;
  loadingPhase: 1 | 2 | 3 | null;
}

/** Union of all extension messages (for runtime type narrowing) */
export type ExtensionMessage =
  | ContentToBackgroundMessage
  | BackgroundToSidePanelMessage
  | SidePanelToBackgroundMessage;

// === WebSocket Messages ===

export type WsClientMessage =
  | { type: "config"; context: Record<string, unknown> }
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 16000; data: string }
  | { type: "text"; content: string };

export type WsServerMessage =
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 24000; data: string }
  | { type: "transcript"; content: string }
  | { type: "turn_complete" };
