/**
 * WebSocketTransport / LaggyTransport (design/06, ROADMAP 3.1; error/close handling
 * added for design/10's Matchmaking screen). Drives against a fake global `WebSocket`
 * (this repo's plain-node vitest has no real WebSocket) so the open/message/error/close
 * wiring is testable without a real socket — this file previously had no tests at all,
 * since nothing exercised the disconnect path before it existed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketTransport, LaggyTransport, type Transport } from './transport';
import type { ClientMsg, ServerMsg } from '@dd/engine';

type Listener = (ev?: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    /* the real socket then fires its own 'close' event asynchronously — tests trigger
     * that explicitly via fireClose() to mirror the two-step real-browser sequence. */
  }
  fireOpen(): void {
    for (const fn of this.listeners.open ?? []) fn();
  }
  fireMessage(raw: string): void {
    for (const fn of this.listeners.message ?? []) fn({ data: raw });
  }
  fireError(): void {
    for (const fn of this.listeners.error ?? []) fn();
  }
  fireClose(code?: number): void {
    for (const fn of this.listeners.close ?? []) fn({ code });
  }
}

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const JOIN: ClientMsg = { type: 'join', roomId: 'r', owner: 0, seed: 1, playerCount: 1 };
const MATCH_START: ServerMsg = { type: 'match_start', seed: 1, startFrame: 0, localOwner: 0, playerCount: 1 };

describe('WebSocketTransport — sending', () => {
  it('buffers sends until the socket opens, then flushes in order', () => {
    const t = new WebSocketTransport('ws://x');
    t.send(JOIN);
    expect(lastSocket().sent).toEqual([]);
    lastSocket().fireOpen();
    expect(lastSocket().sent).toEqual([JSON.stringify(JOIN)]);
  });

  it('sends immediately once already open', () => {
    const t = new WebSocketTransport('ws://x');
    lastSocket().fireOpen();
    t.send(JOIN);
    expect(lastSocket().sent).toEqual([JSON.stringify(JOIN)]);
  });
});

describe('WebSocketTransport — receiving', () => {
  it('decodes and dispatches a message to the registered handler', () => {
    const t = new WebSocketTransport('ws://x');
    const received: ServerMsg[] = [];
    t.onMessage((m) => received.push(m));
    lastSocket().fireMessage(JSON.stringify(MATCH_START));
    expect(received).toEqual([MATCH_START]);
  });

  it('silently ignores a malformed frame instead of throwing', () => {
    const t = new WebSocketTransport('ws://x');
    let called = false;
    t.onMessage(() => { called = true; });
    expect(() => lastSocket().fireMessage('{not json')).not.toThrow();
    expect(called).toBe(false);
  });

  it('does nothing if a message arrives before onMessage is ever registered', () => {
    const t = new WebSocketTransport('ws://x');
    void t;
    expect(() => lastSocket().fireMessage(JSON.stringify(MATCH_START))).not.toThrow();
  });

  it('a well-formed message that makes the HANDLER itself throw is NOT swallowed the same way a malformed frame is', () => {
    const t = new WebSocketTransport('ws://x');
    t.onMessage(() => {
      throw new Error('bug inside NetInputSource.onFrameBatch or similar');
    });
    // JSON.parse succeeds here — only ITS failures are meant to be silently ignored;
    // a handler bug on well-formed input must actually surface, not vanish into the
    // same catch used for bad JSON.
    expect(() => lastSocket().fireMessage(JSON.stringify(MATCH_START))).toThrow(/bug inside/);
  });
});

