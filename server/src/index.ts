/**
 * gameserver bootstrap (design/06, ROADMAP 3.1) — the co-op frame-broadcast data plane.
 * The ONLY file that touches the socket layer: it wraps each WebSocket as a
 * RoomConnection and provides the real-timer Scheduler, then hands everything to the
 * pure RoomManager / MatchRoom lifecycle (which the tests drive with fakes).
 *
 * Handshake (ROADMAP 3.3): a client connects with a signed ticket — `/ws?ticket=<token>`
 * — issued by the matchmaking control plane (matchsvc.ts). The gameserver derives the
 * trusted `{roomId, owner, seed, playerCount}` from the VERIFIED ticket, never from raw
 * query params, so a client can no longer claim another seat or a different seed.
 * A real `DDU_TICKET_SECRET` makes a valid ticket mandatory (invalid/absent → 4401);
 * with no secret set (pure local dev) the legacy raw-param handshake
 * (`/ws?roomId=..&owner=..&seed=..&count=..`) is still accepted for manual testing.
 *
 * Wire format: newline-free JSON per message (ClientMsg in, ServerMsg out). PlayerCommand
 * is already compact plain data, so JSON is fine for the co-op MVP; a WeChat/production
 * build would swap in a binary codec behind this same seam.
 */
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '@dd/engine';
import { RoomManager } from './RoomManager';
import type { RoomConnection } from './MatchRoom';
import { verifyTicket } from './ticket';
import { ticketSecret } from './config';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';

/** A live socket presented to the room layer as a seat sink. */
class SocketConnection implements RoomConnection {
  constructor(
    readonly owner: number,
    readonly roomId: string,
    private readonly ws: WebSocket,
  ) {}
  send(msg: ServerMsg): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

interface Seat {
  roomId: string;
  owner: number;
  seed: number;
  count: number;
}

/**
 * Resolve the trusted seat for a handshake. A `?ticket=` is verified and its payload is
 * authoritative (the spoof-proof path). With no configured secret (dev), a ticketless
 * connection may fall back to the legacy raw params; once a real secret is set a valid
 * ticket is required. Returns null → close the socket.
 */
function resolveSeat(url: URL, secret: string, isDev: boolean): Seat | null {
  const token = url.searchParams.get('ticket');
  if (token) {
    const payload = verifyTicket(token, secret, Date.now());
    if (!payload) return null;
    return { roomId: payload.roomId, owner: payload.owner, seed: payload.seed, count: payload.playerCount };
  }
  if (!isDev) return null; // a configured secret ⇒ ticket mandatory

  // Legacy dev handshake: raw params, trusted only because no secret is configured.
  const roomId = url.searchParams.get('roomId') ?? '';
  const owner = Number(url.searchParams.get('owner'));
  const seed = Number(url.searchParams.get('seed'));
  const count = Number(url.searchParams.get('count'));
  if (!roomId || !Number.isInteger(owner) || !Number.isInteger(seed) || !Number.isInteger(count) || count < 1) {
    return null;
  }
  return { roomId, owner, seed, count };
}

function main(): void {
  const manager = new RoomManager({
    // Node timers are the metronome clock in production; the tests inject a fake.
    scheduler: {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
  });

  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'daydayup-gameserver' }));
      return;
    }
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('Upgrade Required');
  });
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  const { secret, isDev } = ticketSecret();

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', `ws://${req.headers.host}`);
    const seat = resolveSeat(url, secret, isDev);
    if (!seat) {
      // A configured secret makes a ticket mandatory; dev-with-no-secret also lands here
      // only for a malformed legacy handshake.
      ws.close(4401, 'invalid or missing ticket');
      return;
    }
    const { roomId, owner, seed, count } = seat;

    const conn = new SocketConnection(owner, roomId, ws);
    const seated = manager.join(conn, roomId, seed, count);
    if (!seated) {
      ws.close(4403, 'seat unavailable / room mismatch');
      return;
    }

    ws.on('message', (data: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString('utf8')) as ClientMsg;
      } catch {
        return; // ignore malformed frames
      }
      manager.handle(conn, roomId, msg);
    });
    ws.on('close', () => manager.onClose(conn, roomId));
    ws.on('error', () => {
      /* the close event fires next; nothing extra to do */
    });
  });

  const shutdown = (): void => {
    manager.destroyAll();
    wss.close();
    http.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  http.listen(PORT, HOST, () => {
    console.log(`daydayup gameserver (co-op frame relay) on ws://${HOST}:${PORT}/ws`);
  });
}

main();
