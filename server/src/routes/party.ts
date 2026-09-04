/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/party/*` route
 * group (design/05/15's PvP squad follow-up): pure pre-match grouping over `PartyService`,
 * plus the human-typeable join-code generator `matchsvc.ts` constructs that service with.
 *
 * A `playerId` is whatever opaque string the client sends; once a player is logged in
 * (design/16-accounts.md) the client sends its real `accountId` as `playerId` here, but
 * nothing in this group verifies it — the account layer only gates `/auth/*` and
 * `/account/*` themselves.
 */
import type { PartyService } from '../PartyService';
import { readJson, send, type RouteHandler } from './http';

export interface PartyRouteDeps {
  parties: PartyService;
}

// A short, human-typeable join code — unambiguous alphabet (no 0/O/1/I) since a
// player reads/types this to a friend, not a machine.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/** `GET /party/:partyId` — checked after the `POST /party/*` routes it would shadow. */
export const PARTY_LOOKUP_PATH = /^\/party\/([^/]+)$/;

export const postCreate: RouteHandler<PartyRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const playerId = (body as { playerId?: unknown })?.playerId;
    if (typeof playerId !== 'string' || !playerId) return send(res, 400, { error: 'playerId required' });
    send(res, 200, deps.parties.create(playerId));
  });
};

export const postJoin: RouteHandler<PartyRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { playerId, code } = (body as { playerId?: unknown; code?: unknown }) ?? {};
    if (typeof playerId !== 'string' || !playerId || typeof code !== 'string' || !code) {
      return send(res, 400, { error: 'playerId and code required' });
    }
    const info = deps.parties.join(code, playerId);
    if (!info) return send(res, 404, { error: 'party not found or full' });
    send(res, 200, info);
  });
};

export const postLeave: RouteHandler<PartyRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { partyId, playerId } = (body as { partyId?: unknown; playerId?: unknown }) ?? {};
    if (typeof partyId !== 'string' || typeof playerId !== 'string') {
      return send(res, 400, { error: 'partyId and playerId required' });
    }
    send(res, 200, deps.parties.leave(partyId, playerId));
  });
};

export const postStart: RouteHandler<PartyRouteDeps> = (req, res, _url, deps) => {
  readJson(req, (body) => {
    const { partyId, playerId } = (body as { partyId?: unknown; playerId?: unknown }) ?? {};
    if (typeof partyId !== 'string' || typeof playerId !== 'string') {
      return send(res, 400, { error: 'partyId and playerId required' });
    }
    const info = deps.parties.startMatching(partyId, playerId);
    if (!info) return send(res, 404, { error: 'party not found or not leader' });
    send(res, 200, info);
  });
};

export const getParty: RouteHandler<PartyRouteDeps> = (_req, res, url, deps) => {
  const info = deps.parties.get(decodeURIComponent(url.pathname.match(PARTY_LOOKUP_PATH)![1]!));
  if (!info) return send(res, 404, { error: 'party not found' });
  send(res, 200, info);
};
