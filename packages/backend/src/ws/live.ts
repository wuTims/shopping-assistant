import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { Modality, Type, Behavior, FunctionResponseScheduling } from "@google/genai";
import type { Session, LiveServerMessage, FunctionDeclaration, FunctionCall } from "@google/genai";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";
import type { RankedResult } from "@shopping-assistant/shared";
import { VOICE_SESSION_MAX_MS } from "@shopping-assistant/shared";
import { ai, liveModel } from "../services/ai-client.js";
import { executeVoiceSearch } from "../services/voice-search.js";

function buildSystemInstruction(): string {
  return `You are a knowledgeable shopping concierge helping a customer compare products and find the best deals. You are calm, professional, and focused on helping them make the best purchasing decision.

Behavior:
- Be concise. Keep responses to 2-3 sentences unless the user asks for detail.
- When using search_products, tell the customer what you're doing: "Let me check a few marketplaces for that..." — never go silent.
- When presenting search results, lead with the best value and explain why.
- If prices are missing for some results, acknowledge that honestly.
- When comparing products, highlight meaningful differences (price, marketplace trustworthiness, shipping) not specs the user can read themselves.
- If the user interrupts, gracefully pivot to their new question without repeating yourself.
- Greet the customer briefly when the conversation starts: mention the product they're looking at and the price range found, then ask how you can help.`;
}

function formatMoney(price: unknown, currency: unknown): string | null {
  if (typeof price !== "number") return null;
  return `${typeof currency === "string" ? currency : "USD"} ${price}`;
}

const searchProductsDeclaration: FunctionDeclaration = {
  name: "search_products",
  description: "Search for product alternatives across online marketplaces. Use when the user asks about options not in the current results, wants to search a specific store, or asks for different alternatives.",
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Search query for finding products" },
      marketplace_filter: { type: Type.STRING, description: "Optional: restrict to a specific marketplace (amazon, ebay, walmart, aliexpress, etc.)" },
    },
    required: ["query"],
  },
};

const comparePricesDeclaration: FunctionDeclaration = {
  name: "compare_prices",
  description: "Compare prices across all known results from the initial search and any subsequent searches. Use when the user asks which option is cheapest, wants a price comparison, or asks about savings.",
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export function buildVoiceContextTurnText(contextData: Record<string, unknown>): string {
  const parts: string[] = [];

  const focusedProduct = contextData.focusedProduct;
  if (focusedProduct && typeof focusedProduct === "object") {
    const product = focusedProduct as Record<string, unknown>;
    parts.push("[Focused item]");
    parts.push(`Name: ${String(product.title ?? product.name ?? "Unknown")}`);
    if (typeof product.marketplace === "string") {
      parts.push(`Marketplace: ${product.marketplace}`);
    }
    const focusedPrice = formatMoney(product.price, product.currency);
    if (focusedPrice) {
      parts.push(`Price: ${focusedPrice}`);
    }
    if (typeof product.productUrl === "string") {
      parts.push(`URL: ${product.productUrl}`);
    }
    parts.push("");
  }

  const currentProduct = contextData.currentProduct;
  if (currentProduct && typeof currentProduct === "object") {
    const product = currentProduct as Record<string, unknown>;
    parts.push("[Original product]");
    parts.push(`Name: ${String(product.title ?? product.name ?? "Unknown")}`);
    if (typeof product.marketplace === "string") {
      parts.push(`Marketplace: ${product.marketplace}`);
    }
    const originalPrice = formatMoney(product.price, product.currency);
    if (originalPrice) {
      parts.push(`Price: ${originalPrice}`);
    }
    parts.push("");
  }

  const results = contextData.results;
  if (Array.isArray(results) && results.length > 0) {
    parts.push("[Top alternatives]");
    for (const result of results.slice(0, 5)) {
      if (!result || typeof result !== "object") continue;
      const item = result as Record<string, unknown>;
      const priceLabel = formatMoney(item.price, item.currency);
      parts.push(
        `#${typeof item.rank === "number" ? item.rank : "?"} ${String(item.title ?? "Unknown")} from ${String(item.marketplace ?? "Unknown")}${priceLabel ? ` — ${priceLabel}` : ""}`,
      );
    }
    parts.push("");
  }

  if (typeof contextData.guidance === "string") {
    parts.push(`[Guidance] ${contextData.guidance}`);
  } else {
    parts.push("[Guidance] Answer about the focused item first unless the user asks to compare multiple options.");
  }

  return parts.join("\n");
}

function sendToClient(ws: WSContext, message: WsServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // Client may have disconnected
  }
}

