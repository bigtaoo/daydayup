/**
 * Local player identity (design/05/15's PvP squad follow-up). No account/login system
 * exists anywhere in this project (see server/src/rating.ts's own note) — this is
 * deliberately just a random id generated once and persisted locally, exactly the
 * level of trust `POST /find`'s client-declared `playerCount`/`mode` already gets.
 * Never sent anywhere except party/matchmaking calls; not a real identity system.
 */
const STORAGE_KEY = 'daydayup.playerId.v1';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Fallback for an environment without crypto.randomUUID (e.g. an older WeChat
  // WebView) — not cryptographically strong, but this id is never a security
  // boundary, only a "which browser tab is this" grouping key.
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A storage port so web (localStorage) and WeChat (wx.getStorageSync/setStorageSync)
 * can each plug in their own primitive — same seam as settings/store.ts's SettingsStore. */
export interface IdentityStore {
  load(): string | null;
  save(id: string): void;
}

export function createWebIdentityStore(key: string = STORAGE_KEY): IdentityStore {
  const available = typeof localStorage !== 'undefined';
  return {
    load: () => (available ? localStorage.getItem(key) : null),
    save: (id: string) => {
      if (!available) return;
      try {
        localStorage.setItem(key, id);
      } catch {
        /* quota / private-mode — an unpersisted id for this session is acceptable */
      }
    },
  };
}

let cached: string | null = null;

/** The local player's persistent id, generating and saving one on first call. */
export function getPlayerId(store: IdentityStore = createWebIdentityStore()): string {
  if (cached) return cached;
  const existing = store.load();
  if (existing) {
    cached = existing;
    return existing;
  }
  const id = randomId();
  store.save(id);
  cached = id;
  return id;
}

/** Test-only: clear the in-process cache so a fresh store is actually read again. */
export function resetIdentityCacheForTests(): void {
  cached = null;
}
