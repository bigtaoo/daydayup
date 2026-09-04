/**
 * accountSync (design/16-accounts.md; ROADMAP 8.2 for the entitlement half).
 * `createAccountSyncMetaStore` wraps the real web MetaStore but ALSO reaches out to
 * `getSession`/`saveAccountMeta`/`fetchAccountState` from net/session, net/auth and
 * net/entitlements directly (no injection seam on those call sites), so those modules are
 * mocked here — same `vi.hoisted` + `vi.mock` factory convention as Forge.npc.test.ts's
 * `render/uiSkins` mock / Pickup.test.ts's `render/weaponSkins` mock.
 *
 * `entitlementOwnership` is deliberately NOT mocked: it is a pure projection, and the
 * question this file has to answer about it — does a purchase actually reach MetaState's
 * ownership arrays — is only answered by the real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../net/session';
import { entitlementOwnership, type AccountState } from '../net/entitlements';

const mocks = vi.hoisted(() => ({
  session: null as Session | null,
  fetchAccountState: vi.fn(),
  saveAccountMeta: vi.fn(),
}));

vi.mock('../net/session', () => ({
  getSession: () => mocks.session,
}));

vi.mock('../net/auth', () => ({
  saveAccountMeta: mocks.saveAccountMeta,
}));

vi.mock('../net/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../net/entitlements')>()),
  fetchAccountState: mocks.fetchAccountState,
}));

import { createAccountSyncMetaStore, pullAccountMeta } from './accountSync';
import { defaultMetaState } from './MetaState';

/** The `GET /account/meta` response, whose ownership fields the server has already
 * overwritten from its own entitlements table (design/19 §2). */
const serverState = (data: unknown, entitlements: AccountState['entitlements'] = []): AccountState => ({
  data,
  entitlements,
});

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
  mocks.fetchAccountState.mockReset();
  mocks.saveAccountMeta.mockReset();
});

describe('createAccountSyncMetaStore — load()', () => {
  it('delegates to the local (web/localStorage-backed) MetaStore, no server call', () => {
    const store = createAccountSyncMetaStore(() => 'http://mm');
    expect(store.load()).toEqual(defaultMetaState());
    expect(mocks.fetchAccountState).not.toHaveBeenCalled();
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
    mocks.fetchAccountState.mockResolvedValue(serverState(null));
    expect(await pullAccountMeta('http://mm', 'tok-1')).toBeNull();
    expect(mocks.fetchAccountState).toHaveBeenCalledWith('http://mm', 'tok-1');
  });

  it('runs the fetched data through migrate() rather than trusting it verbatim', async () => {
    // A saved value with a corrupted materialBank entry (string qty) — migrate() must
    // sanitize it exactly like store.ts's own migrate() does for a localStorage save.
    mocks.fetchAccountState.mockResolvedValue(serverState({ materialBank: { mat_fire: '3', mat_ice: 2 } }));
    const result = await pullAccountMeta('http://mm', 'tok-1');
    expect(result).not.toBeNull();
    expect(result!.materialBank).toEqual({ mat_ice: 2 });
  });

  it('backfills fields missing from an older server-side save', async () => {
    const { hasSeenTutorial, ...rest } = defaultMetaState();
    void hasSeenTutorial;
    mocks.fetchAccountState.mockResolvedValue(serverState(rest));
    const result = await pullAccountMeta('http://mm', 'tok-1');
    expect(result!.hasSeenTutorial).toBe(defaultMetaState().hasSeenTutorial);
  });
});