describe('WebSocketTransport — disconnect (design/10 Matchmaking screen)', () => {
  it('fires onDisconnect on a socket error', () => {
    const t = new WebSocketTransport('ws://x');
    const reasons: string[] = [];
    t.onDisconnect((r) => reasons.push(r));
    lastSocket().fireError();
    expect(reasons).toEqual(['socket error']);
  });

  it('fires onDisconnect on an unrequested close, including the close code', () => {
    const t = new WebSocketTransport('ws://x');
    const reasons: string[] = [];
    t.onDisconnect((r) => reasons.push(r));
    lastSocket().fireClose(4401);
    expect(reasons).toEqual(['socket closed (4401)']);
  });

  it('falls back to "unknown" when the close event carries no code', () => {
    const t = new WebSocketTransport('ws://x');
    const reasons: string[] = [];
    t.onDisconnect((r) => reasons.push(r));
    lastSocket().fireClose(undefined);
    expect(reasons).toEqual(['socket closed (unknown)']);
  });

  it('does NOT fire onDisconnect for a close the caller itself requested via close()', () => {
    const t = new WebSocketTransport('ws://x');
    const reasons: string[] = [];
    t.onDisconnect((r) => reasons.push(r));
    t.close();
    lastSocket().fireClose(1000); // the real socket's close event still fires after close()
    expect(reasons).toEqual([]);
  });

  it('is a no-op if onDisconnect was never registered (never throws on error/close)', () => {
    const t = new WebSocketTransport('ws://x');
    void t;
    expect(() => lastSocket().fireError()).not.toThrow();
    expect(() => lastSocket().fireClose(1006)).not.toThrow();
  });
});

describe('WebSocketTransport — invalidation after close/error (a late send never touches the dead socket)', () => {
  it('a send() called after close() never reaches the underlying socket', () => {
    const t = new WebSocketTransport('ws://x');
    lastSocket().fireOpen();
    t.close();
    t.send(JOIN); // e.g. a LaggyTransport-delayed send whose timer fires after close()
    expect(lastSocket().sent).toEqual([]);
  });

  it('a send() queued before close() but flushed after it is dropped, not sent late', () => {
    const t = new WebSocketTransport('ws://x'); // never opened — send() queues into the outbox
    t.send(JOIN);
    t.close();
    lastSocket().fireOpen(); // the handshake happened to complete after close() was called
    expect(lastSocket().sent).toEqual([]); // the queued send must NOT flush onto a dead socket
  });

  it('a send() called after a socket error never reaches the underlying socket', () => {
    const t = new WebSocketTransport('ws://x');
    lastSocket().fireOpen();
    lastSocket().fireError();
    t.send(JOIN);
    expect(lastSocket().sent).toEqual([]);
  });

  it('a send() called after an unrequested close never reaches the underlying socket', () => {
    const t = new WebSocketTransport('ws://x');
    lastSocket().fireOpen();
    lastSocket().fireClose(1006);
    t.send(JOIN);
    expect(lastSocket().sent).toEqual([]);
  });

  it('close() is still reported as caller-requested even though it also marks the transport dead', () => {
    const t = new WebSocketTransport('ws://x');
    const reasons: string[] = [];
    t.onDisconnect((r) => reasons.push(r));
    t.close();
    t.send(JOIN); // dropped, not thrown
    lastSocket().fireClose(1000);
    expect(reasons).toEqual([]); // unchanged from the existing close()-suppresses-onDisconnect behavior
  });
});

describe('LaggyTransport — passthrough (design/06 ?lag= dev harness)', () => {
  function fakeInner() {
    const send = vi.fn();
    const onMessage = vi.fn();
    const onDisconnect = vi.fn();
    const close = vi.fn();
    const inner: Transport = { send, onMessage, onDisconnect, close };
    return { inner, send, onMessage, onDisconnect, close };
  }

  it('delays an outbound send by lagMs', () => {
    vi.useFakeTimers();
    const { inner, send } = fakeInner();
    const lag = new LaggyTransport(inner, 100);
    lag.send(JOIN);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith(JOIN);
    vi.useRealTimers();
  });

  it('delays an inbound message by lagMs', () => {
    vi.useFakeTimers();
    const { inner, onMessage } = fakeInner();
    const lag = new LaggyTransport(inner, 50);
    const received: ServerMsg[] = [];
    lag.onMessage((m) => received.push(m));
    const innerHandler = onMessage.mock.calls[0]![0] as (m: ServerMsg) => void;
    innerHandler(MATCH_START);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(received).toEqual([MATCH_START]);
    vi.useRealTimers();
  });

  it('does NOT delay onDisconnect — a real failure must surface immediately even under injected lag', () => {
    const { inner, onDisconnect } = fakeInner();
    const lag = new LaggyTransport(inner, 100);
    const handler = vi.fn();
    lag.onDisconnect(handler);
    expect(onDisconnect).toHaveBeenCalledWith(handler); // registered directly, no wrapping
  });

  it('close() passes straight through to the inner transport', () => {
    const { inner, close } = fakeInner();
    const lag = new LaggyTransport(inner, 100);
    lag.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
