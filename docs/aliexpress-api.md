# AliExpress Dropship API Reference

Integration guide for the AliExpress Open Platform Dropship APIs used by the shopping assistant.

## Authentication

### Overview

AliExpress uses OAuth 2.0 with HMAC-SHA256 request signing. All API calls require:

- **App Key** (`app_key`) — identifies the application
- **App Secret** — used to sign requests (never sent directly)
- **Access Token** (`session`) — obtained via OAuth, expires in 24 hours
- **Refresh Token** — used to renew access tokens, expires in 48 hours

### Obtaining an Access Token

**Step 1 — Authorize via browser:**

```
https://api-sg.aliexpress.com/oauth/authorize?response_type=code&force_auth=true&redirect_uri=YOUR_CALLBACK_URL&client_id=YOUR_APP_KEY
```

After login, the browser redirects to your callback URL with a `code` query parameter. The code expires in 30 minutes.

**Step 2 — Exchange code for token:**

The `/auth/token/create` endpoint uses the OP API (`/rest` base URL) with a signed request:

```typescript
const crypto = require("crypto");

const appKey = "YOUR_APP_KEY";
const appSecret = "YOUR_APP_SECRET";
const code = "AUTH_CODE_FROM_REDIRECT";

const params = {
  app_key: appKey,
  sign_method: "sha256",
  timestamp: Date.now().toString(),
  code,
};

// OP API signing: HMAC-SHA256(secret, apiPath + sorted param pairs)
const apiPath = "/auth/token/create";
const sortedKeys = Object.keys(params).sort();
const signString =
  apiPath + sortedKeys.map((k) => k + params[k]).join("");
const sign = crypto
  .createHmac("sha256", appSecret)
  .update(signString)
  .digest("hex")
  .toUpperCase();

params.sign = sign;
const qs = Object.entries(params)
  .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
  .join("&");

const response = await fetch(
  `https://api-sg.aliexpress.com/rest${apiPath}?${qs}`
);
```

**Response:**

```json
{
  "access_token": "50000901405d7ph...",
  "refresh_token": "50001900a05OCh8...",
  "expires_in": 86400,
  "refresh_expires_in": 172800,
  "account": "user@example.com"
}
```

### Request Signing (TOP API)

All product/search endpoints use the TOP API base URL (`/sync`). Signing differs from the OP API — the path is NOT prepended:

```typescript
function callAPI(
  method: string,
  extraParams: Record<string, string> = {}
) {
  const params: Record<string, string> = {
    app_key: APP_KEY,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
    session: ACCESS_TOKEN,
    method,
    format: "json",
    v: "2.0",
    ...extraParams,
  };

  // TOP API signing: HMAC-SHA256(secret, sorted param pairs) — no path prefix
  const sortedKeys = Object.keys(params).sort();
  const signString = sortedKeys.map((k) => k + params[k]).join("");
  const sign = crypto
    .createHmac("sha256", APP_SECRET)
    .update(signString)
    .digest("hex")
    .toUpperCase();

  params.sign = sign;
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  return fetch(`https://api-sg.aliexpress.com/sync?${qs}`).then((r) =>
    r.json()
  );
}
```

## API Endpoints

### Permissions

Our app has **Dropship API** access only. Affiliate APIs (`aliexpress.affiliate.*`) return `InsufficientPermission`.

### Endpoints We Use

| Method | Purpose | Role |
|--------|---------|------|
| `aliexpress.ds.text.search` | Keyword product search | **Primary search** |
| `aliexpress.ds.image.search` | Visual similarity search | **Secondary search** |
| `aliexpress.ds.product.get` | Full product details | **Enrichment** |

### Endpoints Available But Not Used

| Method | Purpose | Why skipped |
|--------|---------|-------------|
| `aliexpress.ds.recommend.feed.get` | Browse curated product feeds | Not relevant for price comparison |
| `aliexpress.ds.feedname.get` | List available feed names | Only needed for feed browsing |
| `aliexpress.ds.category.get` | Browse category tree | Text/image search covers discovery |

---

## aliexpress.ds.text.search

Keyword-based product search. This is our **primary search method** — fast, no image processing needed, and works well when the extension can extract a product name from the page.

### Required Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `keyword` | string | Search query text |
| `countryCode` | string | Ship-to country (e.g. `US`) |
| `currency` | string | Target currency (e.g. `USD`) |
| `local` | string | Locale (e.g. `en_US`) |

### Optional Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `page_size` | string | Results per page (default 20) |
| `page_index` | string | Page number |
| `sort` | string | Sort order (e.g. `salesDesc`) |

### Example

```typescript
const results = await callAPI("aliexpress.ds.text.search", {
  keyword: "wireless bluetooth earbuds",
  countryCode: "US",
  currency: "USD",
  local: "en_US",
  page_size: "5",
  page_index: "1",
  sort: "salesDesc",
});
```

### Response

```json
{
  "aliexpress_ds_text_search_response": {
    "code": "00",
    "data": {
      "pageIndex": 1,
      "pageSize": 20,
      "totalCount": 0,
      "products": {
        "selection_search_product": [
          {
            "itemId": "1005008148860952",
            "title": "X15 TWS Wireless Bluetooth Headset...",
            "itemMainPic": "//ae04.alicdn.com/kf/S6d2c72d6.jpg",
            "targetSalePrice": "1.83",
            "targetOriginalPrice": "4.35",
            "targetOriginalPriceCurrency": "USD",
            "discount": "58%",
            "score": "4.5",
            "evaluateRate": "89.2",
            "orders": "10,000+",
            "itemUrl": "//www.aliexpress.com/item/1005008148860952.html?...",
            "type": "recommend"
          }
        ]
      }
    }
  }
}
```

### Key Response Fields

| Field | Description |
|-------|-------------|
| `itemId` | Product ID (use with `ds.product.get` for full details) |
| `title` | Product name |
| `itemMainPic` | Main image URL (protocol-relative, prepend `https:`) |
| `targetSalePrice` | Current price in target currency |
| `targetOriginalPrice` | Original/list price in target currency |
| `discount` | Discount percentage |
| `score` | Product rating (out of 5) |
| `orders` | Sales volume string (e.g. "10,000+") |
| `itemUrl` | Product page URL (protocol-relative) |
| `type` | `"recommend"` for sponsored/recommended results |

---

## aliexpress.ds.image.search

Visual similarity search using a product image. **Secondary search method** — best for visual products (clothing, accessories, home decor) where names are unreliable, or as a complement to text search.

### Important: Requires Multipart Upload

Unlike other endpoints, image search requires the image to be sent as a **multipart file upload**, not as a URL or base64 string. The backend must download the source image first, then forward the raw bytes.

### Required Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `image_file_bytes` | file | Image file (multipart upload) |
| `shpt_to` | string | Ship-to country (e.g. `US`) |

### Optional Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `target_currency` | string | Target currency (e.g. `USD`) |
| `target_language` | string | Target language (e.g. `EN`) |
| `product_cnt` | string | Number of results to return |

### Example

```typescript
// 1. Download the source product image
const imgRes = await fetch(productImageUrl);
const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

