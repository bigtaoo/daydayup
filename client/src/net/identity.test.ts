/**
 * Local player identity (design/05/15 PvP squad follow-up). Tested against an
 * in-memory fake IdentityStore — real localStorage isn't available in this test
 * environment (same reason settings/store.ts tests its web store separately).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getPlayerId, resetIdentityCacheForTests, type IdentityStore } from './identity';
import { setSession, resetSessionCacheForTests } from './session';

function fakeStore(initial: string | null = null): IdentityStore {
  let value = initial;
  return {
    load: () => value,
    save: (id: string) => {
      value = id;
    },
  };
}

beforeEach(() => {
  resetIdentityCacheForTests();
  resetSessionCacheForTests();
});

describe('getPlayerId', () => {
  it('generates and persists a new id when the store is empty', () => {
    const store = fakeStore();
    const id = getPlayerId(store);
    expect(id).toBeTruthy();
    expect(store.load()).toBe(id); // saved back
  });

  it('reuses an existing persisted id instead of generating a new one', () => {
    const store = fakeStore('existing-id');
    expect(getPlayerId(store)).toBe('existing-id');
  });

  it('caches in-process — a second call does not re-read the store', () => {
    const store = fakeStore();
    const first = getPlayerId(store);
    const second = getPlayerId(fakeStore('different-id-if-read')); // ignored — cache wins
    expect(second).toBe(first);
  });

  it('generates distinct ids across resets with no persisted value', () => {
    const a = getPlayerId(fakeStore());
    resetIdentityCacheForTests();
    const b = getPlayerId(fakeStore());
    expect(a).not.toBe(b);
  });

  it('prefers the logged-in account id over the local guest id (design/16-accounts.md)', () => {
    const store = fakeStore('local-guest-id');
    expect(getPlayerId(store)).toBe('local-guest-id');
    setSession({ accountId: 'acct-1', username: 'alice', token: 'tok-1' });
    expect(getPlayerId(store)).toBe('acct-1');
  });
});
