import { Hono } from "hono";
import type {
  ChatRequest,
  ChatResponse,
  ChatMessage,
  ChatProductContext,
  RankedResult,
} from "@shopping-assistant/shared";
import { CHAT_TIMEOUT_MS, MAX_CHAT_HISTORY } from "@shopping-assistant/shared";
import { ai, geminiModel as model } from "../services/ai-client.js";

const SYSTEM_INSTRUCTION = [
  "You are a helpful shopping comparison assistant.",
  "You help users compare products across marketplaces, understand pricing differences, and make informed purchasing decisions.",
  "When product and search result context is provided, reference specific results with prices, marketplaces, and confidence levels.",
  "Be concise and actionable. If you don't have enough context, say so rather than guessing.",
  "Never fabricate prices, URLs, or product details that weren't provided in the context.",
].join(" ");

export const chatRoute = new Hono();

chatRoute.post("/", async (c) => {
  let body: ChatRequest;
  try {
    body = await c.req.json<ChatRequest>();
  } catch {
    return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);
  }

  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "bad_request", message: "message is required and must be a string" }, 400);
  }
  if (!body.context || typeof body.context !== "object") {
    return c.json({ error: "bad_request", message: "context is required" }, 400);
  }
  if (!Array.isArray(body.history)) {
    return c.json({ error: "bad_request", message: "history is required and must be an array" }, 400);
  }

  console.log(`[chat] Message: "${body.message.slice(0, 80)}${body.message.length > 80 ? "..." : ""}"`);

  try {
    const contextBlock = buildContextBlock(body.context.product, body.context.results);
    const historyContents = buildHistoryContents(body.history);

    const contents = [
      ...historyContents,
      { role: "user" as const, parts: [{ text: contextBlock + body.message }] },
    ];

    const response = await ai.models.generateContent({
      model,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        httpOptions: { timeout: CHAT_TIMEOUT_MS },
      },
    });

    const reply = response.text?.trim();
    if (!reply) {
      console.error("[chat] Model returned empty response");
      return c.json<ChatResponse>(
        { reply: "I wasn't able to generate a response. Please try rephrasing your question." },
        500,
      );
    }

    return c.json<ChatResponse>({ reply });
  } catch (err) {
    console.error("[chat] Provider failure:", err);
    return c.json<ChatResponse>(
      { reply: "Sorry, I'm having trouble responding right now. Please try again in a moment." },
      500,
    );
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildContextBlock(
  product: ChatProductContext | null,
  results: RankedResult[] | null,
): string {
  const parts: string[] = [];

  if (product) {
    parts.push("[Current Product]");
    parts.push(`Title: ${product.title ?? product.name ?? "Unknown"}`);
    if (product.price !== null) {
      parts.push(`Price: ${product.currency ?? "$"}${product.price}`);
    }
    if (product.marketplace) {
      parts.push(`Marketplace: ${product.marketplace}`);
    }
    parts.push("");
  }

  if (results && results.length > 0) {
    parts.push(`[Search Results — ${results.length} found]`);
    for (const ranked of results.slice(0, 10)) {
      const r = ranked.result;
      const priceStr = r.price !== null ? ` — ${r.currency ?? "$"}${r.price}` : "";
      const deltaStr = ranked.priceDelta !== null
        ? ` (${ranked.priceDelta > 0 ? "+" : ""}${ranked.priceDelta.toFixed(2)})`
        : "";
      parts.push(
        `#${ranked.rank} [${ranked.confidence}] "${r.title}" from ${r.marketplace}${priceStr}${deltaStr}`,
      );
    }
    parts.push("");
  }

  if (parts.length === 0) return "";
  return parts.join("\n") + "\n\nUser question: ";
}

function buildHistoryContents(
  history: ChatMessage[],
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  // Trim to max history and convert roles
  const trimmed = history.slice(-MAX_CHAT_HISTORY);

  return trimmed.map((msg) => ({
    role: msg.role === "assistant" ? "model" as const : "user" as const,
    parts: [{ text: msg.content }],
  }));
}
