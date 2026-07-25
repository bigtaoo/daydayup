/**
 * gameserver bootstrap (design/06, ROADMAP 3.1) — the co-op frame-broadcast data plane.
 * The ONLY file that touches the socket layer: it wraps each WebSocket as a
 * RoomConnection and provides the real-timer Scheduler, then hands everything to the
 * pure RoomManager / MatchRoom lifecycle (which the tests drive with fakes).
 *
 * Handshake: a client connects to `/ws?roomId=..&owner=..&seed=..&count=..` (owner =
 * the seat it drives). This is the minimal launch handshake — a real deployment would
 * front it with a matchmaking/ticket service (funny's matchsvc) that signs these
 * params; that control plane is out of scope for the co-op net layer (design/06
 * "where the frame-broadcast server lives" is an open question).
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

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '', `ws://${req.headers.host}`);
    const roomId = url.searchParams.get('roomId') ?? '';
    const owner = Number(url.searchParams.get('owner'));
    const seed = Number(url.searchParams.get('seed'));
    const count = Number(url.searchParams.get('count'));
    if (!roomId || !Number.isInteger(owner) || !Number.isInteger(seed) || !Number.isInteger(count) || count < 1) {
      ws.close(4400, 'bad handshake');
      return;
    }

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
