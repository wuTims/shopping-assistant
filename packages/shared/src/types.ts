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

export interface IdentifyRequest {
  screenshot: string; // base64 PNG from captureVisibleTab
  pageUrl: string;
}

export interface IdentifiedProduct {
  name: string;
  price: number | null;
  currency: string | null;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  imageRegion: string | null; // base64 cropped image of the product
}

export interface IdentifyResponse {
  products: IdentifiedProduct[];
  pageType: "product_detail" | "product_listing" | "unknown";
}

export interface SearchRequest {
  imageUrl: string | null;
  imageBase64: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  sourceUrl: string;
  /** Pre-computed identification from /identify — skips redundant Gemini call in /search */
  identification?: ProductIdentification | null;
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
  source: "gemini_grounding" | "brave" | "aliexpress";
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
  priceAvailable: boolean;
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
  response: SearchResponse;
  cachedAt: number;
}

// === Extension Display Types ===

/** Minimal product info for UI display across extension contexts */
export interface ProductDisplayInfo {
  name: string;
  price: number | null;
  currency: string | null;
  imageUrl?: string;
  /** Base64 data URL for UI display only — never sent to backend as imageUrl */
  displayImageDataUrl?: string;
  marketplace?: string;
}

/** Flexible product context for chat — accepts both DetectedProduct and ProductDisplayInfo shapes */
export interface ChatProductContext {
  title?: string | null;
  name?: string | null;
  price: number | null;
  currency: string | null;
  marketplace?: string | null;
  imageUrl?: string | null;
}

/** Service Worker → Side Panel messages */
export type BackgroundToSidePanelMessage =
  | { target: "sidepanel"; type: "identifying" }
  | { target: "sidepanel"; type: "product_selection"; products: IdentifiedProduct[]; screenshotDataUrl: string; pageUrl: string; tabId: number }
  | { target: "sidepanel"; type: "searching"; product: ProductDisplayInfo }
  | { target: "sidepanel"; type: "results"; product: ProductDisplayInfo; response: SearchResponse }
  | { target: "sidepanel"; type: "error"; product: ProductDisplayInfo | null; message: string }
  | { target: "sidepanel"; type: "chat_response"; reply: string }
  | { target: "sidepanel"; type: "chat_error"; error: string };

/** Side Panel → Service Worker messages */
export type SidePanelToBackgroundMessage =
  | { type: "select_product"; tabId: number; product: IdentifiedProduct; screenshotDataUrl: string; pageUrl: string }
  | { type: "GET_STATE" }
  | { type: "CHAT_REQUEST"; request: ChatRequest; tabId?: number };

// === Chat ===

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  inputMode: "text" | "voice";
  timestamp: number;
  context: {
    currentProduct: ChatProductContext | null;
    searchResults: RankedResult[] | null;
  } | null;
}

// === API Contracts ===

export interface ChatRequest {
  message: string;
  context: {
    product: ChatProductContext | null;
    results: RankedResult[] | null;
  };
  history: ChatMessage[];
}

export interface ChatResponse {
  reply: string;
}

// === WebSocket Messages ===

export type WsClientMessage =
  | { type: "config"; context: Record<string, unknown> }
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 16000; data: string }
  | { type: "text"; content: string };

export type WsServerMessage =
  | { type: "audio"; encoding: "pcm_s16le"; sampleRateHz: 24000; data: string }
  | { type: "transcript"; content: string }
  | { type: "turn_complete" };
