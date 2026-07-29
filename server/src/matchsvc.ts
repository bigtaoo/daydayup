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
 *   POST /find             { playerCount, mode?, partyId? } → { queueId, match? }
 *   GET  /find/:id                                       → { status: 'queued'|'matched'|'expired', match? }
 *   POST /rating/report     { accountIds, places }       → { changes: [{accountId,before,after}] }
 *   GET  /rating/:accountId                               → { accountId, rating }
 *   POST /party/create      { playerId }                 → PartyInfo
 *   POST /party/join        { playerId, code }           → PartyInfo | 404
 *   POST /party/leave       { partyId, playerId }        → PartyInfo | null
 *   POST /party/start       { partyId, playerId }        → PartyInfo | 404 (leader only)
 *   GET  /party/:id                                       → PartyInfo | 404
 *   GET  /health
 *
 * Party endpoints (design/05/15's PvP squad follow-up) back `PartyService` — pure
 * pre-match grouping with no account system underneath (none exists anywhere in this
 * project, see `rating.ts`'s own note). A `playerId` is whatever opaque string the
 * client generates and persists locally; nothing here verifies it.
 *
 * `match` = { wsUrl, roomId, owner, seed, playerCount, token } — everything the client
 * needs to open `${wsUrl}?ticket=${token}` (see client/src/net/matchmaking.ts).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Matchmaker, type MatchTicket } from './Matchmaker';
import { RatingStore } from './rating';
import { PartyService } from './PartyService';
import { signTicket, type MatchMode, type TicketPayload } from './ticket';
import { ticketSecret, teamIdForOwner } from './config';
import { spawnBotClient } from './BotClient';

// A short, human-typeable join code — unambiguous alphabet (no 0/O/1/I) since a
// player reads/types this to a friend, not a machine.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

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
    // PvP practice-bot backfill (design/15 follow-up): a queue that's sat too long forms
    // anyway with bots filling the empty seats. A bot redeems its own freshly-signed
    // ticket and opens the SAME ticket-authenticated gameserver socket a real player
    // would (BotClient.ts) — matchsvc is the trusted issuer, so it can mint one directly
    // without a round trip through its own /find queue.
    onBotFill: ({ roomId, seed, playerCount, mode, botOwners }) => {
      for (const owner of botOwners) {
        const exp = Date.now() + 30_000; // ample time for the bot to open the socket
        // teamIdForOwner is the SAME pure function Matchmaker.grantGroup used for the
        // real seats in this room — a bot always joins the squad chunk its seat index
        // falls into, topping up a real party's understaffed squad first.
        const teamId = teamIdForOwner(owner, playerCount);
        const grant: TicketPayload = { roomId, owner, seed, playerCount, teamId, exp, mode };
        spawnBotClient({
          wsUrl: GAMESERVER_URL,
          token: signTicket(grant, secret),
          roomId,
          owner,
          seed,
          playerCount,
        });
      }
    },
  });

  const withUrl = (t: MatchTicket) => ({ ...t, wsUrl: GAMESERVER_URL });
  const ratings = new RatingStore();
  const parties = new PartyService({
    nowMs: () => Date.now(),
    newPartyId: () => randomUUID(),
    newCode: randomCode,
  });

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
        // A pre-formed party (design/05/15) — every member's client sends the SAME
        // partyId once their leader starts matching, so Matchmaker groups them into
        // one squad chunk. Absent (every pre-party caller) → plain FIFO, unaffected.
        const rawGroupId = (body as { partyId?: unknown })?.partyId;
        const groupId = typeof rawGroupId === 'string' && rawGroupId ? rawGroupId : undefined;
        try {
          const { queueId, ticket } = matchmaker.enqueue(playerCount, mode, groupId);
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

    if (req.method === 'POST' && url.pathname === '/party/create') {
      return readJson(req, (body) => {
        const playerId = (body as { playerId?: unknown })?.playerId;
        if (typeof playerId !== 'string' || !playerId) return send(res, 400, { error: 'playerId required' });
        send(res, 200, parties.create(playerId));
      });
    }

    if (req.method === 'POST' && url.pathname === '/party/join') {
      return readJson(req, (body) => {
        const { playerId, code } = (body as { playerId?: unknown; code?: unknown }) ?? {};
        if (typeof playerId !== 'string' || !playerId || typeof code !== 'string' || !code) {
          return send(res, 400, { error: 'playerId and code required' });
        }
        const info = parties.join(code, playerId);
        if (!info) return send(res, 404, { error: 'party not found or full' });
        send(res, 200, info);
      });
    }

    if (req.method === 'POST' && url.pathname === '/party/leave') {
      return readJson(req, (body) => {
        const { partyId, playerId } = (body as { partyId?: unknown; playerId?: unknown }) ?? {};
        if (typeof partyId !== 'string' || typeof playerId !== 'string') {
          return send(res, 400, { error: 'partyId and playerId required' });
        }
        send(res, 200, parties.leave(partyId, playerId));
      });
    }

    if (req.method === 'POST' && url.pathname === '/party/start') {
      return readJson(req, (body) => {
        const { partyId, playerId } = (body as { partyId?: unknown; playerId?: unknown }) ?? {};
        if (typeof partyId !== 'string' || typeof playerId !== 'string') {
          return send(res, 400, { error: 'partyId and playerId required' });
        }
        const info = parties.startMatching(partyId, playerId);
        if (!info) return send(res, 404, { error: 'party not found or not leader' });
        send(res, 200, info);
      });
    }

    const partyLookup = url.pathname.match(/^\/party\/([^/]+)$/);
    if (req.method === 'GET' && partyLookup) {
      const info = parties.get(decodeURIComponent(partyLookup[1]!));
      if (!info) return send(res, 404, { error: 'party not found' });
      return send(res, 200, info);
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
