/**
 * The client half of server-owned entitlements (design/19-server-platform.md §2, ROADMAP
 * 8.2). Same injected-`fetch` shape as `net/auth.ts`/`net/party.ts`, so it is unit-testable
 * without a network.
 *
 * The one thing worth understanding before reading `pullAccountMeta` (meta/accountSync.ts):
 * **the server now overwrites the ownership fields of the blob it returns**, from its own
 * `entitlements` table. This client does not fight that and does not need to — the free
 * baseline it would otherwise be afraid of losing is re-supplied locally, by `migrate()`,
 * which unions `STARTER_BLUEPRINTS` and `FREE_CHARACTERS` back in on every load
 * (meta/store.ts). So for a player who owns nothing paid — which is every player today —
 * the ownership arrays before and after login are identical, and the Forge does not
 * flicker or roll back. What CAN disappear is ownership the client granted ITSELF, which
 * is exactly the hole ROADMAP 8.2 closes.
 *
 * `fetchAccountState` supersedes `net/auth.ts`'s `fetchAccountMeta`: it reads the same
 * route, but keeps the `entitlements` array the response now carries alongside `data`
 * instead of discarding it. One round trip, no second route.
 */

/** Mirrors the server's `ENTITLEMENT_SOURCES` (server/src/EntitlementService.ts). Only
 * `purchase` implies money moved; the rest are grants, campaigns, gifts and run drops. A
 * store UI needs this to say "owned" differently from "bought". */
export const ENTITLEMENT_SOURCES = ['purchase', 'grant', 'event', 'starter', 'drop'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export interface Entitlement {
  sku: string;
  source: EntitlementSource;
  grantedAt: number;
}

/** Namespaced exactly as the server writes them (`EntitlementService.ts`) — one table,
 * two namespaces, and a blueprint id that can never collide with a skin id. */
export const BLUEPRINT_SKU_PREFIX = 'blueprint:';
export const CHARACTER_SKU_PREFIX = 'character:';

export interface EntitlementOwnership {
  unlockedBlueprints: string[];
  ownedCharacters: string[];
}

/**
 * Project entitlements onto the two `MetaState` ownership arrays. Deliberately the same
 * rules as the server's `skusToOwnership`: an unknown namespace and an empty id are both
 * SKIPPED rather than rejected, so a SKU billsvc later sells that is neither a blueprint
 * nor a character cannot break the Forge.
 */
export function entitlementOwnership(list: readonly Entitlement[]): EntitlementOwnership {
  const own: EntitlementOwnership = { unlockedBlueprints: [], ownedCharacters: [] };
  for (const e of list) {
    if (e.sku.startsWith(BLUEPRINT_SKU_PREFIX)) {
      const id = e.sku.slice(BLUEPRINT_SKU_PREFIX.length);
      if (id) own.unlockedBlueprints.push(id);
    } else if (e.sku.startsWith(CHARACTER_SKU_PREFIX)) {
      const id = e.sku.slice(CHARACTER_SKU_PREFIX.length);
      if (id) own.ownedCharacters.push(id);
    }
  }
  return own;
}

/**
 * Defensive parse of the wire array. Everything about a response is untrusted here for the
 * same reason `migrate()` distrusts a localStorage save: an older/newer server, a proxy's
 * error page, or a half-written response must degrade to "owns nothing extra" rather than
 * throw somewhere deep inside the Forge. A malformed ENTRY is dropped on its own; it never
 * discards the entries around it.
 */
export function parseEntitlements(raw: unknown): Entitlement[] {
  if (!Array.isArray(raw)) return [];
  const out: Entitlement[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { sku, source, grantedAt } = item as Partial<Entitlement>;
    if (typeof sku !== 'string' || sku.length === 0) continue;
    if (typeof source !== 'string' || !(ENTITLEMENT_SOURCES as readonly string[]).includes(source)) continue;
    out.push({ sku, source: source as EntitlementSource, grantedAt: typeof grantedAt === 'number' ? grantedAt : 0 });
  }
  return out;
}

export interface AccountStateCallOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface AccountState {
  /** The stored `MetaState` blob with its ownership fields already overwritten by the
   * server, or `null` when this account has never saved one. */
  data: unknown | null;
  entitlements: Entitlement[];
}

/**
 * `GET /account/meta` — the account's stored meta blob AND what the server says it owns.
 *
 * Guarded `res.json()` for the same reason every call in `net/auth.ts` is: a non-2xx can
 * come back as a proxy's HTML error page, which would otherwise throw a raw SyntaxError
 * instead of the clean `Error` the caller's `.catch()` expects.
 */
export async function fetchAccountState(
  baseUrl: string,
  token: string,
  opts: AccountStateCallOptions = {},
): Promise<AccountState> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}/account/meta`, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => null)) as { data?: unknown; entitlements?: unknown; error?: string } | null;
  if (!res.ok || json?.error) throw new Error(json?.error ?? `account request failed (${res.status})`);
  return { data: json?.data ?? null, entitlements: parseEntitlements(json?.entitlements) };
}
