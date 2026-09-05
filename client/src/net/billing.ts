/**
 * The client half of the store (design/19-server-platform.md §4). Same injected-`fetch`
 * shape as `net/auth.ts`/`net/entitlements.ts`, so the whole purchase flow is unit-testable
 * with no network.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP. Price comes from the server. `StoreSku.amountCents`
 * is read off the wire and rendered; it is never derived, discounted, summed or compared
 * against anything the client knows. There is deliberately no local SKU table here to drift
 * against `server/src/billsvc/skus.ts`, and `createOrder` sends `{ sku, platform }` and
 * nothing else — an `amount` in the body would be discarded server-side anyway, so sending
 * one would only create the illusion that the client has a say.
 *
 * All three routes carry the PLAYER's bearer session (`net/session.ts`), not an internal
 * key: they are the account's own store, and every one of them is answered relative to
 * whoever the token names.
 *
 * Everything off the wire is parsed defensively, for the same reason `parseEntitlements` is:
 * an older/newer server, a proxy's HTML error page, or a half-written response must degrade
 * to "nothing to sell" rather than throw somewhere deep inside a Pixi screen. A malformed
 * SKU is dropped on its own and never discards the ones around it.
 */

/** Mirrors `server/src/billsvc/skus.ts`'s `SkuGrantKind`. A SKU grants a NAMED, finite
 * thing — there is no wallet and no quantity anywhere in this type, on purpose. */
export type SkuGrantKind = 'blueprint' | 'character';

export interface SkuGrant {
  kind: SkuGrantKind;
  /** A `BLUEPRINT_CATALOG` key, or a `SKIN_DEFS` key. */
  id: string;
}

export interface StoreSku {
  sku: string;
  /** Operator/store-facing label from the server table. The client renders its own
   * localised weapon name from `grants` where it can, and falls back to this. */
  title: string;
  /** Minor units of `currency`. THE price — see this file's header. */
  amountCents: number;
  currency: string;
  grants: SkuGrant[];
}

/** Mirrors `BillingService`'s `OrderState`. `'settled'` is the delivered/terminal-success
 * arm: `BillingService.settle` writes the ledger row AND calls `deliver.grant` inside the
 * same transaction that flips the state, so an order this client sees as `settled` has an
 * entitlement behind it. `'failed'` is terminal too; `'created'` is the only open one. */
export type OrderState = 'created' | 'settled' | 'failed';

export interface StoreOrder {
  id: string;
  sku: string;
  platform: string;
  amountCents: number;
  currency: string;
  state: OrderState;
}

/**
 * `server/src/billsvc/paymentParams.ts`'s block, verbatim. `configured: false` is the
 * answer four of the five platforms always give, because no merchant credentials exist in
 * this project (design/19 §9) — it is an honest refusal, not an error, and the client must
 * say so rather than proceeding into an SDK that would fail generically.
 */
export interface PaymentParams {
  configured: boolean;
  params: Record<string, string>;
  /** Operator-facing note. Logged/shown in dev tooling; never the player-facing copy. */
  note?: string;
}

export interface BillingCallOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const GRANT_KINDS: readonly string[] = ['blueprint', 'character'];
const ORDER_STATES: readonly string[] = ['created', 'settled', 'failed'];

/** Guarded `res.json()` for the reason every call in `net/auth.ts` is guarded: a non-2xx can
 * come back as a proxy's HTML error page, which would otherwise throw a raw SyntaxError
 * instead of the clean `Error` each caller's `.catch()` expects. */
async function call<T>(
  baseUrl: string,
  path: string,
  token: string,
  init: RequestInit,
  opts: BillingCallOptions,
): Promise<T> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || json?.error) throw new Error(json?.error ?? `store request failed (${res.status})`);
  if (!json) throw new Error(`store request returned no body (${res.status})`);
  return json;
}

function parseGrants(raw: unknown): SkuGrant[] {
  if (!Array.isArray(raw)) return [];
  const out: SkuGrant[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { kind, id } = item as Partial<SkuGrant>;
    if (typeof kind !== 'string' || !GRANT_KINDS.includes(kind)) continue;
    if (typeof id !== 'string' || id.length === 0) continue;
    out.push({ kind: kind as SkuGrantKind, id });
  }
  return out;
}

