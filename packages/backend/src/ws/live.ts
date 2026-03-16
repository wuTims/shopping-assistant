import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { Modality } from "@google/genai";
import type { Session, LiveServerMessage } from "@google/genai";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";
import { VOICE_SESSION_MAX_MS } from "@shopping-assistant/shared";
import { ai, liveModel } from "../services/ai-client.js";

function buildSystemInstruction(): string {
  return (
    "You are a helpful shopping assistant. The user is browsing a product online " +
    "and has found search results for cheaper alternatives. Help them compare options, " +
    "answer questions about products, and make purchase decisions. Be concise and conversational."
  );
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
          const session = await ai.live.connect({
            model: liveModel,
            config: {
              responseModalities: [Modality.AUDIO],
              systemInstruction: { parts: [{ text: systemInstruction }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
            callbacks: {
              onopen() {
                console.log("[live] Upstream session opened");
              },
              onmessage(message: LiveServerMessage) {
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
                }
              },
              onerror(event: { message?: string }) {
                console.error("[live] Upstream error:", event.message ?? event);
                sendToClient(ws, {
                  type: "error",
                  message: "Voice service error",
                });
              },
              onclose() {
                console.log("[live] Upstream session closed");
                upstream = null;
                cleanupTimer();
              },
            },
          });

          if (closed) {
            session.close();
            return;
          }

          upstream = session;

          // Send product context as a user message (keeps system prompt injection-free)
          const contextData = message.context;
          if (contextData && (contextData.product || contextData.results)) {
            const contextParts: string[] = [];
            if (contextData.product) {
              contextParts.push(`Current product the user is viewing: ${JSON.stringify(contextData.product)}`);
            }
            if (contextData.results && Array.isArray(contextData.results) && contextData.results.length > 0) {
              const top = contextData.results.slice(0, 5);
              contextParts.push(`Top search results found:\n${JSON.stringify(top)}`);
            }
            session.sendClientContent({
              turns: [{ role: "user", parts: [{ text: contextParts.join("\n\n") }] }],
              turnComplete: true,
            });
          }

          sendToClient(ws, { type: "ready" });

          sessionTimer = setTimeout(() => {
            console.log("[live] Server-side session timeout reached");
            sendToClient(ws, {
              type: "error",
              message: "Voice session time limit reached",
            });
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
          message: "Send config message first",
        });
        return;
      }

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
    },

    onClose() {
      console.log("[live] Client disconnected");
      closed = true;
      cleanupTimer();
      if (upstream) {
        upstream.close();
        upstream = null;
      }
    },

    onError(evt) {
      console.error("[live] Client WS error:", evt);
      closed = true;
      cleanupTimer();
      if (upstream) {
        upstream.close();
        upstream = null;
      }
    },
  };
}
