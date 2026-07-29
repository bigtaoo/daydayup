/**
 * Local player identity (design/05/15's PvP squad follow-up; design/16-accounts.md).
 * `getPlayerId()` prefers a logged-in account's real `accountId` (`net/session.ts`)
 * once one exists; the random id below is only the guest/anonymous fallback, kept for
 * players who never log in. This is the seam `server/src/ladderReport.ts`'s own note
 * anticipated: "swapping in real account ids later is a caller-side change only."
 */
import { getSession } from './session';

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

/** The local player's persistent id: the real accountId once logged in, otherwise a
 * generated-and-saved guest id. */
export function getPlayerId(store: IdentityStore = createWebIdentityStore()): string {
  const session = getSession();
  if (session) return session.accountId;
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
