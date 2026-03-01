import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";

import { searchRoute } from "./routes/search.js";
import { chatRoute } from "./routes/chat.js";
import { liveWebSocket } from "./ws/live.js";

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*", // TODO: Restrict to extension origin in production
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type"],
  }),
);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Routes
app.route("/search", searchRoute);
app.route("/chat", chatRoute);

// WebSocket for Live API proxy
app.get("/live", upgradeWebSocket(liveWebSocket));

const port = Number(process.env.PORT) || 8080;
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Backend running on http://localhost:${info.port}`);
});

injectWebSocket(server);
