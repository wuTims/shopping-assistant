import { Hono } from "hono";
import type { ChatRequest, ChatResponse } from "@shopping-assistant/shared";

export const chatRoute = new Hono();

chatRoute.post("/", async (c) => {
  const body = await c.req.json<ChatRequest>();

  // TODO: Implement Gemini Flash chat with product context
  console.log("[chat] Received message:", body.message);

  const response: ChatResponse = {
    reply: "Chat is not yet implemented. This is a placeholder response.",
  };

  return c.json(response);
});
