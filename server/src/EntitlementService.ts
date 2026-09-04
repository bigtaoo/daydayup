/**
 * EntitlementService (design/19-server-platform.md §2, ROADMAP 8.2) — the server-owned
 * half of `MetaState`.
 *
 * `POST /account/meta` is a whole-blob upsert, which was the right call while `MetaState`
 * was a localStorage mirror and nothing in it was worth money (design/16-accounts.md says
 * so outright). The moment blueprints and characters are sold that route becomes a
 * free-money hole, and characters are the one meta axis that reaches PvP
 * (design/14-meta-forging.md). The fix is not to validate the blob — that is whack-a-mole
 * — it is to move the two purchasable, account-level things OUT of it:
 *
 * - `meta_state` keeps what the client legitimately authors (materials, loadout,
 *   in-progress forge state) and stays a blob;
 * - `entitlements` owns blueprint/character OWNERSHIP, and `GET /account/meta` overwrites
 *   those fields in the returned blob from this table. A client that POSTs itself extra
 *   ownership is IGNORED rather than rejected (`stripOwnership` below), so every
 *   pre-existing guest and offline path keeps working byte-for-byte.
 *
 * A guest has no session, therefore no row here at all — local-only, exactly as today.
 *
 * `source` is not decoration. It is what makes design/19 §7's operational work possible: a
 * daily audit that counts non-`purchase` grants per account, and a support path that can
 * hand-issue one with plain SQL and have it still read as different from a paid one
 * afterwards. This project has no admin service and will not have one soon, so the schema
 * is deliberately shaped to be queried and corrected by a human at a `sqlite3` prompt.
 */
import type { DatabaseSync } from 'node:sqlite';

/**
 * Where an entitlement came from (design/19 §2). `purchase` is the only one that implies
 * money moved and the only one that requires an `order_id` (enforced by a CHECK in
 * `db.ts`); `grant` is a support hand-issue, `event` a time-limited campaign, `starter` a
 * new-account gift, `drop` something earned in a run.
 */
export const ENTITLEMENT_SOURCES = ['purchase', 'grant', 'event', 'starter', 'drop'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/** One row of `entitlements`, in this codebase's camelCase rather than SQL's snake_case. */
export interface EntitlementRow {
  id: number;
  accountId: string;
  sku: string;
  source: EntitlementSource;
  /** billsvc's `orders.id` (design/19 §4). Lives in a DIFFERENT database file, so this is
   * deliberately a plain string with no foreign key — the join is done by a human, or by
   * reconciliation, not by SQLite. */
  orderId: string | null;
  grantedAt: number;
}

/**
 * SKUs are namespaced by what they own rather than split across two tables: one
 * `UNIQUE(account_id, sku)` then covers both, `WHERE sku LIKE 'character:%'` is the whole
 * query a human needs, and a blueprint id can never collide with a skin id.
 */
export const BLUEPRINT_SKU_PREFIX = 'blueprint:';
export const CHARACTER_SKU_PREFIX = 'character:';

export function blueprintSku(weaponId: string): string {
  return `${BLUEPRINT_SKU_PREFIX}${weaponId}`;
}

export function characterSku(skinId: string): string {
  return `${CHARACTER_SKU_PREFIX}${skinId}`;
}

/**
 * The two `MetaState` fields this table owns. Named once, here, because three places have
 * to agree on them: the strip on write, the overwrite on read, and the client's own
 * projection (`client/src/net/entitlements.ts`).
 */
export const OWNERSHIP_FIELDS = ['unlockedBlueprints', 'ownedCharacters'] as const;

export interface Ownership {
  unlockedBlueprints: string[];
  ownedCharacters: string[];
}

/**
 * Project a set of SKUs onto the two ownership arrays. A SKU in neither namespace is
 * skipped rather than rejected: billsvc may later sell something that is not a blueprint
 * or a character, and an unknown namespace must not be able to break `/account/meta`.
 * An empty id after the prefix (`'blueprint:'`) is skipped for the same reason.
 */
export function skusToOwnership(skus: Iterable<string>): Ownership {
  const own: Ownership = { unlockedBlueprints: [], ownedCharacters: [] };
  for (const sku of skus) {
    if (sku.startsWith(BLUEPRINT_SKU_PREFIX)) {
      const id = sku.slice(BLUEPRINT_SKU_PREFIX.length);
      if (id) own.unlockedBlueprints.push(id);
    } else if (sku.startsWith(CHARACTER_SKU_PREFIX)) {
      const id = sku.slice(CHARACTER_SKU_PREFIX.length);
      if (id) own.ownedCharacters.push(id);
    }
  }
  return own;
}

/** A blob we can meaningfully add/remove named fields on — i.e. a plain JSON object. An
 * array passes `typeof x === 'object'` and must not, or a client POSTing `data: []` would
 * come back with array elements named `unlockedBlueprints`. */
function isPlainBlob(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data);
}

