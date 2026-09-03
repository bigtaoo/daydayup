/**
 * `WsTransport` — the socket half of BotClient.ts, over a REAL `ws` server on an ephemeral
 * port. Sibling to `BotClient.test.ts`, which drives the bot's logic through an injected
 * in-process `Transport` and therefore never touches this class at all.
 *
 * That split is why this file exists. Until 2026-09-03 `WsTransport` was at **0% in every
 * suite in the repo** while `BotClient.test.ts` read as a thorough end-to-end test — the
 * classic shape where an injected fake makes the seam it replaces invisible. Everything here
 * fails SILENTLY in production if it breaks: a bot whose `join` is dropped never appears in
 * the match, and nothing logs, throws, or fails a health check. The match just runs a seat
 * short until the metronome stalls waiting for a player that never arrives.
 *
 * The outbox is the load-bearing one. `CoopSession` sends `join` from its constructor, which
 * runs while `new WebSocket(url)` is still CONNECTING — so on a real socket EVERY bot's first
 * message goes through the buffer-and-flush path, and the `open` flag is the only thing that
 * decides between buffering it and calling `ws.send` on a socket that throws.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '@dd/engine';
import { WsTransport } from '../src/BotClient';

/** A `ws` server that records what it receives and can push raw frames back.
 *
 * Async because `wss.address()` is null until the 'listening' event — reading the port
 * synchronously yields `ws://127.0.0.1:undefined`, which does not fail loudly; it just never
 * connects, and every case in this file times out identically. */
async function startServer(): Promise<{
  url: string;
  received: string[];
  socket: () => WsSocket | undefined;
  connected: Promise<void>;
  close: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const received: string[] = [];
  let sock: WsSocket | undefined;
  let announce: () => void;
  const connected = new Promise<void>((resolve) => {
    announce = resolve;
  });
  wss.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (d: Buffer) => received.push(d.toString('utf8')));
    announce();
  });
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    socket: () => sock,
    connected,
    // `wss.close(cb)` does NOT call back while a client socket is still attached, so the
    // clients are terminated first. Without that, a failing assertion inside the `try` gets
    // swallowed: the `finally` hangs, and the case reports vitest's generic 5 s timeout
    // instead of the message that says what actually went wrong.
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

const join = (): ClientMsg => ({ type: 'join', roomId: 'r1', owner: 1, seed: 7, playerCount: 2 });

/** Resolves once `pred` holds or the budget runs out — a real socket is asynchronous. */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the socket');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const openTransports: WsTransport[] = [];
function connect(url: string): WsTransport {
  const t = new WsTransport(url);
  openTransports.push(t);
  return t;
}

afterEach(() => {
  for (const t of openTransports.splice(0)) t.close();
});

describe('WsTransport — outbound', () => {
  it('BUFFERS a message sent before the socket opens, then flushes it in order on open', async () => {
    // The path every real bot takes: CoopSession's constructor sends `join` while the socket
    // is still CONNECTING. If the outbox were dropped (or `send` called straight through) the
    // bot would silently never join, and the match would stall a seat short.
    const srv = await startServer();
    try {
      const t = connect(srv.url);
      t.send(join());
      t.send({ type: 'result', stateHash: 1234, winner: 0 } as ClientMsg);
      expect(srv.received).toEqual([]); // nothing can have gone out yet — still connecting

      await until(() => srv.received.length === 2);
      expect(srv.received.map((s) => JSON.parse(s).type)).toEqual(['join', 'result']);
    } finally {
      await srv.close();
    }
  });

  it('sends straight through once open, with no second copy of the flushed backlog', async () => {
    const srv = await startServer();
    try {
      const t = connect(srv.url);
      t.send(join());
      await until(() => srv.received.length === 1);

      t.send({ type: 'result', stateHash: 99, winner: 0 } as ClientMsg);
      await until(() => srv.received.length === 2);
      // The outbox is cleared on flush, so the backlog must not reappear behind the new
      // message — a `length = 0` that ran before the loop would show up here as a 3rd frame.
      await new Promise((r) => setTimeout(r, 30));
      expect(srv.received).toHaveLength(2);
      expect(JSON.parse(srv.received[1]!).stateHash).toBe(99);
    } finally {
      await srv.close();
    }
  });
});

