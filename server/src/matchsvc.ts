/**
 * matchsvc (ROADMAP 3.3, design/06) — the matchmaking control plane's HTTP entrypoint.
 * The ONLY control-plane file that touches node:http, exactly as index.ts is the only
 * data-plane file that touches `ws`: it wraps the pure Matchmaker with a real clock, a
 * seed/roomId source, and the shared ticket signer, and exposes the poll-based find API.
 * It also owns the PvP ladder rating store (design/15, ROADMAP 4.6) — matchsvc-side
 * account bookkeeping, entirely separate from `@dd/engine`'s replicated/replay state.
 *
 * A separate process from the WS gameserver (own port, MATCH_PORT default 8788) — the
 * clean control/data split funny uses. The client calls this to get a signed seat ticket,
 * then opens the gameserver socket with it (`/ws?ticket=`). The gameserver calls back
 * into `/rating/report` once a PvP match settles with a checkpoint/hash-verified
 * placement result (design/15's "computed from checkpoint-verified match placements
 * only") — see `MatchRoomDeps.onSettled` (MatchRoom.ts) and its wiring in index.ts.
 *
 *   POST /find             { playerCount }              → { queueId, match? }
 *   GET  /find/:id                                       → { status: 'queued'|'matched'|'expired', match? }
 *   POST /rating/report     { accountIds, places }       → { changes: [{accountId,before,after}] }
 *   GET  /rating/:accountId                               → { accountId, rating }
 *   GET  /health
 *
 * `match` = { wsUrl, roomId, owner, seed, playerCount, token } — everything the client
 * needs to open `${wsUrl}?ticket=${token}` (see client/src/net/matchmaking.ts).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Matchmaker, type MatchTicket } from './Matchmaker';
import { RatingStore } from './rating';
import { signTicket, type MatchMode } from './ticket';
import { ticketSecret } from './config';

const PORT = Number(process.env.MATCH_PORT ?? 8788);
const HOST = process.env.HOST ?? '0.0.0.0';
// The WS data-plane URL the issued ticket is redeemed against (the client appends ?ticket=).
const GAMESERVER_URL = process.env.DDU_GAMESERVER_URL ?? 'ws://localhost:8787/ws';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function main(): void {
  const { secret } = ticketSecret();
  // Seeds only need to differ per room (the engine derives all determinism from seed +
  // inputs); a counter off the start time avoids Math.random and cross-restart collision.
  let seedCounter = Date.now() & 0x7fffffff;
  const matchmaker = new Matchmaker({
    nowMs: () => Date.now(),
    nextSeed: () => (seedCounter = (seedCounter + 1) & 0x7fffffff),
    newRoomId: () => randomUUID(),
    sign: (payload) => signTicket(payload, secret),
  });

  const withUrl = (t: MatchTicket) => ({ ...t, wsUrl: GAMESERVER_URL });
  const ratings = new RatingStore();

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true, service: 'daydayup-matchsvc' });
    }

    if (req.method === 'POST' && url.pathname === '/find') {
      return readJson(req, (body) => {
        const playerCount = Number((body as { playerCount?: unknown })?.playerCount);
        // 'pvp' opts into the battle-royale queue (design/15); anything else (absent,
        // 'coop', a typo) is the pre-existing co-op shape — never silently 400s a client
        // that predates this field.
        const rawMode = (body as { mode?: unknown })?.mode;
        const mode: MatchMode = rawMode === 'pvp' ? 'pvp' : 'coop';
        try {
          const { queueId, ticket } = matchmaker.enqueue(playerCount, mode);
          send(res, 200, { queueId, match: ticket ? withUrl(ticket) : undefined });
        } catch (e) {
          send(res, 400, { error: (e as Error).message });
        }
      });
    }

    // GET /find/:queueId
    const findMatch = url.pathname.match(/^\/find\/([^/]+)$/);
    if (req.method === 'GET' && findMatch) {
      const result = matchmaker.poll(decodeURIComponent(findMatch[1]!));
      return send(res, 200, result.status === 'matched' ? { status: 'matched', match: withUrl(result.ticket) } : result);
    }

    // Ladder rating (design/15, ROADMAP 4.6) — called by the gameserver once a PvP
    // match settles with a checkpoint/hash-verified placement result (never by the
    // client directly; the gameserver is the one that knows `hashOk`).
    if (req.method === 'POST' && url.pathname === '/rating/report') {
      return readJson(req, (body) => {
        const { accountIds, places } = (body as { accountIds?: unknown; places?: unknown }) ?? {};
        if (!Array.isArray(accountIds) || !Array.isArray(places) || accountIds.length !== places.length) {
          return send(res, 400, { error: 'accountIds and places must be equal-length arrays' });
        }
        const changes = ratings.applyMatch(accountIds as string[], places as number[]);
        send(res, 200, { changes });
      });
    }

    const ratingLookup = url.pathname.match(/^\/rating\/([^/]+)$/);
    if (req.method === 'GET' && ratingLookup) {
      const accountId = decodeURIComponent(ratingLookup[1]!);
      return send(res, 200, { accountId, rating: ratings.get(accountId) });
    }

    send(res, 404, { error: 'not found' });
  });

  server.listen(PORT, HOST, () => {
    console.log(`daydayup matchsvc (control plane) on http://${HOST}:${PORT}  → ${GAMESERVER_URL}`);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' });
  res.end(json);
}

/** Read a JSON request body (bounded), then invoke `done`. Malformed/oversized → {}. */
function readJson(req: IncomingMessage, done: (body: unknown) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > 4096) return; // a find request is tiny; ignore the overflow tail
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
    } catch {
      done({});
    }
  });
  req.on('error', () => done({}));
}

main();
