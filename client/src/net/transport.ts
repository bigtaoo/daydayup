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
  /**
   * Register a handler for an unrecoverable transport failure (socket error, or a
   * close the caller didn't itself request via `close()`) — optional so every
   * pre-existing fake `Transport` (tests) stays a valid implementer unchanged.
   * `connectOnlineSession` is the one production caller: before this existed, a bad
   * ticket or a dropped connection was completely unobservable (no throw, no reject,
   * no callback anywhere), so the client just hung on a blank `playing` screen forever.
   */
  onDisconnect?(handler: (reason: string) => void): void;
}

/** Browser WebSocket transport. Buffers outbound messages until the socket opens. */
export class WebSocketTransport implements Transport {
  private readonly ws: WebSocket;
  private handler: ((msg: ServerMsg) => void) | null = null;
  private disconnectHandler: ((reason: string) => void) | null = null;
  private readonly outbox: string[] = [];
  private open = false;
  private closedByUs = false;
  // Set the instant this socket is no longer usable — by our own close(), a close
  // event, or an error — and never unset. `close()` sets it SYNCHRONOUSLY (not just in
  // the eventual 'close' event listener) because a caller-requested close doesn't wait
  // for the handshake to finish before this transport is considered done: a `send()`
  // that was merely QUEUED before close() (e.g. behind LaggyTransport's own setTimeout
  // delay) must not reach the socket once close() has already been called, even though
  // the real 'close' event hasn't fired yet.
  private dead = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      if (this.dead) return; // closed/errored before the handshake even finished
      this.open = true;
      for (const s of this.outbox) this.ws.send(s);
      this.outbox.length = 0;
    });
    this.ws.addEventListener('message', (ev) => {
      if (!this.handler) return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return; // genuinely malformed frame — nothing to hand the caller
      }
      // Deliberately OUTSIDE the try/catch above: that one exists only for bad JSON.
      // A bug inside the handler itself (NetInputSource.onFrameBatch etc.) must not be
      // swallowed the same way — it needs to surface (console/error reporting) so a
      // silently-stalled client is at least diagnosable instead of indistinguishable
      // from a malformed frame.
      this.handler(msg);
    });
    this.ws.addEventListener('error', () => {
      this.dead = true;
      this.disconnectHandler?.('socket error');
    });
    this.ws.addEventListener('close', (ev) => {
      this.dead = true;
      this.outbox.length = 0; // nothing left to flush — the socket is gone
      if (this.closedByUs) return; // a caller-requested close() is not a failure
      // Structurally typed (not `CloseEvent`) — this file is reachable from server's
      // compilation graph too via the shared `@dd/net/*` path alias (tsconfig.base.json),
      // whose Node lib has no DOM globals; a `code` field exists on both DOM's
      // `CloseEvent` and Node's own WebSocket close event without naming either type.
      const code = (ev as { code?: number }).code;
      this.disconnectHandler?.(`socket closed (${code ?? 'unknown'})`);
    });
  }

  send(msg: ClientMsg): void {
    if (this.dead) return; // the socket is gone — silently drop instead of touching it further
    const s = JSON.stringify(msg);
    if (this.open) this.ws.send(s);
    else this.outbox.push(s); // flushed on open
  }

  onMessage(handler: (msg: ServerMsg) => void): void {
    this.handler = handler;
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandler = handler;
  }

  close(): void {
    this.closedByUs = true;
    this.dead = true;
    this.ws.close();
  }
}

/**
 * A latency-injecting Transport decorator (ROADMAP 3.3 follow-up) — delays every outbound
 * send AND every inbound message by `lagMs`, so a one-way `lagMs` becomes a ~2×lagMs RTT.
 * A DEV harness (the `?lag=` toggle in Game.ts) to see + tune local-player prediction on one
 * machine without real devices; design/06 leaves the prediction smoothing constants to tune
 * against real RTT, and this is the practical stand-in. Not used in production paths.
 */
export class LaggyTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly lagMs: number,
  ) {}
  send(msg: ClientMsg): void {
    setTimeout(() => this.inner.send(msg), this.lagMs);
  }
  onMessage(handler: (msg: ServerMsg) => void): void {
    this.inner.onMessage((msg) => setTimeout(() => handler(msg), this.lagMs));
  }
  onDisconnect(handler: (reason: string) => void): void {
    this.inner.onDisconnect?.(handler); // not itself delayed — a real failure shouldn't hide behind lag
  }
  close(): void {
    this.inner.close();
  }
}
