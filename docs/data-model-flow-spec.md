# Shopping Source Discovery Agent — Data Model & Data Flow

## Data Objects

### DetectedProduct

Extracted from the page DOM by the content script. This is the lightweight representation of a product before any API calls are made.

```typescript
interface DetectedProduct {
  id: string;                    // Generated hash of imageUrl + pageUrl
  imageUrl: string;              // Primary product image src
  title: string | null;          // From DOM text near image, og:title, or schema
  price: number | null;          // Parsed from DOM price patterns
  currency: string | null;       // USD, EUR, etc. — parsed or inferred from locale
  pageUrl: string;               // Current page URL
  marketplace: string | null;    // Detected source site (e.g., "amazon.com", "target.com")
  schemaData: object | null;     // Raw schema.org/JSON-LD if present
  boundingRect: DOMRect;         // Position of product image element for overlay placement
  detectedAt: number;            // Timestamp (ms) for cache TTL
}
```

**Source:** Content script DOM parsing
**Lifetime:** Exists in content script memory while page is loaded. Sent to service worker on user click.

---

### SearchRequest

Sent from the service worker to Cloud Run when the user clicks a product overlay.

```typescript
interface SearchRequest {
  imageUrl: string;              // Product image URL (public, fetchable by backend)
  imageBase64: string | null;    // Fallback: base64-encoded image if backend cannot fetch imageUrl
  title: string | null;          // DOM-extracted title if available
  price: number | null;          // DOM-extracted price if available
  currency: string | null;
  sourceUrl: string;             // Page URL for context
}
```

**Source:** Service worker, constructed from DetectedProduct
**Destination:** Cloud Run POST /search

**Image handling rule:** Service worker sends `imageUrl` by default. If the backend cannot fetch the image (blocked/hotlink-protected/private CDN), the extension retries with `imageBase64` from the rendered image bytes when available.

---

### ProductIdentification

Gemini Flash's structured analysis of the product image. This drives both search queries and ranking context.

```typescript
interface ProductIdentification {
  category: string;              // e.g., "crossbody bag", "wireless earbuds", "desk lamp"
  description: string;           // Natural language description for search queries
  brand: string | null;          // Detected brand if visible
  attributes: {
    color: string | null;
    material: string | null;
    style: string | null;
    size: string | null;
    [key: string]: string | null; // Additional category-specific attributes
  };
  searchQueries: string[];       // 2-3 generated search query strings optimized for marketplaces
  estimatedPriceRange: {         // Gemini's estimate of typical price range
    low: number;
    high: number;
    currency: string;
  } | null;
}
```

**Source:** Gemini Flash multimodal analysis
**Lifetime:** Exists in Cloud Run request scope. Passed to search and ranking steps.

---

### SearchResult

A single product result from either search source, normalized to a common shape.

```typescript
interface SearchResult {
  id: string;                    // Generated hash for deduplication
  source: "gemini_grounding" | "brave";
  title: string;
  price: number | null;
  currency: string | null;
  imageUrl: string | null;
  productUrl: string;
  marketplace: string;           // Parsed from productUrl domain (e.g., "aliexpress", "ebay", "temu")
  snippet: string | null;        // Description text or snippet from search
  structuredData: {              // Available primarily from Brave JSON-LD extraction
    brand: string | null;
    availability: string | null;
    rating: number | null;
    reviewCount: number | null;
  } | null;
  raw: object;                   // Original response data for debugging
}
```

**Source:** Brave LLM Context API or Gemini Grounding, normalized by backend
**Lifetime:** Request scope in Cloud Run, then cached in extension

---

### RankedResult

A SearchResult enriched with Gemini's visual comparison scoring.

```typescript
interface RankedResult {
  result: SearchResult;
  confidence: "high" | "medium" | "low";
  confidenceScore: number;       // 0.0 - 1.0
  priceDelta: number | null;     // Negative = cheaper, positive = more expensive
  savingsPercent: number | null;  // e.g., 39 for "39% less"
  comparisonNotes: string;       // Gemini's brief explanation ("same design, different hardware finish")
  rank: number;                  // Final display order (1 = best match)
}
```

**Source:** Gemini Flash visual comparison step
**Destination:** Returned to extension for display

---

### SearchResponse

The complete response sent back to the extension.

```typescript
interface SearchResponse {
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
    totalFound: number;          // Pre-ranking count across both sources
    braveResultCount: number;
    groundingResultCount: number;
    sourceStatus: {
      brave: "ok" | "timeout" | "error";
      grounding: "ok" | "timeout" | "error";
    };
    searchDurationMs: number;
    rankingDurationMs: number;
  };
}
```

**Source:** Cloud Run
**Destination:** Service worker → side panel display + chrome.storage.local cache

---

### CachedSearch

Stored in `chrome.storage.local` keyed by DetectedProduct.id.

```typescript
interface CachedSearch {
  productId: string;             // DetectedProduct.id (hash of imageUrl + pageUrl)
  response: SearchResponse;
  cachedAt: number;              // Timestamp (ms)
  ttl: number;                   // Time-to-live in ms (default: 1 hour)
}
```

