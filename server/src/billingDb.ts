/**
 * The billing plane's OWN SQLite file (design/19-server-platform.md §4). Deliberately
 * separate from `db.ts`'s account database, and deliberately not sharing its `openDb`:
 * "Money gets its own process and its own database file" is a locked decision in that
 * doc, and a shared opener is exactly how a later refactor quietly re-merges them.
 *
 * Same `node:sqlite` shape as `db.ts` (no native driver on this box), same synchronous
 * single-file zero-ops posture. Three tables, no more:
 *
 *   orders    one row per purchase attempt. `platform_txn_id`'s UNIQUE constraint is the
 *             schema-level guarantee that no two orders can claim one platform payment.
 *   receipts  one row per verified receipt, keyed `${platform}:${receipt}`, and carrying
 *             the `product` the receipt RESOLVED to — without that column a receipt for
 *             one SKU can be replayed to claim a different one (design/19 §4).
 *   ledger    append-only. Never UPDATEd, never DELETEd. A reversal is a new row with
 *             `kind = 'reversal'`, which is what makes the file hand-auditable with SQL
 *             instead of needing the admin service design/19 §8 declines to build.
 *   deliveries the OUTBOX (design/19 §4's closed loop). One row per settled purchase that
 *             owes the control plane an `entitlements` write, inserted inside the same
 *             `BEGIN IMMEDIATE` as its `orders`/`receipts`/`ledger` siblings and drained
 *             afterwards over HTTP. Four tables, not three, and the fourth is the whole
 *             reason the single-transaction claim survives a table in another file.
 *
 * No foreign keys point at `accounts(id)`, and none can: that table lives in a different
 * database FILE. The account-side integrity check is design/19 §2's `entitlements` table
 * in the control plane, reached through `BillingService`'s injected delivery seam rather
 * than through SQL.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  platform TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL,
  -- NULL until a platform callback claims this order. SQLite treats NULLs as distinct
  -- under UNIQUE, so any number of unsettled orders coexist; two SETTLED orders sharing
  -- one platform transaction is what this constraint makes impossible.
  platform_txn_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_account ON orders(account_id);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  product TEXT NOT NULL,
  raw TEXT NOT NULL,
  verified_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  order_id TEXT,
  receipt_id TEXT,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account ON ledger(account_id);

-- The delivery outbox (design/19 §4). 'entitlements' lives in the CONTROL PLANE's database
-- file, so no 'BEGIN IMMEDIATE' can span it and an HTTP call from inside one would hold
-- SQLite's write lock across a network round trip. This table is the resolution: the
-- settlement transaction writes a durable PROMISE to deliver, and a pump keeps that promise
-- afterwards. At-least-once, which is safe because the UNIQUE(account_id, sku) on
-- entitlements makes the receiving grant idempotent -- the entire reason this is an
-- outbox and not a
-- two-phase commit.
CREATE TABLE IF NOT EXISTS deliveries (
  -- The LEDGER row's own id, 'purchase:<platform>:<txn>', shared rather than generated:
  -- the ledger claim inside the settlement transaction has already been WON by the time
  -- this row is written, so reusing that key makes a second row impossible without a
  -- second idempotency mechanism -- and makes 'ledger LEFT JOIN deliveries USING (id)' the
  -- one query that answers "which money moved without reaching an account", which is the
  -- hand-auditability posture the other three tables are shaped for.
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- The BILLSVC sku ('bp.cannon'), advisory: what the receiving side writes is derived from
  -- 'grants_json' and namespaced by 'EntitlementService' ('blueprint:cannon'). Kept because
  -- an operator reading this table wants the thing that was sold, not its projection.
  sku TEXT NOT NULL,
  -- The '(kind, id)' pairs from the SKU catalogue, frozen AT SETTLEMENT. Not re-read from
  -- the catalogue at delivery time on purpose: a SKU edited between the payment and a
  -- retried delivery must deliver what was paid for, not what the table says later.
  grants_json TEXT NOT NULL,
  -- NOT NULL, both of them: the CHECK on entitlements refuses a purchase-sourced row with
  -- no order behind it, so a delivery that could not satisfy it must never be written here
  -- in the first place.
  order_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  -- 'failed' is TERMINAL and means the control plane refused on purpose (a 4xx). A
  -- retryable failure -- 5xx, timeout, connection refused -- leaves the row 'pending' and
  -- bumps 'attempts', forever: the money moved, so giving up loses a purchase, while a peer
  -- that comes back heals on its own. 'attempts' is what an operator alerts on.
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
-- The pump's only query: oldest pending first.
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries(state, created_at);
`;

/** Opens (creating if needed) the BILLING database and ensures the schema exists. */
export function openBillingDb(path: string = defaultBillingDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/**
 * `DDU_BILLING_DB_PATH`, or a `data/billing.db` sibling of the account DB's own default.
 * Distinct env var on purpose — pointing both planes at one file by setting one variable
 * is the failure this separation exists to prevent.
 */
export function defaultBillingDbPath(): string {
  const env = process.env.DDU_BILLING_DB_PATH;
  if (env && env.length > 0) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../data/billing.db');
}
