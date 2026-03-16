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

// Restore refresh token from env (survives restarts)
let refreshToken = process.env.ALIEXPRESS_REFRESH_TOKEN ?? "";
let refreshTokenExpiry = Number(process.env.ALIEXPRESS_REFRESH_TOKEN_EXPIRY) || 0;

// Auto-refresh: refresh when 80% of the token lifetime has elapsed
const REFRESH_LIFETIME_FRACTION = 0.8;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

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
  const tokenExpiryMs = Date.now() + expiresIn * 1000;
  setAccessToken(accessTokenValue, expiresIn);

  // Store refresh token
  const refreshExpiryMs = Date.now() + refreshExpiresIn * 1000;
  if (refreshTokenValue) {
    refreshToken = refreshTokenValue;
    refreshTokenExpiry = refreshExpiryMs;
  }

  // Persist all tokens to .env so they survive restarts
  try {
    persistAllTokensToEnv(accessTokenValue, tokenExpiryMs, refreshTokenValue, refreshExpiryMs);
  } catch (e) {
    console.warn("[aliexpress-auth] Failed to persist tokens to .env:", e);
  }

  // Schedule the next auto-refresh
  scheduleTokenRefresh(tokenExpiryMs);

  console.log(`[aliexpress-auth] Token acquired. Expires in ${Math.round(expiresIn / 86400)} days. Refresh token: ${refreshTokenValue ? "yes" : "no"}`);

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

  const tokenExpiryMs = Date.now() + expiresIn * 1000;
  setAccessToken(accessTokenValue, expiresIn);

  const refreshExpiryMs = Date.now() + refreshExpiresIn * 1000;
  if (newRefreshToken) {
    refreshToken = newRefreshToken;
    refreshTokenExpiry = refreshExpiryMs;
  }

  // Persist all tokens to .env
  try {
    persistAllTokensToEnv(accessTokenValue, tokenExpiryMs, newRefreshToken, refreshExpiryMs);
  } catch (e) {
    console.warn("[aliexpress-auth] Failed to persist refreshed tokens to .env:", e);
  }

  // Schedule the next auto-refresh
  scheduleTokenRefresh(tokenExpiryMs);

  console.log(`[aliexpress-auth] Token refreshed. Expires in ${Math.round(expiresIn / 86400)} days`);

  return {
    accessToken: accessTokenValue,
    expiresIn,
    refreshToken: newRefreshToken ?? null,
  };
}

// ── Auto-Refresh Scheduling ──────────────────────────────────────────────────

function scheduleTokenRefresh(accessTokenExpiresAt: number): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  if (!refreshToken || Date.now() >= refreshTokenExpiry) {
    console.log("[aliexpress-auth] No valid refresh token — auto-refresh not scheduled");
    return;
  }

  // Refresh after 80% of the token lifetime has elapsed, but at least 1 minute from now
  const totalLifetimeMs = accessTokenExpiresAt - Date.now();
  const refreshAt = Math.max(
    Date.now() + totalLifetimeMs * REFRESH_LIFETIME_FRACTION,
    Date.now() + 60_000,
  );
  const delayMs = refreshAt - Date.now();
  const delayHours = (delayMs / (60 * 60 * 1000)).toFixed(1);

  console.log(`[aliexpress-auth] Auto-refresh scheduled in ${delayHours} hours`);

  refreshTimer = setTimeout(async () => {
    console.log("[aliexpress-auth] Auto-refreshing token...");
    try {
      const result = await refreshAccessToken();
      console.log(`[aliexpress-auth] Auto-refresh succeeded. New token expires in ${Math.round(result.expiresIn / 86400)} days`);
    } catch (err) {
      console.error("[aliexpress-auth] Auto-refresh failed:", err);
      // Retry in 1 hour
      console.log("[aliexpress-auth] Will retry in 1 hour");
      refreshTimer = setTimeout(() => scheduleTokenRefresh(Date.now()), 60 * 60 * 1000);
    }
  }, delayMs);

  // Don't let the timer keep the process alive
  refreshTimer.unref();
}

/**
 * Call on startup to restore token state and schedule auto-refresh.
 */
export function initAliExpressAutoRefresh(): void {
  const tokenExpiry = Number(process.env.ALIEXPRESS_TOKEN_EXPIRY) || 0;
  const hasToken = !!process.env.ALIEXPRESS_ACCESS_TOKEN;

  if (!hasToken) {
    console.log("[aliexpress-auth] No access token configured — skipping auto-refresh setup");
    return;
  }

  if (tokenExpiry && Date.now() < tokenExpiry) {
    const daysLeft = ((tokenExpiry - Date.now()) / (24 * 60 * 60 * 1000)).toFixed(1);
    console.log(`[aliexpress-auth] Access token valid for ${daysLeft} more days`);
    scheduleTokenRefresh(tokenExpiry);
  } else if (refreshToken && Date.now() < refreshTokenExpiry) {
    console.log("[aliexpress-auth] Access token expired but refresh token is valid — refreshing now");
    refreshAccessToken().catch((err) => {
      console.error("[aliexpress-auth] Startup refresh failed:", err);
    });
  } else {
    console.log("[aliexpress-auth] No valid tokens — manual re-authorization required via GET /auth/aliexpress");
  }
}

// ── .env Persistence ────────────────────────────────────────────────────────

function getEnvPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // routes/ -> src/ -> backend/
  return resolve(currentDir, "..", "..", ".env");
}

function upsertEnvVar(content: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, `${key}=${value}`);
  }
  return content.trimEnd() + `\n${key}=${value}\n`;
}

function persistTokenToEnv(token: string): void {
  const envPath = getEnvPath();
  let content = readFileSync(envPath, "utf-8");

  content = upsertEnvVar(content, "ALIEXPRESS_ACCESS_TOKEN", token);

  writeFileSync(envPath, content);
  console.log(`[aliexpress-auth] Token persisted to ${envPath}`);
}

function persistAllTokensToEnv(
  accessTokenValue: string,
  tokenExpiryMs: number,
  refreshTokenValue: string | undefined,
  refreshExpiryMs: number,
): void {
  const envPath = getEnvPath();
  let content = readFileSync(envPath, "utf-8");

  content = upsertEnvVar(content, "ALIEXPRESS_ACCESS_TOKEN", accessTokenValue);
  content = upsertEnvVar(content, "ALIEXPRESS_TOKEN_EXPIRY", String(tokenExpiryMs));
  if (refreshTokenValue) {
    content = upsertEnvVar(content, "ALIEXPRESS_REFRESH_TOKEN", refreshTokenValue);
    content = upsertEnvVar(content, "ALIEXPRESS_REFRESH_TOKEN_EXPIRY", String(refreshExpiryMs));
  }

  writeFileSync(envPath, content);
  console.log(`[aliexpress-auth] All tokens persisted to ${envPath}`);
}
