/**
 * Account-bound sync for MetaState (design/16-accounts.md — Forge blueprints/
 * materials/loadout, previously localStorage-only, see store.ts's own note). Wraps the
 * existing web MetaStore: localStorage stays the synchronous source of truth for every
 * existing `load()`/`save()` call site (Game.ts's ~10 `this.store.save(this.meta)`
 * calls are untouched); a logged-in `save()` ALSO best-effort pushes to
 * `/account/meta` — same fire-and-forget `.catch()` shape as the server's
 * `reportSettledMatch` — so a guest's play is never worse off, only additive once
 * logged in.
 *
 * `getBaseUrl` is a thunk rather than a plain string so this can be constructed as a
 * field initializer BEFORE Game.ts's `?matchBaseUrl=` query-param override applies
 * (mirrors PartyScreen/LoginScreen's own "constructed after the override" comment, but
 * without needing to delay construction — the thunk just reads the current value
 * lazily at save time, once the override has long since landed).
 *
 * The one-time pull-from-server-on-login step is a separate async function
 * (`pullAccountMeta`) since `MetaStore.load()` itself must stay synchronous.
 */
import { createWebMetaStore, migrate, type MetaStore } from './store';
import type { MetaState } from './MetaState';
import { getSession } from '../net/session';
import { fetchAccountMeta, saveAccountMeta } from '../net/auth';

export function createAccountSyncMetaStore(getBaseUrl: () => string): MetaStore {
  const local = createWebMetaStore();
  return {
    load(): MetaState {
      return local.load();
    },
    save(m: MetaState): void {
      local.save(m);
      const session = getSession();
      if (!session) return;
      saveAccountMeta(getBaseUrl(), session.token, m).catch(() => {
        /* best-effort — a dropped sync never blocks or retries local play */
      });
    },
  };
}

/** Pulls this account's server-side MetaState (if any) right after a login/register.
 * `null` means "no server state yet" (brand-new account) — the caller should push the
 * current local state up instead of overwriting it with nothing. */
export async function pullAccountMeta(baseUrl: string, token: string): Promise<MetaState | null> {
  const data = await fetchAccountMeta(baseUrl, token);
  return data ? migrate(data) : null;
}
