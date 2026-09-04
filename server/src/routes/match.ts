/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the matchmaking
 * route group (ROADMAP 3.3, design/06): the poll-based find API (`POST /find`,
 * `GET /find/:queueId`) and the reconnect reissue (`POST /resume`).
 *
 * Pure wiring around the pure `Matchmaker`: the clock, the seed/roomId source and the
 * bot-fill hook all stay in `matchsvc.ts`'s `createMatchsvcServer`, which hands this group
 * only the built matchmaker, the ticket secret, and the `withUrl` decorator that stamps the
 * gameserver's WS URL onto an issued ticket.
 */
import type { Matchmaker, MatchTicket } from '../Matchmaker';
import { signTicket, verifyTicket, type MatchMode, type TicketPayload } from '../ticket';
import { readJson, send, type RouteHandler } from './http';

export interface MatchRouteDeps {
  matchmaker: Matchmaker;
  /** Stamps the gameserver WS URL a ticket is redeemed against onto an issued ticket. */
  withUrl: (t: MatchTicket) => MatchTicket & { wsUrl: string };
  /** The ticket-signing secret — `/resume` both verifies and re-signs with it. */
  secret: string;
}

// A reconnect ticket only needs to outlive the client opening the socket with it, not
// the whole match (unlike the original match ticket, which the client redeems once
// right after `/find` resolves) — same window `onBotFill` already grants a bot ticket.
const RESUME_TICKET_TTL_MS = 30_000;

/** `GET /find/:queueId` — the poll half of the find API. */
export const FIND_POLL_PATH = /^\/find\/([^/]+)$/;

export const postFind: RouteHandler<MatchRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
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
      const { queueId, ticket } = deps.matchmaker.enqueue(playerCount, mode, groupId, accountId);
      send(res, 200, { queueId, match: ticket ? deps.withUrl(ticket) : undefined });
    } catch (e) {
      send(res, 400, { error: (e as Error).message });
    }
  });
};

export const getFindPoll: RouteHandler<MatchRouteDeps> = (_req, res, url, deps) => {
  const queueId = decodeURIComponent(url.pathname.match(FIND_POLL_PATH)![1]!);
  const result = deps.matchmaker.poll(queueId);
  send(res, 200, result.status === 'matched' ? { status: 'matched', match: deps.withUrl(result.ticket) } : result);
};

/**
 * Reconnect (ROADMAP reconnect, design/06): mint a fresh, short-lived ticket for the
 * SAME seat grant a now-expired ticket once named, so a mid-match disconnect (which
 * by definition happens well after the original 30s ticket TTL) can redeem a new one
 * on the gameserver instead of being stuck forever. `ignoreExpiry` is the only
 * difference from the normal handshake check — the signature still has to verify,
 * so this can't mint a ticket for a seat the caller was never actually granted.
 * Whether the room itself is still alive/in-match is the gameserver's call (`resume`
 * there fails cleanly if it isn't); matchsvc has no visibility into live room state.
 */
export const postResume: RouteHandler<MatchRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const token = (body as { token?: unknown })?.token;
    if (typeof token !== 'string' || !token) return send(res, 400, { error: 'token required' });
    const payload = verifyTicket(token, deps.secret, Date.now(), { ignoreExpiry: true });
    if (!payload) return send(res, 401, { error: 'invalid ticket' });
    const fresh: TicketPayload = { ...payload, exp: Date.now() + RESUME_TICKET_TTL_MS };
    const ticket: MatchTicket = {
      roomId: fresh.roomId,
      owner: fresh.owner,
      seed: fresh.seed,
      playerCount: fresh.playerCount,
      teamId: fresh.teamId,
      mode: fresh.mode ?? 'coop',
      token: signTicket(fresh, deps.secret),
    };
    send(res, 200, { match: deps.withUrl(ticket) });
  });
};
