import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";

import { searchRoute } from "./routes/search.js";
import { chatRoute } from "./routes/chat.js";
import identifyRoute from "./routes/identify.js";
import { aliexpressAuthRoute, initAliExpressAutoRefresh } from "./routes/aliexpress-auth.js";
import { liveWebSocket } from "./ws/live.js";
import { rateLimit } from "./middleware/rate-limit.js";

// Fail fast if required env vars are missing
const REQUIRED_ENV_VARS = ["GEMINI_API_KEY", "BRAVE_API_KEY"];
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Middleware
app.use("*", logger());

// Apply CORS only to REST endpoints.
// WebSocket upgrade requests are incompatible with CORS header mutation.
const ALLOWED_ORIGINS: string | string[] = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",")
  : "*";

const corsMiddleware = cors({
  origin: ALLOWED_ORIGINS,
  allowMethods: ["GET", "POST"],
  allowHeaders: ["Content-Type"],
});
app.use("/health", corsMiddleware);
app.use("/search/*", corsMiddleware);
app.use("/identify/*", corsMiddleware);
app.use("/chat/*", corsMiddleware);
app.use("/auth/*", corsMiddleware);

// Rate limit: 60 requests per minute per IP for API endpoints
const apiRateLimit = rateLimit({ windowMs: 60_000, max: 60 });
app.use("/search/*", apiRateLimit);
app.use("/identify/*", apiRateLimit);
app.use("/chat/*", apiRateLimit);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Routes
app.route("/search", searchRoute);
app.route("/identify", identifyRoute);
app.route("/chat", chatRoute);
app.route("/auth/aliexpress", aliexpressAuthRoute);

// WebSocket for Live API proxy
app.get("/live", upgradeWebSocket(liveWebSocket));

const port = Number(process.env.PORT) || 8080;
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Backend running on http://localhost:${info.port}`);
});

injectWebSocket(server);

console.log("[config] GEMINI_MODEL:", process.env.GEMINI_MODEL || "gemini-2.5-flash (default)");
console.log("[config] GEMINI_LIVE_MODEL:", process.env.GEMINI_LIVE_MODEL || "not set");
console.log("[config] CORS origins:", process.env.CORS_ALLOWED_ORIGINS || "* (open)");

// Start AliExpress token auto-refresh (if tokens are configured)
initAliExpressAutoRefresh().catch((err) => {
  console.error("[aliexpress] Auto-refresh init failed:", err);
});
