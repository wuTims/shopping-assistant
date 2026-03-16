import { vi } from "vitest";

export class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((evt: unknown) => void) | null = null;
  send = vi.fn((payload: string) => {
    const message = JSON.parse(payload) as { type?: string };
    if (message.type === "config") {
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ type: "ready" }) });
      }, 0);
    }
  });
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  constructor() {
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
}
