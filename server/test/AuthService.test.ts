/**
 * AuthService (design/16-accounts.md). Drives the real SQLite schema in `:memory:`
 * (node:sqlite) with an injected fake clock/id/token source — mirrors
 * PartyService.test.ts's style.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db';
import { AuthService, type AuthServiceDeps } from '../src/AuthService';

function make(overrides: Partial<AuthServiceDeps> = {}) {
  let now = 1_000;
  let idN = 0;
  let tokenN = 0;
  const deps: AuthServiceDeps = {
    nowMs: () => now,
    newAccountId: () => `acct-${++idN}`,
    newToken: () => `token-${++tokenN}`,
    ...overrides,
  };
  const db: DatabaseSync = openDb(':memory:');
  const auth = new AuthService(db, deps);
  return { auth, db, advance: (ms: number) => (now += ms) };
}

describe('AuthService — register', () => {
  it('registers a new account and returns a session token', () => {
    const { auth } = make();
    const result = auth.register('alice', 'hunter22');
    expect(result).toMatchObject({ accountId: 'acct-1', username: 'alice', token: 'token-1' });
  });

  it('rejects a duplicate username', () => {
    const { auth } = make();
    auth.register('alice', 'hunter22');
    const result = auth.register('alice', 'differentpw');
    expect(result).toMatchObject({ error: expect.stringContaining('taken') });
  });

  it('rejects a too-short username', () => {
    const { auth } = make();
    expect(auth.register('ab', 'hunter22')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a blacklisted username (design/16-accounts.md local filter)', () => {
    const { auth } = make();
    expect(auth.register('admin', 'hunter22')).toMatchObject({ error: 'username not allowed' });
    expect(auth.register('xxAdminxx', 'hunter22')).toMatchObject({ error: 'username not allowed' });
  });

  it('rejects a username with invalid characters', () => {
    const { auth } = make();
    expect(auth.register('al ice!', 'hunter22')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a too-short password', () => {
    const { auth } = make();
    expect(auth.register('alice', 'short')).toMatchObject({ error: expect.any(String) });
  });

  it('never stores the password in plaintext', () => {
    const { auth, db } = make();
    auth.register('alice', 'hunter22');
    const row = db.prepare('SELECT password_hash FROM accounts WHERE username = ?').get('alice') as
      | { password_hash: string }
      | undefined;
    expect(row?.password_hash).toBeTruthy();
    expect(row?.password_hash).not.toContain('hunter22');
  });
});

describe('AuthService — login', () => {
  it('logs in with the correct password and issues a fresh session', () => {
    const { auth } = make();
    auth.register('alice', 'hunter22');
    const result = auth.login('alice', 'hunter22');
    expect(result).toMatchObject({ accountId: 'acct-1', username: 'alice', token: 'token-2' });
  });

  it('rejects the wrong password', () => {
    const { auth } = make();
    auth.register('alice', 'hunter22');
    expect(auth.login('alice', 'wrongpass')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects an unknown username', () => {
    const { auth } = make();
    expect(auth.login('nobody', 'hunter22')).toMatchObject({ error: expect.any(String) });
  });
});

describe('AuthService — sessions', () => {
  it('verifies a live session token', () => {
    const { auth } = make();
    const { token } = auth.register('alice', 'hunter22') as { token: string };
    expect(auth.verifySession(token)).toMatchObject({ accountId: 'acct-1', username: 'alice' });
  });

  it('rejects an unknown token', () => {
    const { auth } = make();
    expect(auth.verifySession('bogus')).toBeNull();
  });

  it('rejects an expired session', () => {
    const { auth, advance } = make();
    const { token } = auth.register('alice', 'hunter22') as { token: string };
    advance(31 * 24 * 60 * 60_000); // past the 30-day TTL
    expect(auth.verifySession(token)).toBeNull();
  });

  it('invalidates a session on logout', () => {
    const { auth } = make();
    const { token } = auth.register('alice', 'hunter22') as { token: string };
    auth.logout(token);
    expect(auth.verifySession(token)).toBeNull();
  });
});

describe('AuthService — changePassword', () => {
  it('changes the password and invalidates the old one', () => {
    const { auth } = make();
    const { accountId } = auth.register('alice', 'hunter22') as { accountId: string };
    const result = auth.changePassword(accountId, 'hunter22', 'newpassword1');
    expect(result).toMatchObject({ ok: true });
    expect(auth.login('alice', 'hunter22')).toMatchObject({ error: expect.any(String) });
    expect(auth.login('alice', 'newpassword1')).toMatchObject({ accountId });
  });

  it('rejects the wrong current password', () => {
    const { auth } = make();
    const { accountId } = auth.register('alice', 'hunter22') as { accountId: string };
    expect(auth.changePassword(accountId, 'wrongpass', 'newpassword1')).toMatchObject({ error: expect.any(String) });
  });
});

describe('AuthService — edge cases', () => {
  it('rejects an empty username and an empty password', () => {
    const { auth } = make();
    expect(auth.register('', 'hunter22')).toMatchObject({ error: expect.any(String) });
    expect(auth.register('alice', '')).toMatchObject({ error: expect.any(String) });
  });

  it('rejects a too-long username (21 chars, one past MAX_USERNAME)', () => {
    const { auth } = make();
    expect(auth.register('a'.repeat(21), 'hunter22')).toMatchObject({ error: expect.any(String) });
  });

  it('accepts usernames/passwords exactly at the boundary lengths (3/20/8)', () => {
    const { auth } = make();
    expect(auth.register('abc', '12345678')).toMatchObject({ accountId: expect.any(String) });
    expect(auth.register('a'.repeat(20), '12345678')).toMatchObject({ accountId: expect.any(String) });
  });

  it('rejects a username with unicode/emoji (outside the ASCII charset)', () => {
    const { auth } = make();
    expect(auth.register('用户名', 'hunter22')).toMatchObject({ error: expect.any(String) });
    expect(auth.register('alice🙂', 'hunter22')).toMatchObject({ error: expect.any(String) });
  });

  it('treats usernames as case-insensitively unique — "Alice" collides with "alice"', () => {
    const { auth } = make();
    auth.register('alice', 'hunter22');
    expect(auth.register('Alice', 'differentpw')).toMatchObject({ error: expect.stringContaining('taken') });
    expect(auth.register('ALICE', 'differentpw')).toMatchObject({ error: expect.stringContaining('taken') });
  });

  it('login is also case-insensitive on username', () => {
    const { auth } = make();
    auth.register('alice', 'hunter22');
    expect(auth.login('ALICE', 'hunter22')).toMatchObject({ username: 'alice' });
  });

  it('a SQL-injection-style username is rejected by charset validation, never reaching the DB', () => {
    const { auth, db } = make();
    const result = auth.register("'; DROP TABLE accounts; --", 'hunter22');
    expect(result).toMatchObject({ error: expect.any(String) });
    // Prove the table really is untouched, not just that this call errored.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get()).toBeTruthy();
  });

  it('a SQL-injection-style PASSWORD (no charset restriction) is handled safely as inert data', () => {
    const { auth } = make();
    const nasty = "' OR '1'='1' --";
    const reg = auth.register('bob', nasty) as { accountId: string };
    expect(reg.accountId).toBeTruthy();
    // The literal string is the only password that works — it was never interpreted as SQL.
    expect(auth.login('bob', nasty)).toMatchObject({ accountId: reg.accountId });
    expect(auth.login('bob', 'anything else')).toMatchObject({ error: expect.any(String) });
  });

  it('registering the same username concurrently only lets one succeed (node:sqlite is synchronous — no real race, but pins the guarantee)', () => {
    const { auth } = make();
    const results = [auth.register('carol', 'hunter22'), auth.register('carol', 'hunter22')];
    const successes = results.filter((r) => 'accountId' in r);
    const failures = results.filter((r) => 'error' in r);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});
