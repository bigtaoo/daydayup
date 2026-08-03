/**
 * Account/session/rating/meta persistence (design/16-accounts.md). Uses Node's built-in
 * `node:sqlite` (stable since Node 22) rather than a third-party driver — this box has no
 * C++ build toolchain for native modules like better-sqlite3, and the built-in module needs
 * nothing beyond the Node runtime already required to run this server at all. Same
 * synchronous, single-file, zero-ops shape the rest of this project already leans on (no
 * Express, no separate DB service — see matchsvc.ts/RatingStore/PartyService).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local',
  provider_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_id ON accounts(provider, provider_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL
);

-- No FK to accounts(id): a rating key is any opaque id ladderReport.ts hands us,
-- including a guest/bot scaffold (\`seat:{roomId}:{seatIdx}\`) that never has an
-- accounts row at all (design/15's ladder predates design/16's accounts table).
CREATE TABLE IF NOT EXISTS ratings (
  account_id TEXT PRIMARY KEY,
  rating INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  data TEXT NOT NULL
);
`;

/** Opens (creating if needed) the account DB and ensures the schema exists. */
export function openDb(path: string = defaultDbPath()): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

function defaultDbPath(): string {
  const env = process.env.DDU_DB_PATH;
  if (env && env.length > 0) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../data/daydayup.db');
}
