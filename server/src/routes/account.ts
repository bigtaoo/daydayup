/**
 * Split of `matchsvc.ts` (P0, 2026-09-04, prep for ROADMAP Phase 8) — the `/account/*`
 * route group: account-bound meta state (design/16-accounts.md, ROADMAP 2.x's
 * blueprint/loadout persistence). The client's `MetaState`
 * (blueprints/materials/loadout), previously localStorage-only, mirrored here once a
 * player is logged in.
 *
 * Every route here requires a live session; the bearer-token reader lives with the rest of
 * the account trust boundary in `routes/auth.ts` and is imported from there.
 *
 * ROADMAP 8.2 is the pass that stops `POST /account/meta` being a blind whole-blob upsert
 * and moves purchasable ownership into an `entitlements` table — this file is the seam it
 * lands in. Nothing about that is anticipated here; the split is behaviour-preserving.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { AuthService } from '../AuthService';
import { readJson, send, type RouteHandler } from './http';
import { requireAuth } from './auth';

export interface AccountRouteDeps {
  auth: AuthService;
  db: DatabaseSync;
}

export const getMeta: RouteHandler<AccountRouteDeps> = (req, res, _url, deps) => {
  const session = requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  const row = deps.db.prepare('SELECT data FROM meta_state WHERE account_id = ?').get(session.accountId) as
    | { data: string }
    | undefined;
  send(res, 200, { data: row ? (JSON.parse(row.data) as unknown) : null });
};

export const postMeta: RouteHandler<AccountRouteDeps> = (req, res, _url, deps) => {
  const session = requireAuth(req, deps.auth);
  if (!session) return send(res, 401, { error: 'invalid or expired session' });
  readJson(req, (body) => {
    const data = (body as { data?: unknown })?.data;
    if (data === undefined) return send(res, 400, { error: 'data required' });
    deps.db
      .prepare(
        'INSERT INTO meta_state (account_id, data) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data',
      )
      .run(session.accountId, JSON.stringify(data));
    send(res, 200, { ok: true });
  });
};