export function liveWebSocket(c: Context): WSEvents {
  let upstream: Session | null = null;
  let configReceived = false;
  let closed = false;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let setupResolve: (() => void) | null = null;
  let setupReject: ((err: Error) => void) | null = null;
  const pendingToolCalls = new Map<string, AbortController>();
  let activeSearchToolCallId: string | null = null;
  let accumulatedResults: RankedResult[] = [];
  let initialResults: RankedResult[] = [];
  let initialContext: Record<string, unknown> = {};

  function cleanupTimer(): void {
    if (sessionTimer) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
  }

  return {
    onOpen(_evt, ws) {
      const origin = c.req.header("origin") ?? "";
      if (
        !origin.startsWith("chrome-extension://") &&
        !origin.startsWith("http://localhost")
      ) {
        sendToClient(ws, { type: "error", message: "Unauthorized origin" });
        closed = true;
        cleanupTimer();
        ws.close();
        return;
      }
      console.log("[live] Client connected");
    },

    async onMessage(evt, ws) {
      if (closed) return;

      let message: WsClientMessage;
      try {
        message = JSON.parse(String(evt.data)) as WsClientMessage;
      } catch {
        sendToClient(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      if (message.type === "config") {
        if (configReceived) {
          sendToClient(ws, { type: "error", message: "Config already sent" });
          return;
        }
        configReceived = true;

        const systemInstruction = buildSystemInstruction();

        try {
          // Create the setup promise before connect() so that if
          // setupComplete arrives during the connection handshake
          // the resolve/reject are already wired up.
          const setupPromise = new Promise<void>((resolve, reject) => {
            setupResolve = resolve;
            setupReject = reject;
          });

          const session = await ai.live.connect({
            model: liveModel,
            config: {
              responseModalities: [Modality.AUDIO],
              systemInstruction: { parts: [{ text: systemInstruction }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
              },
              tools: [{ functionDeclarations: [searchProductsDeclaration, comparePricesDeclaration] }],
            },
            callbacks: {
              onopen() {
                console.log("[live] Upstream session opened");
              },
              onmessage(message: LiveServerMessage) {
                // Diagnostic: log every upstream message type
                const msgTypes: string[] = [];
                if (message.serverContent) msgTypes.push("serverContent");
                if (message.toolCall) msgTypes.push(`toolCall(${message.toolCall.functionCalls?.map(fc => fc.name).join(",") ?? "?"})`);
                if (message.toolCallCancellation) msgTypes.push("toolCallCancellation");
                if (message.setupComplete) msgTypes.push("setupComplete");
                if (message.goAway) msgTypes.push("goAway");
                if (message.sessionResumptionUpdate) msgTypes.push("sessionResumption");
                if (msgTypes.length > 0 && !msgTypes.every(t => t === "serverContent")) {
                  console.log(`[live] Upstream: ${msgTypes.join(", ")}`);
                }

                const sc = message.serverContent;
                if (sc) {
                  if (sc.modelTurn?.parts) {
                    for (const part of sc.modelTurn.parts) {
                      if (part.inlineData?.data) {
                        sendToClient(ws, {
                          type: "audio",
                          encoding: "pcm_s16le",
                          sampleRateHz: 24000,
                          data: part.inlineData.data,
                        });
                      }
                    }
                  }

                  if (sc.inputTranscription?.text) {
                    sendToClient(ws, {
                      type: "input_transcript",
                      content: sc.inputTranscription.text,
                    });
                  }
                  if (sc.outputTranscription?.text) {
                    sendToClient(ws, {
                      type: "output_transcript",
                      content: sc.outputTranscription.text,
                    });
                  }

                  if (sc.interrupted === true) {
                    sendToClient(ws, { type: "interrupted" });
                  }
                  if (sc.turnComplete === true) {
                    sendToClient(ws, { type: "turn_complete" });
                  }
                }

                if (message.goAway) {
                  const timeLeftMs = message.goAway.timeLeft
                    ? Math.round(parseFloat(String(message.goAway.timeLeft)) * 1000)
                    : 0;
                  console.log(`[live] GoAway received, ${timeLeftMs}ms remaining`);
                  sendToClient(ws, { type: "go_away", timeLeftMs });
                }

                if (message.sessionResumptionUpdate?.newHandle) {
                  sendToClient(ws, {
                    type: "session_resumption",
                    token: message.sessionResumptionUpdate.newHandle,
                  });
                }

                if (message.setupComplete) {
                  console.log("[live] Upstream setup complete");
                  setupResolve?.();
                }

                if (message.toolCall?.functionCalls) {
                  console.log(`[live] Processing ${message.toolCall.functionCalls.length} tool call(s)`);
                  for (const fc of message.toolCall.functionCalls) {
                    const toolCallId = fc.id ?? crypto.randomUUID();
                    const toolName = fc.name ?? "unknown";
                    console.log(`[live] Tool call: ${toolName} (id=${toolCallId}) args=${JSON.stringify(fc.args)}`);
                    sendToClient(ws, { type: "tool_start", toolName, toolCallId });

                    const abortController = new AbortController();
                    pendingToolCalls.set(toolCallId, abortController);

                    void (async () => {
                      try {
                        if (toolName === "search_products") {
                          // Concurrency cap: abort previous in-flight search
                          if (activeSearchToolCallId) {
                            const prev = pendingToolCalls.get(activeSearchToolCallId);
                            if (prev) {
                              prev.abort();
                              pendingToolCalls.delete(activeSearchToolCallId);
                            }
                            sendToClient(ws, { type: "tool_cancelled", toolCallId: activeSearchToolCallId });
                          }
                          activeSearchToolCallId = toolCallId;

                          const args = (fc.args ?? {}) as Record<string, unknown>;
                          const query = String(args.query ?? "");
                          const marketplaceFilter = args.marketplace_filter ? String(args.marketplace_filter) : undefined;

                          // Extract original product info from initial context (prefer currentProduct, fall back to focusedProduct)
                          const currentProduct = (initialContext.currentProduct ?? initialContext.focusedProduct) as Record<string, unknown> | undefined;
                          const originalPrice = typeof currentProduct?.price === "number" ? currentProduct.price : undefined;
                          const originalCurrency = typeof currentProduct?.currency === "string" ? currentProduct.currency : undefined;
                          const sourceUrl = typeof currentProduct?.productUrl === "string" ? currentProduct.productUrl : undefined;
                          const sourceMarketplace = typeof currentProduct?.marketplace === "string" ? currentProduct.marketplace : undefined;

                          const results = await executeVoiceSearch(query, {
                            marketplaceFilter,
                            originalPrice,
                            originalCurrency,
                            sourceUrl,
                            sourceMarketplace,
                            signal: abortController.signal,
                          });

                          accumulatedResults = [...accumulatedResults, ...results];
                          sendToClient(ws, { type: "tool_result", toolName, toolCallId, results });

                          const resultText = results.length > 0
                            ? `Found ${results.length} results:\n` + results.map((r, i) =>
                                `#${i + 1} "${r.result.title}" on ${r.result.marketplace} — ${r.result.currency ?? "USD"} ${r.result.price ?? "price unavailable"}${r.savingsPercent && r.savingsPercent > 0 ? ` (${r.savingsPercent}% savings)` : ""}`
                              ).join("\n")
                            : "No results found for that search.";

                          session.sendToolResponse({
                            functionResponses: [{
                              id: toolCallId,
                              name: toolName,
                              response: { results: resultText },
                              scheduling: FunctionResponseScheduling.WHEN_IDLE,
                            }],
                          });
                        } else if (toolName === "compare_prices") {
                          const allResults = [...initialResults, ...accumulatedResults];
                          const currentProduct = (initialContext.currentProduct ?? initialContext.focusedProduct) as Record<string, unknown> | undefined;
                          const originalPrice = typeof currentProduct?.price === "number" ? currentProduct.price : null;

                          let comparison: string;
                          if (allResults.length === 0) {
                            comparison = "No results available to compare.";
                          } else {
                            const sorted = [...allResults].sort((a, b) => (a.result.price ?? Infinity) - (b.result.price ?? Infinity));
                            comparison = `Price comparison (${sorted.length} items):\n` + sorted.map((r, i) => {
                              const price = r.result.price !== null ? `${r.result.currency ?? "USD"} ${r.result.price}` : "price unavailable";
                              let savings = "";
                              if (originalPrice && r.result.price !== null) {
                                const diff = Math.round(((originalPrice - r.result.price) / originalPrice) * 100);
                                savings = diff > 0 ? ` (${diff}% cheaper)` : diff < 0 ? ` (${Math.abs(diff)}% more expensive)` : ` (same price)`;
                              }
                              return `#${i + 1} "${r.result.title}" on ${r.result.marketplace} — ${price}${savings}`;
                            }).join("\n");
                          }

                          sendToClient(ws, { type: "tool_done", toolCallId });

                          session.sendToolResponse({
                            functionResponses: [{
                              id: toolCallId,
                              name: toolName,
                              response: { comparison },
                              scheduling: FunctionResponseScheduling.WHEN_IDLE,
                            }],
                          });
                        }
                      } catch (err) {
                        console.error(`[live] Tool ${toolName} failed:`, err);
                        sendToClient(ws, { type: "tool_done", toolCallId });
                        try {
                          session.sendToolResponse({
                            functionResponses: [{
                              id: toolCallId,
                              name: toolName,
                              response: { error: `Search failed — ${err instanceof Error ? err.message : "unknown error"}` },
                              scheduling: FunctionResponseScheduling.WHEN_IDLE,
                            }],
                          });
                        } catch {
                          // Session already closed
                        }
                      } finally {
                        pendingToolCalls.delete(toolCallId);
                        if (activeSearchToolCallId === toolCallId) {
                          activeSearchToolCallId = null;
                        }
                      }
                    })();
                  }
                }

                if (message.toolCallCancellation?.ids) {
                  for (const id of message.toolCallCancellation.ids) {
                    const controller = pendingToolCalls.get(id);
                    if (controller) {
                      controller.abort();
                      pendingToolCalls.delete(id);
                    }
                    sendToClient(ws, { type: "tool_cancelled", toolCallId: id });
                  }
                }
              },
              onerror(event: { message?: string }) {
                console.error("[live] Upstream error:", event.message ?? event);
                setupReject?.(new Error(event.message ?? "Upstream error"));
                sendToClient(ws, {
                  type: "error",
                  message: "Voice service error",
                });
              },
              onclose(event: { code: number; reason: string; wasClean: boolean }) {
                console.log(
                  `[live] Upstream session closed — code=${event.code} reason=${JSON.stringify(event.reason)} clean=${event.wasClean}`,
                );
                setupReject?.(new Error(`Session closed before setup (code ${event.code})`));
                upstream = null;
                cleanupTimer();
                // If the client connection is still alive, notify it and close.
                // Without this the client is left in a zombie state where all
                // subsequent messages hit the "no upstream" guard.
                if (!closed) {
                  closed = true;
                  sendToClient(ws, {
                    type: "error",
                    message: `Voice session disconnected (code ${event.code})`,
                  });
                  ws.close();
                }
              },
            },
          });

          if (closed) {
            session.close();
            return;
          }

          upstream = session;

          // Wait for Gemini to finish processing the session config.
          // Sending content before setupComplete can cause the server to
          // drop the connection silently.
          try {
            await setupPromise;
          } catch (err) {
            // Session closed or errored before setup — onclose already
            // notified the client, so just bail out.
            console.error("[live] Setup failed:", err);
            return;
          }

          if (closed) return;

          // Send product context as a user message (keeps system prompt injection-free)
          const contextData = message.context;
          if (contextData && (contextData.focusedProduct || contextData.currentProduct || contextData.results)) {
            const contextText = buildVoiceContextTurnText(contextData);
            session.sendClientContent({
              turns: [{ role: "user", parts: [{ text: contextText }] }],
              turnComplete: true,
            });
          }

          // Parse initial results for compare_prices tool
          initialContext = contextData ?? {};
          const allResultsRaw = contextData?.allResults;
          if (Array.isArray(allResultsRaw)) {
            initialResults = allResultsRaw as RankedResult[];
          } else {
            // results field contains text summaries, not RankedResult objects.
            // compare_prices will only use voice-discovered results until frontend sends allResults.
            initialResults = [];
          }

          sendToClient(ws, { type: "ready" });

          sessionTimer = setTimeout(() => {
            console.log("[live] Server-side session timeout reached");
            sendToClient(ws, {
              type: "error",
              message: "Voice session time limit reached",
            });
            closed = true;
            if (upstream) {
              upstream.close();
              upstream = null;
            }
            ws.close();
          }, VOICE_SESSION_MAX_MS);

        } catch (err) {
          console.error("[live] Failed to open upstream session:", err);
          sendToClient(ws, {
            type: "error",
            message: "Failed to start voice session",
          });
        }
        return;
      }

      if (!configReceived || !upstream) {
        sendToClient(ws, {
          type: "error",
          message: configReceived
            ? "Voice session disconnected"
            : "Send config message first",
        });
        return;
      }

      try {
        if (message.type === "audio") {
          upstream.sendRealtimeInput({
            audio: {
              data: message.data,
              mimeType: `audio/pcm;rate=${message.sampleRateHz}`,
            },
          });
          return;
        }

        if (message.type === "text") {
          upstream.sendClientContent({
            turns: [{ role: "user", parts: [{ text: message.content }] }],
            turnComplete: true,
          });
          return;
        }

        if (message.type === "audioStreamEnd") {
          upstream.sendRealtimeInput({ audioStreamEnd: true });
          return;
        }
      } catch (err) {
        // Upstream may have closed between our null-check and the send call
        console.error("[live] Failed to forward to upstream:", err);
        return;
      }
    },

    onClose() {
      console.log("[live] Client disconnected");
      closed = true;
      cleanupTimer();
      for (const [, controller] of pendingToolCalls) {
        controller.abort();
      }
      pendingToolCalls.clear();
      if (upstream) {
        upstream.close();
        upstream = null;
      }
    },

    onError(evt) {
      console.error("[live] Client WS error:", evt);
      closed = true;
      cleanupTimer();
      for (const [, controller] of pendingToolCalls) {
        controller.abort();
      }
      pendingToolCalls.clear();
      if (upstream) {
        upstream.close();
        upstream = null;
      }
    },
  };
}