/**
 * The WRITE normalizer: drop any ownership the client authored before storing the blob.
 * Ignored, not rejected (design/19 §2) — an older client, a guest promoting its local
 * save, or an offline replay all POST the full `MetaState` and must keep succeeding.
 *
 * Stripping rather than storing-and-overwriting-on-read matters for the SQL-auditability
 * requirement: `meta_state` then never holds a client-authored ownership claim at all, so
 * a human reading the table cannot be misled by one.
 *
 * A non-object `data` (a string, a number, an array, `null`) is stored verbatim — there is
 * nothing to strip, and today's route already accepts anything JSON-shaped.
 */
export function stripOwnership(data: unknown): unknown {
  if (!isPlainBlob(data)) return data;
  const out: Record<string, unknown> = { ...data };
  for (const field of OWNERSHIP_FIELDS) delete out[field];
  return out;
}

/**
 * The READ overwrite: the server's own answer for both ownership fields, replacing
 * whatever the stored blob says (which, after `stripOwnership`, is nothing).
 *
 * A non-object blob is returned untouched for the same reason as above.
 */
export function applyOwnership(data: unknown, own: Ownership): unknown {
  if (!isPlainBlob(data)) return data;
  return { ...data, unlockedBlueprints: [...own.unlockedBlueprints], ownedCharacters: [...own.ownedCharacters] };
}

interface EntitlementSqlRow {
  id: number;
  account_id: string;
  sku: string;
  source: string;
  order_id: string | null;
  granted_at: number;
}

function toRow(r: EntitlementSqlRow): EntitlementRow {
  return {
    id: r.id,
    accountId: r.account_id,
    sku: r.sku,
    source: r.source as EntitlementSource,
    orderId: r.order_id,
    grantedAt: r.granted_at,
  };
}

export interface GrantOptions {
  /** billsvc order this grant settles. REQUIRED when `source` is `'purchase'` — the CHECK
   * in `db.ts` rejects a paid entitlement with no order behind it, because one is
   * unauditable and design/19 §7's reconciliation could never match it to anything. */
  orderId?: string;
  /** Injected clock, the same seam `Matchmaker`/`PartyService` already take. */
  nowMs?: number;
}

/**
 * Reads and writes `entitlements` (schema in `db.ts`). A thin, synchronous wrapper over
 * one `DatabaseSync` — the same injected-`DatabaseSync` shape `AuthService`/`RatingStore`
 * already use, so it composes into matchsvc with no new process and no network hop.
 */
export class EntitlementService {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Grant one SKU. Returns `true` when a row actually landed, `false` when the account
   * already owned it.
   *
   * `INSERT ... ON CONFLICT DO NOTHING` + `changes`, never SELECT-then-INSERT: delivery is
   * driven by at-least-once platform callbacks (design/19 §4), so the UNIQUE constraint —
   * not a prior read — has to be the idempotency key. A re-grant is a no-op rather than an
   * update: the FIRST grant's `source` and `order_id` are the audit record, and letting a
   * later `grant` overwrite them would let a free hand-issue erase the paid order that
   * preceded it.
   *
   * Throws if `accountId` names no account (the foreign key) or if `source` is
   * `'purchase'` without an `orderId` — both are caller bugs, and failing loud is what
   * keeps a typo'd hand-issue from becoming an orphan row that silently never delivers.
   */
  grant(accountId: string, sku: string, source: EntitlementSource, opts: GrantOptions = {}): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO entitlements (account_id, sku, source, order_id, granted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id, sku) DO NOTHING`,
      )
      .run(accountId, sku, source, opts.orderId ?? null, opts.nowMs ?? Date.now());
    return Number(result.changes) > 0;
  }

  /**
   * Remove one SKU. Returns whether a row was actually deleted.
   *
   * Manual-only: design/19 §7's anomaly audit FILES rather than acts ("with no evidence,
   * skip — never convict"), so nothing in this server calls this on its own. It exists so
   * that a support correction is a supported operation rather than a hand-written DELETE.
   */
  revoke(accountId: string, sku: string): boolean {
    const result = this.db.prepare('DELETE FROM entitlements WHERE account_id = ? AND sku = ?').run(accountId, sku);
    return Number(result.changes) > 0;
  }

  /** Every entitlement this account holds, oldest grant first (`id` is monotonic). */
  list(accountId: string): EntitlementRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, account_id, sku, source, order_id, granted_at FROM entitlements WHERE account_id = ? ORDER BY id',
      )
      .all(accountId) as unknown as EntitlementSqlRow[];
    return rows.map(toRow);
  }

  /** Whether this account owns one specific SKU — the check a future PvP character gate
   * (design/14's "the one meta axis that reaches PvP") wants, without loading the list. */
  owns(accountId: string, sku: string): boolean {
    const row = this.db.prepare('SELECT 1 AS one FROM entitlements WHERE account_id = ? AND sku = ?').get(accountId, sku);
    return row !== undefined;
  }

  /** The ownership arrays `GET /account/meta` writes over the stored blob with. */
  ownership(accountId: string): Ownership {
    return skusToOwnership(this.list(accountId).map((r) => r.sku));
  }
}
