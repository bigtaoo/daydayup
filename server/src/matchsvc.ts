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
 *   POST /auth/register     { username, password }        → { accountId, username, token } | 400
 *   POST /auth/login        { username, password }        → { accountId, username, token } | 401
 *   POST /auth/logout       { token }                      → { ok: true }
 *   GET  /auth/me           (Bearer token)                 → { accountId, username } | 401
 *   POST /auth/change-password { token, oldPassword, newPassword } → { ok: true } | 400/401
 *   GET  /account/meta      (Bearer token)                 → { data: MetaState | null } | 401
 *   POST /account/meta      (Bearer token) { data }        → { ok: true } | 400/401
 *   GET  /health
 *
 * Party endpoints (design/05/15's PvP squad follow-up) back `PartyService` — pure
 * pre-match grouping. A `playerId` is whatever opaque string the client sends; once a
 * player is logged in (design/16-accounts.md) the client sends its real `accountId` as
 * `playerId` here, but this file still doesn't verify it — the account layer only
 * gates the `/auth/*` and `/account/*` routes themselves.
 *
 * `/auth/*` and `/account/*` (design/16-accounts.md) are this project's first real
 * account system — `AuthService` owns a SQLite-backed (`node:sqlite`) accounts/sessions
 * store; every `/account/*` route requires a live session via `Authorization: Bearer
 * <token>`, checked by the local `requireAuth` helper below.
 *
 * `match` = { wsUrl, roomId, owner, seed, playerCount, token } — everything the client
 * needs to open `${wsUrl}?ticket=${token}` (see client/src/net/matchmaking.ts).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Matchmaker, type MatchTicket } from './Matchmaker';
import { RatingStore } from './rating';
import { PartyService } from './PartyService';
import { signTicket, type MatchMode, type TicketPayload } from './ticket';
import { ticketSecret, teamIdForOwner } from './config';
import { spawnBotClient } from './BotClient';
import { openDb } from './db';
import { AuthService } from './AuthService';

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
  // 'authorization' (design/16-accounts.md) — every /auth/me and /account/* call sends
  // a bearer token; omitting it here makes the browser's CORS preflight reject the
  // real request before it's even sent (fails as a bare "Failed to fetch", no server
  // log at all — caught live via claude-in-chrome, not by any unit test, since node's
  // fetch/undici and curl don't enforce browser CORS preflight rules).
  'access-control-allow-headers': 'content-type, authorization',
};

export interface MatchsvcServerOptions {
  /** DB path override (design/16-accounts.md) — tests pass `':memory:'` for isolation;
   * defaults to `openDb`'s own real-file default. */
  dbPath?: string;
  /** Ticket-signing secret override — tests can pin a fixed value; defaults to `ticketSecret()`. */
  secret?: string;
}

/**
 * Builds the matchsvc HTTP server WITHOUT starting it (`server.listen()` is the
 * caller's job) — the seam that makes this file testable. `main()` below is the real
 * CLI entrypoint; `server/test/matchsvc.http.test.ts` calls this directly and binds an
 * ephemeral port instead, so real HTTP requests (including a real CORS preflight) can
 * be asserted without a network stub — the exact layer that let design/16-accounts.md's
 * missing-`authorization`-header CORS bug slip past every other test.
 */
export function createMatchsvcServer(opts: MatchsvcServerOptions = {}): Server {
  const secret = opts.secret ?? ticketSecret().secret;
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
  const db = openDb(opts.dbPath);
  const auth = new AuthService(db);

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
        // The logged-in caller's real account id (design/16-accounts.md), if any —
        // absent for guests/bots, in which case ladderReport.ts falls back to its
        // seat:{roomId}:{seatIdx} scaffold. Never verified against a live session here
        // (matchsvc trusts it exactly as much as playerCount/mode already were); the
        // account layer's trust boundary is `/auth/*`/`/account/*`, not `/find`.
        const rawAccountId = (body as { accountId?: unknown })?.accountId;
        const accountId = typeof rawAccountId === 'string' && rawAccountId ? rawAccountId : undefined;
        try {
          const { queueId, ticket } = matchmaker.enqueue(playerCount, mode, groupId, accountId);
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

    // Accounts (design/16-accounts.md) — this project's first real login system.
    if (req.method === 'POST' && url.pathname === '/auth/register') {
      return readJson(req, (body) => {
        const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
        const result = auth.register(username, password);
        send(res, 'error' in result ? 400 : 200, result);
      });
    }

    if (req.method === 'POST' && url.pathname === '/auth/login') {
      return readJson(req, (body) => {
        const { username, password } = (body as { username?: unknown; password?: unknown }) ?? {};
        const result = auth.login(username, password);
        send(res, 'error' in result ? 401 : 200, result);
      });
    }

    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      return readJson(req, (body) => {
        const token = (body as { token?: unknown })?.token;
        if (typeof token === 'string') auth.logout(token);
        send(res, 200, { ok: true });
      });
    }

    if (req.method === 'GET' && url.pathname === '/auth/me') {
      const session = requireAuth(req, auth);
      if (!session) return send(res, 401, { error: 'invalid or expired session' });
      return send(res, 200, session);
    }

    if (req.method === 'POST' && url.pathname === '/auth/change-password') {
      return readJson(req, (body) => {
        const { token, oldPassword, newPassword } =
          (body as { token?: unknown; oldPassword?: unknown; newPassword?: unknown }) ?? {};
        const session = auth.verifySession(token);
        if (!session) return send(res, 401, { error: 'invalid or expired session' });
        const result = auth.changePassword(session.accountId, oldPassword, newPassword);
        send(res, 'error' in result ? 400 : 200, result);
      });
    }

    // Account-bound meta state (design/16-accounts.md, ROADMAP 2.x's blueprint/loadout
    // persistence) — the client's `MetaState` (blueprints/materials/loadout), previously
    // localStorage-only, mirrored here once a player is logged in.
    if (req.method === 'GET' && url.pathname === '/account/meta') {
      const session = requireAuth(req, auth);
      if (!session) return send(res, 401, { error: 'invalid or expired session' });
      const row = db.prepare('SELECT data FROM meta_state WHERE account_id = ?').get(session.accountId) as
        | { data: string }
        | undefined;
      return send(res, 200, { data: row ? (JSON.parse(row.data) as unknown) : null });
    }

    if (req.method === 'POST' && url.pathname === '/account/meta') {
      const session = requireAuth(req, auth);
      if (!session) return send(res, 401, { error: 'invalid or expired session' });
      return readJson(req, (body) => {
        const data = (body as { data?: unknown })?.data;
        if (data === undefined) return send(res, 400, { error: 'data required' });
        db.prepare(
          'INSERT INTO meta_state (account_id, data) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data',
        ).run(session.accountId, JSON.stringify(data));
        send(res, 200, { ok: true });
      });
    }

    send(res, 404, { error: 'not found' });
  });

  return server;
}

function main(): void {
  const server = createMatchsvcServer();
  server.listen(PORT, HOST, () => {
    console.log(`daydayup matchsvc (control plane) on http://${HOST}:${PORT}  → ${GAMESERVER_URL}`);
  });
}

/** Parses `Authorization: Bearer <token>` and resolves it to a live session, or `null`. */
function requireAuth(req: IncomingMessage, auth: AuthService): { accountId: string; username: string } | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return auth.verifySession(header.slice('Bearer '.length));
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

// Only auto-start when run directly (`node --import tsx/esm src/matchsvc.ts`), not when
// imported by a test — the ESM equivalent of `require.main === module`, needed now that
// `createMatchsvcServer` is a real importable export (design/16-accounts.md).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
