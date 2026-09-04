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
