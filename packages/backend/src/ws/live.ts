import type { WSContext, WSEvents } from "hono/ws";
import type { WsClientMessage, WsServerMessage } from "@shopping-assistant/shared";

// Gemini Live API WebSocket proxy
// TODO: Implement upstream Gemini Live API session management

export function liveWebSocket(c: unknown): WSEvents {
  return {
    onOpen(_evt, ws) {
      console.log("[ws] Client connected");
    },

    onMessage(evt, ws) {
      const message = JSON.parse(String(evt.data)) as WsClientMessage;
      console.log("[ws] Received:", message.type);

      // TODO: Forward to Gemini Live API upstream session
      if (message.type === "text") {
        const response: WsServerMessage = {
          type: "transcript",
          content: "Live API proxy not yet implemented.",
        };
        ws.send(JSON.stringify(response));
      }
    },

    onClose() {
      console.log("[ws] Client disconnected");
    },
  };
}
