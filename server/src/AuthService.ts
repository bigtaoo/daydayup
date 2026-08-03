/**
 * Username/password accounts (design/16-accounts.md) — the first real identity layer
 * this project has ever had (see `PartyService.ts`/`rating.ts`'s own notes on the
 * previous total absence of one). Pure class over an injected `DatabaseSync` (same
 * dependency-injection shape as `PartyService`/`Matchmaker`), so tests run against a
 * `:memory:` DB with no disk I/O.
 *
 * Sessions are opaque bearer tokens stored server-side (not JWT) — revocable via a
 * plain `DELETE`, matching this codebase's existing preference for a few extra bytes
 * over a new dependency (`ticket.ts` uses raw HMAC rather than a JWT library too).
 *
 * `accounts.provider`/`provider_id` (default `'local'`/`NULL`) are unused today but
 * reserved for third-party login (e.g. WeChat openid) — adding a provider later is a
 * new `provider != 'local'` row + a new `/auth/oauth/:provider` route, not a schema
 * migration.
 */
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { isBlockedUsername } from './usernameFilter';

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days
const SCRYPT_KEYLEN = 64;
const MIN_USERNAME = 3;
const MAX_USERNAME = 20;
const MIN_PASSWORD = 8;
// Login brute-force lockout: after this many consecutive failures for a username,
// further attempts are rejected outright (no password check at all, so a lockout
// can't itself be used to brute-force-verify a guessed password) until the window
// elapses. Keyed by username, not IP — this server has no request-IP plumbing
// today and a per-username lock still stops the actual attack (repeatedly guessing
// one account's password), matching `changePassword`'s own account-scoped threat
// model.
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60_000;

export interface AuthServiceDeps {
  nowMs?: () => number;
  newAccountId?: () => string;
  newToken?: () => string;
}

export interface AuthSuccess {
  accountId: string;
  username: string;
  token: string;
}
export interface AuthFailure {
  error: string;
}
export type AuthResult = AuthSuccess | AuthFailure;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string' || username.length < MIN_USERNAME || username.length > MAX_USERNAME) {
    return `username must be ${MIN_USERNAME}-${MAX_USERNAME} characters`;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return 'username may only contain letters, digits, and underscore';
  if (isBlockedUsername(username)) return 'username not allowed';
  return null;
}

function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `password must be at least ${MIN_PASSWORD} characters`;
  }
  return null;
}

export class AuthService {
  private readonly nowMs: () => number;
  private readonly newAccountId: () => string;
  private readonly newToken: () => string;
  // In-memory only (matches this project's existing convention — Matchmaker/RatingStore's
  // own cache fallback are in-memory too): a lockout resetting on server restart is an
  // acceptable tradeoff for a brute-force throttle, and keeps this independent of the DB
  // schema (a failed-login count is not account state worth persisting).
  private readonly loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly db: DatabaseSync,
    deps: AuthServiceDeps = {},
  ) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.newAccountId = deps.newAccountId ?? (() => randomUUID());
    this.newToken = deps.newToken ?? (() => randomBytes(32).toString('hex'));
  }

  register(username: unknown, password: unknown): AuthResult {
    const usernameError = validateUsername(username);
    if (usernameError) return { error: usernameError };
    const passwordError = validatePassword(password);
    if (passwordError) return { error: passwordError };
    const name = username as string;

    // COLLATE NOCASE: usernames are case-insensitively unique — 'Alice' and 'alice'
    // being two distinct accounts is a real impersonation/confusion footgun, not a
    // useful feature. Applied consistently with login's own lookup below.
    const existing = this.db.prepare('SELECT id FROM accounts WHERE username = ? COLLATE NOCASE').get(name);
    if (existing) return { error: 'username already taken' };

    const accountId = this.newAccountId();
    this.db
      .prepare('INSERT INTO accounts (id, username, password_hash, provider, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(accountId, name, hashPassword(password as string), 'local', this.nowMs());

    return this.issueSession(accountId, name);
  }

  login(username: unknown, password: unknown): AuthResult {
    if (typeof username !== 'string' || typeof password !== 'string') return { error: 'invalid username or password' };
    // COLLATE NOCASE means 'Alice'/'alice' are one account for login purposes, so the
    // lockout key must fold case the same way or the two spellings would get separate
    // attempt budgets — normalized once here, reused for every read/write below.
    const key = username.toLowerCase();
    const now = this.nowMs();
    const attempt = this.loginAttempts.get(key);
    if (attempt && attempt.lockedUntil > now) {
      return { error: 'too many failed login attempts — try again later' };
    }

    const row = this.db
      .prepare('SELECT id, username, password_hash FROM accounts WHERE username = ? COLLATE NOCASE')
      .get(username) as { id: string; username: string; password_hash: string } | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) {
      // Reaching here means any prior lockout already expired (a still-active one
      // returned above), so the streak simply continues from wherever it left off.
      const count = (attempt?.count ?? 0) + 1;
      const lockedUntil = count >= MAX_LOGIN_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : 0;
      this.loginAttempts.set(key, { count, lockedUntil });
      return { error: 'invalid username or password' };
    }

    this.loginAttempts.delete(key);
    return this.issueSession(row.id, row.username);
  }

  logout(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /** `null` on an unknown, expired, or malformed token — the caller maps that to a 401. */
  verifySession(token: unknown): { accountId: string; username: string } | null {
    if (typeof token !== 'string' || !token) return null;
    const row = this.db
      .prepare(
        `SELECT s.account_id as accountId, s.expires_at as expiresAt, a.username as username
         FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ?`,
      )
      .get(token) as { accountId: string; expiresAt: number; username: string } | undefined;
    if (!row) return null;
    if (row.expiresAt < this.nowMs()) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return { accountId: row.accountId, username: row.username };
  }

  changePassword(accountId: string, oldPassword: unknown, newPassword: unknown): { ok: true } | AuthFailure {
    const row = this.db.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(accountId) as
      | { password_hash: string }
      | undefined;
    if (!row || typeof oldPassword !== 'string' || !verifyPassword(oldPassword, row.password_hash)) {
      return { error: 'invalid current password' };
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) return { error: passwordError };
    this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword as string), accountId);
    return { ok: true };
  }

  private issueSession(accountId: string, username: string): AuthSuccess {
    // Opportunistic sweep, not a background timer: this project's "no process the
    // team doesn't need yet" convention (see rating.ts/AuthService's own doc notes) —
    // a login/register is exactly as frequent as new rows get added, so sweeping here
    // keeps the table from growing unbounded without a setInterval this class would
    // otherwise be the only thing owning. verifySession (the hot per-request read
    // path) deliberately does NOT sweep here — only the one expired row it already
    // looks at, to keep every authenticated request to a single indexed lookup.
    this.sweepExpiredSessions();
    const token = this.newToken();
    const expiresAt = this.nowMs() + SESSION_TTL_MS;
    this.db.prepare('INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)').run(token, accountId, expiresAt);
    return { accountId, username, token };
  }

  private sweepExpiredSessions(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(this.nowMs());
  }
}