// 2. Build signed params (WITHOUT image_file_bytes)
const params = {
  app_key: APP_KEY,
  sign_method: "sha256",
  timestamp: Date.now().toString(),
  session: ACCESS_TOKEN,
  method: "aliexpress.ds.image.search",
  format: "json",
  v: "2.0",
  target_currency: "USD",
  target_language: "EN",
  shpt_to: "US",
  product_cnt: "5",
};

// 3. Sign (image bytes excluded from signature)
const sortedKeys = Object.keys(params).sort();
const signString = sortedKeys.map((k) => k + params[k]).join("");
const sign = crypto
  .createHmac("sha256", APP_SECRET)
  .update(signString)
  .digest("hex")
  .toUpperCase();
params.sign = sign;

// 4. Build multipart form body
const boundary = "----FormBoundary" + Date.now();
let body = "";
for (const [k, v] of Object.entries(params)) {
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="${k}"\r\n\r\n`;
  body += `${v}\r\n`;
}
body += `--${boundary}\r\n`;
body += `Content-Disposition: form-data; name="image_file_bytes"; filename="image.jpg"\r\n`;
body += `Content-Type: image/jpeg\r\n\r\n`;

const bodyBuffer = Buffer.concat([
  Buffer.from(body),
  imgBuffer,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);

// 5. POST as multipart
const response = await fetch("https://api-sg.aliexpress.com/sync", {
  method: "POST",
  headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  body: bodyBuffer,
});
```

### Response

```json
{
  "aliexpress_ds_image_search_response": {
    "data": {
      "total_record_count": 5,
      "products": {
        "traffic_image_product_d_t_o": [
          {
            "product_id": "3256807996818647",
            "product_title": "Butterfly Snake Mermaid Flower...",
            "product_main_image_url": "https://ae-pic-a1.aliexpress-media.com/kf/...",
            "target_sale_price": "0.51",
            "target_original_price": "1.03",
            "target_sale_price_currency": "USD",
            "discount": "50%",
            "evaluate_rate": "100.0%",
            "lastest_volume": "11",
            "product_detail_url": "https://www.aliexpress.com/item/...",
            "shop_url": "https://www.aliexpress.com/store/...",
            "first_level_category_name": "Jewelry & Accessories",
            "second_level_category_name": "Fashion Jewelry"
          }
        ]
      }
    }
  }
}
```

### Note: Different Response Shape

Image search returns a different product object than text search. Key naming differences:

| Text Search | Image Search |
|-------------|--------------|
| `itemId` | `product_id` |
| `title` | `product_title` |
| `itemMainPic` | `product_main_image_url` |
| `targetSalePrice` | `target_sale_price` |
| `targetOriginalPrice` | `target_original_price` |
| `orders` | `lastest_volume` |
| `score` | _(not returned)_ |

The backend should normalize these into a common response type.

---

## aliexpress.ds.product.get

Get full product details by ID. Use after search to enrich results with SKU variants, shipping info, descriptions, etc.

### Required Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `product_id` | string | AliExpress product ID |
| `ship_to_country` | string | Ship-to country (e.g. `US`) |

### Optional Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `target_currency` | string | Target currency (e.g. `USD`) |
| `target_language` | string | Target language (e.g. `EN`) |

### Example

```typescript
const details = await callAPI("aliexpress.ds.product.get", {
  product_id: "1005008148860952",
  ship_to_country: "US",
  target_currency: "USD",
  target_language: "EN",
});
```

---

## Shopping Assistant Integration Strategy

### Primary Flow: Text Search

Best for most products. The extension extracts the product name from the page DOM, and the backend searches AliExpress by keyword.

```
User views product on Amazon/eBay/etc.
  → Extension extracts product title from DOM
  → Backend calls aliexpress.ds.text.search with extracted title
  → Returns matching AliExpress products with prices
```

**Pros:** Fast, simple, no image processing.
**Cons:** Relies on good keyword extraction. Generic or branded names may return poor results.

### Secondary Flow: Image Search

Best for visual products (clothing, accessories, decor) where titles are unreliable, or as a complement to text search.

```
User views product on Amazon/eBay/etc.
  → Extension grabs the main product image URL
  → Backend downloads the image
  → Backend calls aliexpress.ds.image.search with raw image bytes (multipart)
  → Returns visually similar AliExpress products
```

**Pros:** Works regardless of product naming. Great for fashion/visual categories.
**Cons:** Slower (requires image download + upload). Multipart form encoding adds complexity.

### Recommended Approach

Use **text search as default**, with **image search as fallback or supplement**:

1. Always run text search first (fast, simple)
2. Optionally run image search in parallel for visual categories
3. Merge and deduplicate results from both sources
4. Enrich top results with `ds.product.get` if detailed specs are needed

### Token Management

- Access tokens expire in **24 hours**
- Refresh tokens expire in **48 hours**
- The backend should store tokens and implement automatic refresh via `/auth/token/refresh`
- Token refresh uses the same OP API signing as token creation