**Cache strategy:** Check cache before making API call. If `Date.now() - cachedAt > ttl`, treat as miss. On extension startup, clear entries older than session threshold (e.g., 4 hours). Maximum cache size: 50 entries (LRU eviction).

---

### ChatMessage

Messages in the side panel chat, used for both text and voice interactions.

```typescript
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;               // Text content (transcribed for voice messages)
  inputMode: "text" | "voice";
  timestamp: number;
  context: {                     // Injected context for assistant awareness
    currentProduct: DetectedProduct | null;
    searchResults: RankedResult[] | null;
  } | null;                      // Only set on first message or context change
}
```

**Source:** Side panel UI (text input or voice transcription via Live API)
**Lifetime:** In-memory in side panel. Not persisted across sessions.

---

## Data Flow

### Flow 1: Page Load — Product Detection

```
User navigates to shopping page
         │
         ▼
┌─────────────────────────────┐
│ Content Script: DOM Parsing │
│                             │
│ 1. Check for schema.org     │
│    Product / JSON-LD markup │
│ 2. Check og:product meta    │
│ 3. Scan for price patterns  │
│    near <img> elements      │
│ 4. Build DetectedProduct[]  │
└─────────────────────────────┘
         │
         ▼ (for each detected product)
┌─────────────────────────────┐
│ Content Script: Inject UI   │
│                             │
│ 1. Create overlay icon      │
│    positioned on product    │
│    image (absolute, z-index)│
│ 2. Bind click handler       │
│ 3. Send detection count to  │
│    service worker           │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Service Worker: Register    │
│                             │
│ 1. Store DetectedProduct[]  │
│    in memory                │
│ 2. Update extension badge   │
│    with product count       │
└─────────────────────────────┘
```

**Latency target:** < 200ms from page load to overlays visible
**API calls:** 0

---

### Flow 2: User Click — Product Search

```
User clicks overlay icon on product image
         │
         ▼
┌─────────────────────────────┐
│ Content Script → SW         │
│                             │
│ Send DetectedProduct to     │
│ service worker via message  │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Service Worker: Cache Check │
│                             │
│ 1. Hash(imageUrl + pageUrl) │
│ 2. Check chrome.storage     │
│    .local for CachedSearch  │
│ 3. If hit + valid TTL:      │
│    → skip to display        │
│ 4. If miss:                 │
│    → proceed to search      │
└─────────────────────────────┘
         │ (cache miss)
         ▼
┌─────────────────────────────┐
│ SW → Cloud Run: POST /search│
│                             │
│ Send SearchRequest          │
│ Open side panel with        │
│ loading state               │
└─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Cloud Run: Identification Step                   │
│                                                  │
│ Gemini Flash: analyze product image              │
│ Input:  SearchRequest.imageUrl + title context   │
│ Output: ProductIdentification                    │
│                                                  │
│ Estimated latency: 1-3s                          │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Cloud Run: Parallel Search Step                  │
│                                                  │
│ ┌──────────────────┐  ┌───────────────────────┐  │
│ │ Gemini Grounding │  │ Brave LLM Context API │  │
│ │                  │  │                       │  │
│ │ Prompt Gemini w/ │  │ Send 2-3 search       │  │
│ │ google_search    │  │ queries derived from  │  │
│ │ tool enabled,    │  │ ProductIdentification │  │
│ │ targeting        │  │                       │  │
│ │ AliExpress,      │  │ Returns structured    │  │
│ │ Temu, DHgate,    │  │ product data from     │  │
│ │ eBay             │  │ JSON-LD schemas       │  │
│ │                  │  │                       │  │
│ │ Returns:         │  │ Returns:              │  │
│ │ groundingChunks  │  │ Smart chunks with     │  │
│ │ + synthesized    │  │ extracted fields      │  │
│ │ text             │  │ (title, price, img)   │  │
│ └──────────────────┘  └───────────────────────┘  │
│         │                       │                │
│         └───────────┬───────────┘                │
│                     ▼                            │
│         ┌───────────────────┐                    │
│         │ Merge + Dedup     │                    │
│         │                   │                    │
│         │ 1. Normalize both │                    │
│         │    → SearchResult │                    │
│         │ 2. Dedup by URL   │                    │
│         │    or title sim.  │                    │
│         └───────────────────┘                    │
│                                                  │
│ Estimated latency: 1-3s (parallel)               │
└──────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────┐
│ Cloud Run: Ranking Step                          │
│                                                  │
│ Gemini Flash: visual comparison                  │
│ Input:  Original product image +                 │
│         each SearchResult image                  │
│ Output: confidence score, comparison notes,      │
│         price delta for each result              │
│                                                  │
│ Filter: Drop results below confidence threshold  │
│ Sort:   By confidence desc, then savings desc    │
│                                                  │
│ Estimated latency: 1-2s                          │
└──────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Cloud Run → SW: Response    │
│                             │
│ Return SearchResponse       │
│ (ranked results + metadata) │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Service Worker              │
│                             │
│ 1. Cache response in        │
│    chrome.storage.local     │
│ 2. Forward to side panel    │
│    for display              │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Side Panel: Display Results │
│                             │
│ 1. Show original product    │
│    with price context       │
│ 2. Render RankedResult[]    │
│    as product cards         │
│ 3. Enable chat interface    │
│    with product context     │
└─────────────────────────────┘
```

