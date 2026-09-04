/**
 * IAP verification contract (design/19-server-platform.md §5). Split: this file is the
 * shared types only, one sibling file per platform holds that platform's verification,
 * and `factory.ts` holds the credential-reading dispatch — CLAUDE.md's preferred
 * "independent function modules" form, and the shape funny's `commercial/src/iap/`
 * carried across four platforms.
 *
 * WHERE funny's ASSUMPTION INVERTS. funny sells a currency, so its verify result is
 * coins-first with a non-coin product as a secondary branch. `design/14-meta-forging.md`
 * locks bounded direct purchase with no gacha and NO wallet, so that secondary branch is
 * the only branch here and the coin fields do not exist at all. There is deliberately no
 * `coins`, no balance and no wallet anywhere in this type — a field like that is how an
 * economy gets imported by accident (design/19 §8).
 */

/** Platforms the dispatch knows. `'dev'` is the local stub, never a real merchant. */
export type IapPlatform = 'apple' | 'google' | 'wechat' | 'stripe' | 'dev';

const PLATFORMS: readonly string[] = ['apple', 'google', 'wechat', 'stripe', 'dev'];

/** Narrows an arbitrary path/body string to a known platform, or `undefined`. */
export function asIapPlatform(value: unknown): IapPlatform | undefined {
  return typeof value === 'string' && PLATFORMS.includes(value) ? (value as IapPlatform) : undefined;
}

export interface IapVerifyOk {
  ok: true;
  /**
   * The SKU id this receipt resolved to. Persisted onto the `receipts` row, and compared
   * against the order's own SKU before anything is delivered: without it a receipt bought
   * for one SKU can be replayed to claim another (design/19 §4).
   */
  product: string;
  /**
   * What the platform says it charged, in minor units. ADVISORY ONLY — the amount an
   * order is booked at comes from the server-side SKU table, never from a receipt and
   * never from a request body (design/19 §4). Kept because a mismatch is a real signal
   * for §7's reconciliation, not because anything charges off it.
   */
  amountCents?: number;
  /** The platform's own transaction id, when the receipt itself carries one. */
  platformTxnId?: string;
}

export interface IapVerifyFail {
  ok: false;
  /** Operator-facing, logged; never surfaced verbatim to a client. */
  reason: string;
}

export type IapVerifyResult = IapVerifyOk | IapVerifyFail;

/**
 * Async because a real adapter is an HTTPS call to the platform. Every caller must
 * verify BEFORE opening the settlement transaction — `BillingService` does, and the
 * reason is that holding SQLite's `BEGIN IMMEDIATE` write lock across a network round
 * trip would serialise every settlement behind the slowest platform response.
 */
export type ReceiptVerifier = (platform: IapPlatform, receipt: string) => Promise<IapVerifyResult>;

/** A credential read that came back empty — the fail-closed answer, not a throw. */
export function missingCredentials(platform: IapPlatform, what: string): IapVerifyFail {
  return { ok: false, reason: `${platform}: ${what} not configured — cannot verify, nothing granted` };
}
