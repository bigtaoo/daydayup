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
 * Since the 2026-09-04 P0 split (prep for ROADMAP Phase 8, which adds routes to three of
 * these groups) this file is the ASSEMBLY SHELL only: it builds the services, owns the
 * dispatch chain below, and nothing else. Every handler is a free `(req, res, url, deps)`
 * function under `routes/`, grouped by surface — CLAUDE.md's split form 1 (independent
 * function modules), which is what a linear if/else chain over shared-nothing handlers
 * wants. Per-route documentation lives with each handler; the map is:
 *
 *   POST /find             { playerCount, mode?, partyId? } -> { queueId, match? }    routes/match
 *   GET  /find/:id                                       -> { status: 'queued'|'matched'|'expired', match? }
 *   POST /resume            { token }                     -> { match } | 401 (ROADMAP reconnect)
 *   POST /rating/report     { accountIds, places, teamIds? } -> { changes: [{accountId,before,after}] }
 *   GET  /rating/:accountId                               -> { accountId, rating }    routes/rating
 *   POST /party/create      { playerId }                 -> PartyInfo                 routes/party
 *   POST /party/join        { playerId, code }           -> PartyInfo | 404
 *   POST /party/leave       { partyId, playerId }        -> PartyInfo | null
 *   POST /party/start       { partyId, playerId }        -> PartyInfo | 404 (leader only)
 *   GET  /party/:id                                       -> PartyInfo | 404
 *   POST /auth/register     { username, password }        -> { accountId, username, token } | 400
 *   POST /auth/login        { username, password }        -> { accountId, username, token } | 401
 *   POST /auth/logout       { token }                      -> { ok: true }             routes/auth
 *   GET  /auth/me           (Bearer token)                 -> { accountId, username } | 401
 *   POST /auth/change-password { token, oldPassword, newPassword } -> { ok: true } | 400/401
 *   GET  /account/meta      (Bearer token)  -> { data: MetaState | null, entitlements } | 401
 *   POST /account/meta      (Bearer token) { data }        -> { ok: true } | 400/401    routes/account
 *   GET  /health                                                                       (here)
 *
 * `/auth/*` and `/account/*` (design/16-accounts.md) are this project's first real
 * account system — `AuthService` owns a SQLite-backed (`node:sqlite`) accounts/sessions
 * store; every `/account/*` route requires a live session via `Authorization: Bearer
 * <token>`, checked by `requireAuth` in `routes/auth.ts`.
 *
 * `match` = { wsUrl, roomId, owner, seed, playerCount, token } — everything the client
 * needs to open `${wsUrl}?ticket=${token}` (see client/src/net/matchmaking.ts).
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Matchmaker, type MatchTicket } from './Matchmaker';
import { RatingStore } from './rating';
import { PartyService } from './PartyService';
import { signTicket, type TicketPayload } from './ticket';
import { ticketSecret, teamIdForOwner } from './config';
import { spawnBotClient } from './BotClient';
import { openDb } from './db';
import { AuthService } from './AuthService';
import { send } from './routes/http';
import * as matchRoutes from './routes/match';
import * as ratingRoutes from './routes/rating';
import * as partyRoutes from './routes/party';
import * as authRoutes from './routes/auth';
import * as accountRoutes from './routes/account';

const PORT = Number(process.env.MATCH_PORT ?? 8788);
const HOST = process.env.HOST ?? '0.0.0.0';
// The WS data-plane URL the issued ticket is redeemed against (the client appends ?ticket=).
const GAMESERVER_URL = process.env.DDU_GAMESERVER_URL ?? 'ws://localhost:8787/ws';

