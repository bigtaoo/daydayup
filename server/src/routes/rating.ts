/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/rating/*`
 * route group (design/15, ROADMAP 4.6): the settled-match report the gameserver POSTs once
 * a PvP match resolves with a checkpoint/hash-verified placement result (never the client
 * directly; the gameserver is the one that knows `hashOk`), plus the per-account lookup.
 *
 * ROADMAP 8.1 is the pass that puts `server/src/internalAuth`'s timing-safe `x-internal-key`
 * in front of `POST /rating/report`, which today has no authentication at all — this file is
 * the seam it lands in. The split itself changes nothing about that: the route is exactly as
 * open as it was.
 */
import type { RatingStore } from '../rating';
import { readJson, send, type RouteHandler } from './http';

export interface RatingRouteDeps {
  ratings: RatingStore;
}

/** `GET /rating/:accountId` — checked after `POST /rating/report`, which it would shadow. */
export const RATING_LOOKUP_PATH = /^\/rating\/([^/]+)$/;

export const postReport: RouteHandler<RatingRouteDeps> = (req, res, _url, deps) => {
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