describe('WsTransport — inbound', () => {
  it('parses a server frame and hands it to the registered handler', async () => {
    const srv = await startServer();
    try {
      const t = connect(srv.url);
      const seen: ServerMsg[] = [];
      t.onMessage((m) => seen.push(m));
      await srv.connected;

      srv.socket()!.send(JSON.stringify({ type: 'match_start', seed: 7, playerCount: 2 }));
      await until(() => seen.length === 1);
      expect(seen[0]).toMatchObject({ type: 'match_start', seed: 7 });
    } finally {
      await srv.close();
    }
  });

  it('SWALLOWS a malformed frame and keeps the socket usable', async () => {
    // A throw inside a `ws` 'message' listener takes the whole connection down, so this
    // catch is what stops one bad frame from removing the bot from the match. The assertion
    // that matters is the second half: a good frame still arrives afterwards.
    const srv = await startServer();
    try {
      const t = connect(srv.url);
      const seen: ServerMsg[] = [];
      t.onMessage((m) => seen.push(m));
      await srv.connected;

      srv.socket()!.send('{not json');
      srv.socket()!.send(JSON.stringify({ type: 'match_start', seed: 1, playerCount: 1 }));
      await until(() => seen.length === 1);
      expect(seen).toHaveLength(1); // the malformed one produced nothing, and threw nothing
    } finally {
      await srv.close();
    }
  });

  it('drops a frame that arrives before onMessage is wired, without throwing', async () => {
    // `runBotClient` constructs the transport and CoopSession registers the handler a tick
    // later; a frame in that window hits the `!this.handler` guard.
    const srv = await startServer();
    try {
      const t = connect(srv.url);
      await srv.connected;
      srv.socket()!.send(JSON.stringify({ type: 'match_start', seed: 1, playerCount: 1 }));
      await new Promise((r) => setTimeout(r, 30));

      const seen: ServerMsg[] = [];
      t.onMessage((m) => seen.push(m));
      srv.socket()!.send(JSON.stringify({ type: 'match_start', seed: 2, playerCount: 1 }));
      await until(() => seen.length === 1);
      expect(seen).toHaveLength(1); // only the one sent after the handler was wired
    } finally {
      await srv.close();
    }
  });
});

describe('WsTransport — socket failure does not kill the process', () => {
  // The bug this pair pins, found 2026-09-03 by writing the cases above: `WsTransport`
  // registered listeners for 'open' and 'message' and none for 'error'. In Node an 'error'
  // event with no listener is an UNCAUGHT EXCEPTION, so either case below used to take the
  // whole matchsvc process down — matchmaking, parties, accounts and the ladder along with
  // the one bot seat that failed. Neither is exotic: the first is matchsvc outliving a
  // gameserver restart (the normal deploy order), the second is `stop()` landing inside the
  // connect window.
  //
  // `process.on('uncaughtException')` is what makes this observable at all — an
  // unhandled 'error' does not reject a promise or fail an assertion, it terminates the
  // worker, which vitest reports as an unrelated crash somewhere else entirely.
  function watchForUncaught(): { hits: Error[]; stop: () => void } {
    const hits: Error[] = [];
    const onUncaught = (e: Error): void => {
      hits.push(e);
    };
    process.on('uncaughtException', onUncaught);
    return { hits, stop: () => void process.off('uncaughtException', onUncaught) };
  }

  it('survives an UNREACHABLE gameserver instead of crashing matchsvc', async () => {
    const watch = watchForUncaught();
    try {
      // Port 1 is privileged and unbound: the connect fails with ECONNREFUSED.
      const t = new WsTransport('ws://127.0.0.1:1/ws?ticket=x');
      await new Promise((r) => setTimeout(r, 300));
      expect(watch.hits.map((e) => e.message)).toEqual([]);
      t.close();
    } finally {
      watch.stop();
    }
  });

  it('survives close() called while the socket is still CONNECTING', async () => {
    const srv = await startServer();
    const watch = watchForUncaught();
    try {
      const t = new WsTransport(srv.url);
      t.close(); // same tick — the handshake cannot possibly have completed
      await new Promise((r) => setTimeout(r, 300));
      expect(watch.hits.map((e) => e.message)).toEqual([]);
    } finally {
      watch.stop();
      await srv.close();
    }
  });
});

describe('WsTransport — close', () => {
  it('closes the underlying socket, which the server observes', async () => {
    const srv = await startServer();
    try {
      const t = connect(srv.url);
      await srv.connected;
      let closed = false;
      srv.socket()!.on('close', () => {
        closed = true;
      });
      t.close();
      await until(() => closed);
      expect(closed).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
