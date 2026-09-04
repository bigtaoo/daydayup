/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/rating/*`
 * route group (design/15, ROADMAP 4.6): the settled-match report the gameserver POSTs once
 * a PvP match resolves with a checkpoint/hash-verified placement result (never the client
 * directly; the gameserver is the one that knows `hashOk`), plus the per-account lookup.
 *
 * ROADMAP 8.1 (2026-09-04) landed here: `POST /rating/report` is now behind
 * `internalAuth.ts`'s timing-safe `x-internal-key`, closing design/19's D1 — the route had
 * no key, no origin check and open CORS while being the one endpoint that can move any
 * account's ladder rating, so anyone could POST an arbitrary placement for an arbitrary
 * `accountId`. `GET /rating/:accountId` is deliberately NOT gated: it is a public read of a
 * player's own visible rank, and it writes nothing.
 */
import type { RatingStore } from '../rating';
import { internalKeys } from '../config';
import {
  createInternalVerifier,
  describeInternalAuthFailure,
  type InternalVerifier,
} from '../internalAuth';
import { readJson, send, type RouteHandler } from './http';

export interface RatingRouteDeps {
  ratings: RatingStore;
  /**
   * Internal-key verifier override. OPTIONAL, and the default is not "no auth" — it is a
   * verifier built from `config.ts`'s env-derived registry, so a caller that wires nothing
   * (which is every caller today: `matchsvc.ts` builds one untyped `deps` bundle for all
   * five route groups) still gets the real check. The seam exists so a test can pin a
   * registry without touching `process.env`, the same way `MatchsvcServerOptions.secret`
   * pins the ticket secret.
   */
  internalAuth?: InternalVerifier;
}

/** `GET /rating/:accountId` — checked after `POST /rating/report`, which it would shadow. */
export const RATING_LOOKUP_PATH = /^\/rating\/([^/]+)$/;

export const postReport: RouteHandler<RatingRouteDeps> = (req, res, _url, deps) => {
  const verifier = deps.internalAuth ?? createInternalVerifier(internalKeys().registry);
  const auth = verifier.verify(req.headers);
  if (!auth.ok) {
    // The rejection is logged and the response is not: the caller learns only "unauthorized",
    // while the reason (and the caller's own advisory, untrusted `x-internal-caller` claim)
    // goes to the operator — design/19 §7's "log every event, not just the successful one",
    // applied to the seam that is worth watching first.
    console.warn(describeInternalAuthFailure(auth, 'POST /rating/report'));
    return send(res, 401, { error: 'unauthorized' });
  }

  readJson(req, (body) => {
    const { accountIds, places, teamIds } =
      (body as { accountIds?: unknown; places?: unknown; teamIds?: unknown }) ?? {};
    if (!Array.isArray(accountIds) || !Array.isArray(places) || accountIds.length !== places.length) {
      return send(res, 400, { error: 'accountIds and places must be equal-length arrays' });
    }
    if (teamIds !== undefined && (!Array.isArray(teamIds) || teamIds.length !== accountIds.length)) {
      return send(res, 400, { error: 'teamIds, if present, must be the same length as accountIds' });
    }
    const changes = deps.ratings.applyMatch(
      accountIds as string[],
      places as number[],
      teamIds as number[] | undefined,
    );
    send(res, 200, { changes });
  });
};

export const getRating: RouteHandler<RatingRouteDeps> = (_req, res, url, deps) => {
  const accountId = decodeURIComponent(url.pathname.match(RATING_LOOKUP_PATH)![1]!);
  send(res, 200, { accountId, rating: deps.ratings.get(accountId) });
};
