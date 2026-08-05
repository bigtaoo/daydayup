/**
 * accountSync (design/16-accounts.md). `createAccountSyncMetaStore` wraps the real web
 * MetaStore but ALSO reaches out to `getSession`/`saveAccountMeta` from net/session and
 * net/auth directly (no injection seam on those call sites), so both modules are mocked
 * here — same `vi.hoisted` + `vi.mock` factory convention as Forge.npc.test.ts's
 * `render/uiSkins` mock / Pickup.test.ts's `render/weaponSkins` mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../net/session';

const mocks = vi.hoisted(() => ({
  session: null as Session | null,
  fetchAccountMeta: vi.fn(),
  saveAccountMeta: vi.fn(),
}));

vi.mock('../net/session', () => ({
  getSession: () => mocks.session,
}));

vi.mock('../net/auth', () => ({
  fetchAccountMeta: mocks.fetchAccountMeta,
  saveAccountMeta: mocks.saveAccountMeta,
}));

import { createAccountSyncMetaStore, pullAccountMeta } from './accountSync';
import { defaultMetaState } from './MetaState';

const ALICE: Session = { accountId: 'acct-1', username: 'alice', token: 'tok-1' };

// jsdom-free: this repo's plain-node vitest has no `localStorage`, and
// createAccountSyncMetaStore wraps the real web MetaStore (store.ts's
// createWebMetaStore), so exercising its local-persistence side needs the same
// in-memory shim store.test.ts/settings/store.test.ts use.
function withFakeLocalStorage<T>(fn: () => T): T {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
    removeItem: (k: string) => data.delete(k),
  };
  try {
    return fn();
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

beforeEach(() => {
  mocks.session = null;
  mocks.fetchAccountMeta.mockReset();
  mocks.saveAccountMeta.mockReset();
});

describe('createAccountSyncMetaStore — load()', () => {
  it('delegates to the local (web/localStorage-backed) MetaStore, no server call', () => {
    const store = createAccountSyncMetaStore(() => 'http://mm');
    expect(store.load()).toEqual(defaultMetaState());
    expect(mocks.fetchAccountMeta).not.toHaveBeenCalled();
  });
});

describe('createAccountSyncMetaStore — save() as a guest (no session)', () => {
  it('persists locally and never calls the server', () => {
    withFakeLocalStorage(() => {
      mocks.session = null;
      const store = createAccountSyncMetaStore(() => 'http://mm');
      const next = { ...defaultMetaState(), hasSeenTutorial: true };
      store.save(next);
      expect(store.load()).toEqual(next);
      expect(mocks.saveAccountMeta).not.toHaveBeenCalled();
    });
  });
});

describe('createAccountSyncMetaStore — save() while logged in', () => {
  it('persists locally AND best-effort pushes to the server with the session token', () => {
    withFakeLocalStorage(() => {
      mocks.session = ALICE;
      mocks.saveAccountMeta.mockResolvedValue(undefined);
      const store = createAccountSyncMetaStore(() => 'http://mm');
      const next = { ...defaultMetaState(), hasSeenTutorial: true };
      store.save(next);
      expect(store.load()).toEqual(next); // local write happens synchronously either way
      expect(mocks.saveAccountMeta).toHaveBeenCalledWith('http://mm', 'tok-1', next);
    });
  });

  it('reads the base URL lazily at save time (a thunk, not a captured value) — see this file\'s own comment on the ?matchBaseUrl= override ordering', () => {
    withFakeLocalStorage(() => {
      mocks.session = ALICE;
      mocks.saveAccountMeta.mockResolvedValue(undefined);
      let baseUrl = 'http://first';
      const store = createAccountSyncMetaStore(() => baseUrl);
      baseUrl = 'http://second'; // override lands AFTER construction, BEFORE save()
      store.save(defaultMetaState());
      expect(mocks.saveAccountMeta).toHaveBeenCalledWith('http://second', 'tok-1', defaultMetaState());
    });
  });

  it('a failed server push is swallowed — fire-and-forget never throws out of save() and never blocks it, and the local write still succeeds', () => {
    withFakeLocalStorage(() => {
      mocks.session = ALICE;
      mocks.saveAccountMeta.mockRejectedValue(new Error('network down'));
      const store = createAccountSyncMetaStore(() => 'http://mm');
      const next = { ...defaultMetaState(), hasSeenTutorial: true };
      // save() itself is synchronous; a rejected promise from the fire-and-forget push must
      // not surface synchronously nor turn into an unhandled rejection that fails the suite.
      expect(() => store.save(next)).not.toThrow();
      expect(store.load()).toEqual(next); // local write still succeeded despite the failed push
    });
  });
});

describe('pullAccountMeta', () => {
  it('returns null for a brand-new account with no server-side meta yet', async () => {
    mocks.fetchAccountMeta.mockResolvedValue(null);
    expect(await pullAccountMeta('http://mm', 'tok-1')).toBeNull();
    expect(mocks.fetchAccountMeta).toHaveBeenCalledWith('http://mm', 'tok-1');
  });

  it('runs the fetched data through migrate() rather than trusting it verbatim', async () => {
    // A saved value with a corrupted materialBank entry (string qty) — migrate() must
    // sanitize it exactly like store.ts's own migrate() does for a localStorage save.
    mocks.fetchAccountMeta.mockResolvedValue({ materialBank: { mat_fire: '3', mat_ice: 2 } });
    const result = await pullAccountMeta('http://mm', 'tok-1');
    expect(result).not.toBeNull();
    expect(result!.materialBank).toEqual({ mat_ice: 2 });
  });

  it('backfills fields missing from an older server-side save', async () => {
    const { hasSeenTutorial, ...rest } = defaultMetaState();
    void hasSeenTutorial;
    mocks.fetchAccountMeta.mockResolvedValue(rest);
    const result = await pullAccountMeta('http://mm', 'tok-1');
    expect(result!.hasSeenTutorial).toBe(defaultMetaState().hasSeenTutorial);
  });
});
