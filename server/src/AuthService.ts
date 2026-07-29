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
    const row = this.db
      .prepare('SELECT id, username, password_hash FROM accounts WHERE username = ? COLLATE NOCASE')
      .get(username) as { id: string; username: string; password_hash: string } | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) return { error: 'invalid username or password' };
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
    const token = this.newToken();
    const expiresAt = this.nowMs() + SESSION_TTL_MS;
    this.db.prepare('INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)').run(token, accountId, expiresAt);
    return { accountId, username, token };
  }
}
