// Client transport for online co-op (design/06, ROADMAP 3.1). The Transport interface
// is the seam CoopSession drives; WebSocketTransport is the browser implementation and
// the ONLY place a real socket appears, so the session logic stays headless-testable
// (a fake Transport feeds it in tests). Wire format mirrors the server: newline-free
// JSON, ClientMsg out / ServerMsg in (server/README.md).
import type { ClientMsg, ServerMsg } from '@dd/engine';

export interface Transport {
  send(msg: ClientMsg): void;
  /** Register the handler for decoded server messages. Called once by CoopSession. */
  onMessage(handler: (msg: ServerMsg) => void): void;
  close(): void;
}

/** Browser WebSocket transport. Buffers outbound messages until the socket opens. */
export class WebSocketTransport implements Transport {
  private readonly ws: WebSocket;
  private handler: ((msg: ServerMsg) => void) | null = null;
  private readonly outbox: string[] = [];
  private open = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      this.open = true;
      for (const s of this.outbox) this.ws.send(s);
      this.outbox.length = 0;
    });
    this.ws.addEventListener('message', (ev) => {
      if (!this.handler) return;
      try {
        this.handler(JSON.parse(String(ev.data)) as ServerMsg);
      } catch {
        /* ignore malformed frames */
      }
    });
  }

  send(msg: ClientMsg): void {
    const s = JSON.stringify(msg);
    if (this.open) this.ws.send(s);
    else this.outbox.push(s); // flushed on open
  }

  onMessage(handler: (msg: ServerMsg) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.ws.close();
  }
}
