/**
 * Session (design/16-accounts.md). Tested against an in-memory fake SessionStore —
 * mirrors identity.test.ts's style.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getSession, setSession, resetSessionCacheForTests, type Session, type SessionStore } from './session';

function fakeStore(initial: Session | null = null): SessionStore {
  let value = initial;
  return {
    load: () => value,
    save: (s) => {
      value = s;
    },
  };
}

const ALICE: Session = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

beforeEach(() => resetSessionCacheForTests());

describe('getSession/setSession', () => {
  it('returns null when nothing is stored', () => {
    expect(getSession(fakeStore())).toBeNull();
  });

  it('reads a persisted session on first call', () => {
    expect(getSession(fakeStore(ALICE))).toEqual(ALICE);
  });

  it('caches in-process — a second call does not re-read the store', () => {
    getSession(fakeStore(ALICE));
    expect(getSession(fakeStore(null))).toEqual(ALICE); // ignored — cache wins
  });

  it('setSession updates the cache and persists to the store', () => {
    const store = fakeStore();
    setSession(ALICE, store);
    expect(getSession(store)).toEqual(ALICE);
    expect(store.load()).toEqual(ALICE);
  });

  it('setSession(null) logs out — clears cache and store', () => {
    const store = fakeStore(ALICE);
    setSession(null, store);
    expect(getSession(store)).toBeNull();
    expect(store.load()).toBeNull();
  });
});