**Total latency target:** < 10 seconds end-to-end
**Deadline behavior:** If one search source times out, return partial ranked results plus `searchMeta.sourceStatus`.
**API calls per search:** 3-5 Gemini calls + 1-3 Brave calls

---

### Flow 3: Chat Interaction (Text)

```
User types message in side panel chat input
         │
         ▼
┌─────────────────────────────┐
│ Side Panel → Cloud Run      │
│                             │
│ POST /chat                  │
│ Body: {                     │
│   message: string,          │
│   context: {                │
│     product: original,      │
│     results: ranked[]       │
│   },                        │
│   history: ChatMessage[]    │
│ }                           │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Cloud Run: Gemini Flash     │
│                             │
│ generateContent with        │
│ system prompt including     │
│ product + results context   │
│                             │
│ Returns: text response      │
└─────────────────────────────┘
         │
         ▼
┌─────────────────────────────┐
│ Side Panel: Display         │
│                             │
│ Append assistant message    │
│ to chat thread              │
└─────────────────────────────┘
```

---

### Flow 4: Chat Interaction (Voice)

```
User presses microphone button in side panel
         │
         ▼
┌─────────────────────────────────────────┐
│ Side Panel: WebSocket Connection        │
│                                         │
│ 1. Connect to Cloud Run WS endpoint    │
│    wss://backend/live                   │
│ 2. Send session config:                │
│    - product context                   │
│    - search results context            │
│    - system instructions               │
│ 3. Begin streaming audio from mic      │
│    via Web Audio API (PCM16 frames)    │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Cloud Run: Live API Proxy               │
│                                         │
│ 1. Open Gemini Live API session         │
│    with product/results context         │
│ 2. Forward audio chunks:               │
│    extension → Live API                 │
│ 3. Forward response audio:             │
│    Live API → extension                 │
│ 4. Maintain session until disconnect   │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ Side Panel: Audio Playback              │
│                                         │
│ 1. Receive audio response stream       │
│ 2. Play via Web Audio API              │
│ 3. Display transcription in chat       │
│ 4. User can interrupt (barge-in)       │
│    — new audio cancels current playback│
└─────────────────────────────────────────┘
```

---

## API Contracts

### POST /search

```
Request:  SearchRequest
Response: SearchResponse
Timeout:  15 seconds
```

### POST /chat

```
Request:  { message: string, context: object, history: ChatMessage[] (max 20) }
Response: { reply: string }
Timeout:  10 seconds
```

### WebSocket /live

```
Connect:  wss://backend/live
Initial frame: { type: "config", context: object }
Client → Server: { type: "audio", encoding: "pcm_s16le", sampleRateHz: 16000, data: base64 } | { type: "text", content: string }
Server → Client: { type: "audio", encoding: "pcm_s16le", sampleRateHz: 24000, data: base64 } | { type: "transcript", content: string } | { type: "turn_complete" }
Close: either side disconnects
```

---

## Normalization: Gemini Grounding → SearchResult

Gemini Grounding returns `groundingChunks` (URLs + titles) and synthesized text. To extract structured product data:

1. Prompt Gemini to output structured JSON in its grounded response, requesting title, price, image URL, product URL, and marketplace for each product found.
2. Parse the structured JSON from the response text.
3. Cross-reference with `groundingChunks` to attach verified source URLs.
4. If structured extraction fails for a result, fall back to URL + title only and mark `price` and `imageUrl` as null.

This is inherently less reliable than Brave's JSON-LD extraction. The ranking step handles this gracefully — results with missing data receive lower confidence scores.

## Normalization: Brave LLM Context → SearchResult

Brave returns smart chunks with structured data extracted from pages. For product pages with JSON-LD markup:

1. Parse the `extra_snippets` and structured data fields from each result.
2. Map JSON-LD Product schema fields → SearchResult fields directly.
3. Extract marketplace from the result URL domain.
4. Results from Brave typically arrive with complete structured data (title, price, image, URL).

---

## Cache Strategy

**Key:** `search_{hash(imageUrl + pageUrl)}`
**Value:** `CachedSearch` object
**TTL:** 1 hour (configurable)
**Max entries:** 50 (LRU eviction — oldest `cachedAt` removed first)
**Cleanup trigger:** Extension service worker activation (on install, on browser start)
**Clear all:** User-accessible button in side panel settings

---

## Operational Constraints & Assumptions

1. Backend endpoints are HTTPS/WSS only; no insecure transport.
2. Gemini/Brave credentials remain server-side only; extension never embeds provider keys.
3. Cloud Run enforces basic abuse controls (CORS allowlist and rate limiting).
4. `/search` is a single-response endpoint for MVP (phase-based UI feedback, no incremental card streaming).
