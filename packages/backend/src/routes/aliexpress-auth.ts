import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setAccessToken, hasValidToken, getAccessToken } from "../services/aliexpress.js";

const APP_KEY = process.env.ALIEXPRESS_APP_KEY ?? "";
const APP_SECRET = process.env.ALIEXPRESS_API_KEY ?? "";
const CALLBACK_URL = process.env.ALIEXPRESS_CALLBACK_URL ?? "";
const OP_BASE_URL = "https://api-sg.aliexpress.com/rest";

// Store refresh token in memory (same lifecycle as access token)
let refreshToken = "";
let refreshTokenExpiry = 0;

export const aliexpressAuthRoute = new Hono();

/**
 * GET /auth/aliexpress
 * Returns the OAuth authorize URL for the user to visit in their browser.
 */
aliexpressAuthRoute.get("/", (c) => {
  if (!APP_KEY) {
    return c.json({ error: "ALIEXPRESS_APP_KEY not set" }, 500);
  }
  if (!CALLBACK_URL) {
    return c.json({ error: "ALIEXPRESS_CALLBACK_URL not set" }, 500);
  }

  const authorizeUrl =
    `https://api-sg.aliexpress.com/oauth/authorize` +
    `?response_type=code&force_auth=true` +
    `&redirect_uri=${encodeURIComponent(CALLBACK_URL)}` +
    `&client_id=${APP_KEY}`;

  return c.json({
    authorizeUrl,
    callbackUrl: CALLBACK_URL,
    instructions: "1) Open authorizeUrl in browser. 2) Log in & authorize. 3) Copy the 'code' param from the redirect URL. 4) POST it to /auth/aliexpress/token",
    hasValidToken: hasValidToken(),
  });
});

/**
 * POST /auth/aliexpress/token  { "code": "..." }
 * Exchange an authorization code for access + refresh tokens.
 */