describe('pullAccountMeta — ROADMAP 8.2, the server now owns the ownership fields', () => {
  it('logging in does not change the Forge for an account that owns nothing paid — the no-flicker case', async () => {
    // THE property the whole 8.2 client story rests on, and the reason nothing in
    // client/src/game needed to change: the server hands back EMPTY ownership arrays for
    // every account today, and `migrate()` unions the free baseline (STARTER_BLUEPRINTS +
    // FREE_CHARACTERS, store.ts) back in on the way through. So before-login and
    // after-login ownership are identical, and the Forge neither flickers nor rolls back.
    const guest = defaultMetaState();
    mocks.fetchAccountState.mockResolvedValue(serverState({ ...guest, unlockedBlueprints: [], ownedCharacters: [] }));
    const afterLogin = await pullAccountMeta('http://mm', 'tok-1');
    expect(afterLogin!.unlockedBlueprints).toEqual(guest.unlockedBlueprints);
    expect(afterLogin!.ownedCharacters).toEqual(guest.ownedCharacters);
  });

  it('a server-granted blueprint arrives ON TOP of the free baseline, not instead of it', async () => {
    const paid = 'cannon'; // source 'purchase' in BLUEPRINT_CATALOG — never a starter
    expect(defaultMetaState().unlockedBlueprints).not.toContain(paid);
    mocks.fetchAccountState.mockResolvedValue(
      serverState({ ...defaultMetaState(), unlockedBlueprints: [paid], ownedCharacters: [] }),
    );
    const result = await pullAccountMeta('http://mm', 'tok-1');
    expect(result!.unlockedBlueprints).toContain(paid);
    for (const free of defaultMetaState().unlockedBlueprints) expect(result!.unlockedBlueprints).toContain(free);
  });

  it('ownership the client granted ITSELF is gone after the pull — the hole 8.2 closes', async () => {
    // The counterpart of the test above, and the one real behaviour change of this pass:
    // ForgeActions' `demo: free grant` scaffold no longer survives a login, because the
    // server answers with its own table and never with what this device pushed up.
    mocks.fetchAccountState.mockResolvedValue(
      serverState({ ...defaultMetaState(), unlockedBlueprints: [], ownedCharacters: [] }),
    );
    const result = await pullAccountMeta('http://mm', 'tok-1');
    expect(result!.unlockedBlueprints).not.toContain('cannon');
  });

  it('applies entitlements onto local state when the account has no server blob yet', async () => {
    // The one window where `data` is null but a purchase already exists: bought before this
    // account ever saved. Additive-only, because there is no server blob to be authoritative
    // over yet — so the guest's materials and loadout survive untouched.
    const local = { ...defaultMetaState(), materialBank: { mat_fire: 7 }, loadout: ['repeater'] };
    mocks.fetchAccountState.mockResolvedValue(
      serverState(null, [
        { sku: 'blueprint:cannon', source: 'purchase', grantedAt: 1 },
        { sku: 'character:hero', source: 'purchase', grantedAt: 2 },
      ]),
    );
    const result = await pullAccountMeta('http://mm', 'tok-1', local);
    expect(result!.unlockedBlueprints).toEqual([...local.unlockedBlueprints, 'cannon']);
    expect(result!.ownedCharacters).toEqual([...local.ownedCharacters, 'hero']);
    expect(result!.materialBank).toEqual({ mat_fire: 7 });
    expect(result!.loadout).toEqual(['repeater']);
  });

  it('de-duplicates a SKU the local state already lists', async () => {
    const already = defaultMetaState().unlockedBlueprints[0]!;
    mocks.fetchAccountState.mockResolvedValue(
      serverState(null, [{ sku: `blueprint:${already}`, source: 'starter', grantedAt: 1 }]),
    );
    const result = await pullAccountMeta('http://mm', 'tok-1', defaultMetaState());
    expect(result!.unlockedBlueprints).toEqual(defaultMetaState().unlockedBlueprints);
  });

  it('still returns null when there is no blob AND no entitlements — the pre-8.2 contract', async () => {
    // Load-bearing: the caller answers null by pushing its own local state up. Inventing a
    // MetaState here would silently replace a guest's accumulated materials with defaults.
    mocks.fetchAccountState.mockResolvedValue(serverState(null, []));
    expect(await pullAccountMeta('http://mm', 'tok-1', defaultMetaState())).toBeNull();
  });

  it('returns null when entitlements exist but no local state was handed in — omitting it is exactly the old behaviour', async () => {
    mocks.fetchAccountState.mockResolvedValue(
      serverState(null, [{ sku: 'character:hero', source: 'purchase', grantedAt: 1 }]),
    );
    expect(await pullAccountMeta('http://mm', 'tok-1')).toBeNull();
  });

  it('ignores `local` entirely once a server blob exists — the server answer is the authority', async () => {
    // Not merely "the blob wins": the entitlement list must not be re-applied on top of it,
    // or a revoked SKU still present on this device would come back.
    const local = { ...defaultMetaState(), ownedCharacters: [...defaultMetaState().ownedCharacters, 'self-granted'] };
    mocks.fetchAccountState.mockResolvedValue(
      serverState({ ...defaultMetaState(), unlockedBlueprints: [], ownedCharacters: [] }, [
        { sku: 'character:hero', source: 'purchase', grantedAt: 1 },
      ]),
    );
    const result = await pullAccountMeta('http://mm', 'tok-1', local);
    expect(result!.ownedCharacters).not.toContain('self-granted');
    // `hero` is absent too — the blob the server returned is already its own answer, and
    // entitlementOwnership is not re-run over it.
    expect(result!.ownedCharacters).toEqual(defaultMetaState().ownedCharacters);
    expect(entitlementOwnership([{ sku: 'character:hero', source: 'purchase', grantedAt: 1 }]).ownedCharacters).toEqual([
      'hero',
    ]);
  });
});