/**
 * One listing row, or `null` if it is unusable. A row with no `amountCents` is dropped
 * rather than defaulted: a SKU whose price did not arrive must not be offered at all, since
 * every fallback number here would be a price the client invented.
 */
export function parseSku(raw: unknown): StoreSku | null {
  if (!raw || typeof raw !== 'object') return null;
  const { sku, title, amountCents, currency, grants } = raw as Partial<StoreSku>;
  if (typeof sku !== 'string' || sku.length === 0) return null;
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents) || amountCents < 0) return null;
  if (typeof currency !== 'string' || currency.length === 0) return null;
  return {
    sku,
    title: typeof title === 'string' && title.length > 0 ? title : sku,
    amountCents,
    currency,
    grants: parseGrants(grants),
  };
}

export function parseOrder(raw: unknown): StoreOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, sku, platform, amountCents, currency, state } = raw as Partial<StoreOrder>;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof state !== 'string' || !ORDER_STATES.includes(state)) return null;
  return {
    id,
    sku: typeof sku === 'string' ? sku : '',
    platform: typeof platform === 'string' ? platform : '',
    amountCents: typeof amountCents === 'number' && Number.isFinite(amountCents) ? amountCents : 0,
    currency: typeof currency === 'string' ? currency : '',
    state: state as OrderState,
  };
}

function parsePayment(raw: unknown): PaymentParams {
  // FAIL CLOSED. Anything that is not an explicit `configured: true` is treated as "this
  // platform cannot take a payment" — a response shape this client does not understand must
  // not be read as permission to charge someone.
  if (!raw || typeof raw !== 'object') return { configured: false, params: {} };
  const { configured, params, note } = raw as Partial<PaymentParams>;
  return {
    configured: configured === true,
    params: params && typeof params === 'object' ? { ...(params as Record<string, string>) } : {},
    ...(typeof note === 'string' ? { note } : {}),
  };
}

/** `GET /store/skus` — what this account can buy, at the server's prices. */
export async function listStoreSkus(baseUrl: string, token: string, opts: BillingCallOptions = {}): Promise<StoreSku[]> {
  const json = await call<{ skus?: unknown }>(baseUrl, '/store/skus', token, {}, opts);
  if (!Array.isArray(json.skus)) return [];
  return json.skus.map(parseSku).filter((s): s is StoreSku => s !== null);
}

/**
 * `POST /store/order` — book an order and get back this platform's payment block.
 *
 * Throws on a rejected order (a 400 for an unknown SKU, a 401 for a stale token), which is
 * the caller's "could not order" branch. A SUCCESSFUL order whose `payment.configured` is
 * false is not an error and does not throw: the order exists, it simply cannot be paid here.
 */
export async function createStoreOrder(
  baseUrl: string,
  token: string,
  sku: string,
  platform: string,
  opts: BillingCallOptions = {},
): Promise<{ order: StoreOrder; payment: PaymentParams }> {
  const json = await call<{ order?: unknown; payment?: unknown }>(
    baseUrl,
    '/store/order',
    token,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sku, platform }) },
    opts,
  );
  const order = parseOrder(json.order);
  if (!order) throw new Error('store order response carried no usable order');
  return { order, payment: parsePayment(json.payment) };
}

/** `GET /store/order/:id` — the poll. */
export async function fetchStoreOrder(
  baseUrl: string,
  token: string,
  orderId: string,
  opts: BillingCallOptions = {},
): Promise<StoreOrder> {
  const json = await call<{ order?: unknown }>(baseUrl, `/store/order/${encodeURIComponent(orderId)}`, token, {}, opts);
  const order = parseOrder(json.order);
  if (!order) throw new Error('store order response carried no usable order');
  return order;
}

/**
 * Render the SERVER's amount for display. Deliberately the only arithmetic this client does
 * with money, and it is presentational: minor units → major units for one already-decided
 * price. Nothing here totals, discounts, converts or compares — see this file's header.
 *
 * `Intl` is feature-detected rather than assumed: the WeChat mini-game runtime has
 * historically shipped without a full ICU, and a missing formatter must degrade to a
 * readable string rather than throw inside a screen's render.
 */
export function formatSkuPrice(amountCents: number, currency: string): string {
  const major = amountCents / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${currency}`;
  }
}