aliexpressAuthRoute.post("/token", async (c) => {
  const { code } = await c.req.json<{ code: string }>();
  if (!code) {
    return c.json({ error: "missing_code", message: "Provide {\"code\": \"...\"} from the OAuth redirect" }, 400);
  }

  try {
    const result = await exchangeCodeForToken(code);
    return c.json({
      success: true,
      accessTokenPreview: result.accessToken.slice(0, 12) + "..." + result.accessToken.slice(-6),
      expiresInSeconds: result.expiresIn,
      hasRefreshToken: !!result.refreshToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[aliexpress-auth] Token exchange failed:", err);
    return c.json({ error: "token_exchange_failed", message }, 500);
  }
});

/**
 * POST /auth/aliexpress/refresh
 * Refresh the access token using the stored refresh token.
 */
aliexpressAuthRoute.post("/refresh", async (c) => {
  if (!refreshToken || Date.now() >= refreshTokenExpiry) {
    return c.json({
      error: "no_refresh_token",
      message: refreshToken ? "Refresh token expired" : "No refresh token stored. Re-authorize via GET /auth/aliexpress",
    }, 400);
  }

  try {
    const result = await refreshAccessToken();
    return c.json({
      success: true,
      accessTokenPreview: result.accessToken.slice(0, 12) + "...",
      expiresInSeconds: result.expiresIn,
      hasRefreshToken: !!result.refreshToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[aliexpress-auth] Token refresh failed:", err);
    return c.json({ error: "refresh_failed", message }, 500);
  }
});

/**
 * POST /auth/aliexpress/persist
 * Write the current in-memory access token to .env so it survives restarts.
 */
aliexpressAuthRoute.post("/persist", (c) => {
  const token = getAccessToken();
  if (!token) {
    return c.json({ error: "no_token", message: "No access token in memory to persist" }, 400);
  }

  try {
    persistTokenToEnv(token);
    return c.json({ success: true, message: "Token written to .env" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "persist_failed", message }, 500);
  }
});

/**
 * GET /auth/aliexpress/status
 * Check current token status.
 */
aliexpressAuthRoute.get("/status", (c) => {
  return c.json({
    hasValidToken: hasValidToken(),
    hasRefreshToken: refreshToken !== "" && Date.now() < refreshTokenExpiry,
    refreshTokenExpired: refreshToken !== "" && Date.now() >= refreshTokenExpiry,
    appKeySet: APP_KEY !== "",
    appSecretSet: APP_SECRET !== "",
  });
});

// ── Token Exchange ──────────────────────────────────────────────────────────

async function exchangeCodeForToken(code: string) {
  const apiPath = "/auth/token/create";
  const params: Record<string, string> = {
    app_key: APP_KEY,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
    code,
  };

  // OP API signing: HMAC-SHA256(secret, apiPath + sorted param pairs)
  const sortedKeys = Object.keys(params).sort();
  const signString = apiPath + sortedKeys.map((k) => k + params[k]).join("");
  const sign = createHmac("sha256", APP_SECRET)
    .update(signString)
    .digest("hex")
    .toUpperCase();

  params.sign = sign;
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  const res = await fetch(`${OP_BASE_URL}${apiPath}?${qs}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as Record<string, unknown>;

  if (data.error_response) {
    const errResp = data.error_response as Record<string, unknown>;
    throw new Error(`AliExpress API error: ${errResp.msg ?? JSON.stringify(errResp)}`);
  }

  const accessTokenValue = data.access_token as string;
  const expiresIn = (data.expires_in as number) ?? 86400;
  const refreshTokenValue = data.refresh_token as string | undefined;
  const refreshExpiresIn = (data.refresh_expires_in as number) ?? 172800;

  if (!accessTokenValue) {
    throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
  }

  // Activate the token in the aliexpress service
  setAccessToken(accessTokenValue, expiresIn);

  // Store refresh token
  if (refreshTokenValue) {
    refreshToken = refreshTokenValue;
    refreshTokenExpiry = Date.now() + refreshExpiresIn * 1000;
  }

  // Auto-persist to .env so token survives restarts
  try {
    persistTokenToEnv(accessTokenValue);
  } catch (e) {
    console.warn("[aliexpress-auth] Failed to persist token to .env:", e);
  }

  console.log(`[aliexpress-auth] Token acquired. Expires in ${Math.round(expiresIn / 3600)}h. Refresh token: ${refreshTokenValue ? "yes" : "no"}`);

  return {
    accessToken: accessTokenValue,
    expiresIn,
    refreshToken: refreshTokenValue ?? null,
  };
}

async function refreshAccessToken() {
  const apiPath = "/auth/token/refresh";
  const params: Record<string, string> = {
    app_key: APP_KEY,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
    refresh_token: refreshToken,
  };

  // OP API signing
  const sortedKeys = Object.keys(params).sort();
  const signString = apiPath + sortedKeys.map((k) => k + params[k]).join("");
  const sign = createHmac("sha256", APP_SECRET)
    .update(signString)
    .digest("hex")
    .toUpperCase();

  params.sign = sign;
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  const res = await fetch(`${OP_BASE_URL}${apiPath}?${qs}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as Record<string, unknown>;

  if (data.error_response) {
    const errResp = data.error_response as Record<string, unknown>;
    throw new Error(`AliExpress API error: ${errResp.msg ?? JSON.stringify(errResp)}`);
  }

  const accessTokenValue = data.access_token as string;
  const expiresIn = (data.expires_in as number) ?? 86400;
  const newRefreshToken = data.refresh_token as string | undefined;
  const refreshExpiresIn = (data.refresh_expires_in as number) ?? 172800;

  if (!accessTokenValue) {
    throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
  }

  setAccessToken(accessTokenValue, expiresIn);

  if (newRefreshToken) {
    refreshToken = newRefreshToken;
    refreshTokenExpiry = Date.now() + refreshExpiresIn * 1000;
  }

  console.log(`[aliexpress-auth] Token refreshed. Expires in ${Math.round(expiresIn / 3600)}h`);

  return {
    accessToken: accessTokenValue,
    expiresIn,
    refreshToken: newRefreshToken ?? null,
  };
}

// ── .env Persistence ────────────────────────────────────────────────────────

function getEnvPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // routes/ -> src/ -> backend/
  return resolve(currentDir, "..", "..", ".env");
}

function persistTokenToEnv(token: string): void {
  const envPath = getEnvPath();
  let content = readFileSync(envPath, "utf-8");

  if (content.match(/^ALIEXPRESS_ACCESS_TOKEN=.*$/m)) {
    content = content.replace(
      /^ALIEXPRESS_ACCESS_TOKEN=.*$/m,
      `ALIEXPRESS_ACCESS_TOKEN=${token}`,
    );
  } else {
    content = content.trimEnd() + `\nALIEXPRESS_ACCESS_TOKEN=${token}\n`;
  }

  writeFileSync(envPath, content);
  console.log(`[aliexpress-auth] Token persisted to ${envPath}`);
}
