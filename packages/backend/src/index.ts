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
const corsMiddleware = cors({
  origin: "*", // TODO: Restrict to extension origin in production
  allowMethods: ["GET", "POST"],
  allowHeaders: ["Content-Type"],
});
app.use("/health", corsMiddleware);
app.use("/search/*", corsMiddleware);
app.use("/identify/*", corsMiddleware);
app.use("/chat/*", corsMiddleware);
app.use("/auth/*", corsMiddleware);

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

// Start AliExpress token auto-refresh (if tokens are configured)
initAliExpressAutoRefresh();