export interface MatchsvcServerOptions {
  /** DB path override (design/16-accounts.md) — tests pass `':memory:'` for isolation;
   * defaults to `openDb`'s own real-file default. */
  dbPath?: string;
  /** Ticket-signing secret override — tests can pin a fixed value; defaults to `ticketSecret()`. */
  secret?: string;
  /**
   * Matchmaker timing overrides. The only reason this exists is `pvpBotFillMs`: PvP bot
   * backfill is a 30-SECOND wait by default, so `onBotFill` below — the block that mints a
   * ticket per empty seat and is the entire PvP-with-bots path players actually hit — could
   * not be reached by any test at a sane runtime, and was at 0% until 2026-09-03.
   */
  matchmaker?: { pvpBotFillMs?: number; queueTtlMs?: number; ticketTtlMs?: number };
  /**
   * Bot spawner seam, defaulting to the real `spawnBotClient` (which opens a socket to
   * GAMESERVER_URL). Injected so a test can assert WHAT was minted for each empty seat —
   * the seat's owner index, its team, the signature — without standing up a gameserver.
   * The interesting logic here is `teamIdForOwner`, which decides whether a bot tops up a
   * real party's understaffed squad or starts a new one, and it is invisible from outside.
   */
  spawnBot?: typeof spawnBotClient;
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
  const spawnBot = opts.spawnBot ?? spawnBotClient;
  const matchmaker = new Matchmaker({
    ...opts.matchmaker,
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
        spawnBot({
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
  const db = openDb(opts.dbPath);
  const ratings = new RatingStore(db);
  const parties = new PartyService({
    nowMs: () => Date.now(),
    newPartyId: () => randomUUID(),
    newCode: partyRoutes.randomCode,
  });
  const auth = new AuthService(db);

  // One bundle satisfying each route group's own narrow `*RouteDeps` interface. The groups
  // share no state, so this is a wiring convenience, not a shared context object — a
  // handler still declares (and can only reach) the few dependencies it names.
  const deps = { matchmaker, withUrl, secret, ratings, parties, auth, db };

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, { ok: true, service: 'daydayup-matchsvc' });
    }

    if (req.method === 'POST' && path === '/find') return matchRoutes.postFind(req, res, url, deps);
    if (req.method === 'GET' && matchRoutes.FIND_POLL_PATH.test(path)) {
      return matchRoutes.getFindPoll(req, res, url, deps);
    }
    if (req.method === 'POST' && path === '/resume') return matchRoutes.postResume(req, res, url, deps);

    if (req.method === 'POST' && path === '/rating/report') return ratingRoutes.postReport(req, res, url, deps);
    if (req.method === 'GET' && ratingRoutes.RATING_LOOKUP_PATH.test(path)) {
      return ratingRoutes.getRating(req, res, url, deps);
    }

    if (req.method === 'POST' && path === '/party/create') return partyRoutes.postCreate(req, res, url, deps);
    if (req.method === 'POST' && path === '/party/join') return partyRoutes.postJoin(req, res, url, deps);
    if (req.method === 'POST' && path === '/party/leave') return partyRoutes.postLeave(req, res, url, deps);
    if (req.method === 'POST' && path === '/party/start') return partyRoutes.postStart(req, res, url, deps);
    if (req.method === 'GET' && partyRoutes.PARTY_LOOKUP_PATH.test(path)) {
      return partyRoutes.getParty(req, res, url, deps);
    }

    if (req.method === 'POST' && path === '/auth/register') return authRoutes.postRegister(req, res, url, deps);
    if (req.method === 'POST' && path === '/auth/login') return authRoutes.postLogin(req, res, url, deps);
    if (req.method === 'POST' && path === '/auth/logout') return authRoutes.postLogout(req, res, url, deps);
    if (req.method === 'GET' && path === '/auth/me') return authRoutes.getMe(req, res, url, deps);
    if (req.method === 'POST' && path === '/auth/change-password') {
      return authRoutes.postChangePassword(req, res, url, deps);
    }

    if (req.method === 'GET' && path === '/account/meta') return accountRoutes.getMeta(req, res, url, deps);
    if (req.method === 'POST' && path === '/account/meta') return accountRoutes.postMeta(req, res, url, deps);

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

// Only auto-start when run directly (`node --import tsx/esm src/matchsvc.ts`), not when
// imported by a test — the ESM equivalent of `require.main === module`, needed now that
// `createMatchsvcServer` is a real importable export (design/16-accounts.md).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
