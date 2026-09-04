/**
 * The entitlement-delivery seam (design/19-server-platform.md §4 and §2).
 *
 * design/19 §4's central claim is that `orders`, the entitlement grant and `ledger` are
 * written inside ONE `BEGIN IMMEDIATE`, which is precisely why funny's verify-and-heal CAS
 * saga is NOT copied here: that saga exists because funny's receipt row and its wallet
 * increment are separate Mongo documents with no transaction around them, so a crash
 * between the two loses the purchase and two concurrent healers both re-grant. One SQLite
 * file makes that tear impossible, and copying the machinery would import a pile of
 * complexity with no failure behind it.
 *
 * For that claim to hold, the grant has to happen INSIDE the transaction — so it is an
 * injected object called from within it, and a throw from `grant` rolls the order row and
 * the ledger row back with it. That is the contract, and `BillingService`'s tests assert
 * it directly rather than trusting the comment.
 *
 * design/19 §2 puts the `entitlements` table in the CONTROL PLANE's account database,
 * which is a different database file — so this cannot be a table write from here, and a
 * cross-file transaction does not exist. Two constraints therefore meet in this one
 * signature, and they look irreconcilable: the grant must be synchronous and durable
 * inside the transaction, and the only way to reach the table is an HTTP call.
 *
 * The resolution (2026-09-05, and it is why the signature below did not have to change
 * shape) is that `grant` writes a durable PROMISE rather than performing the delivery:
 * `outbox.ts` inserts one `deliveries` row into billsvc's own file, in the same
 * transaction, and `deliveryPump.ts` drains it over the internal seam afterwards. The
 * single-transaction claim §4 rests on is then exactly as strong as it reads — after the
 * COMMIT the obligation is on disk — and the delivery becomes at-least-once, which is safe
 * because `entitlements`' UNIQUE(account_id, sku) makes the receiving grant idempotent.
 * That idempotency is the entire reason an outbox beats a two-phase commit here.
 *
 * `ledgerOnlyDelivery` stays, and is no longer the default anywhere: it is the explicit
 * opt-out for a deployment (or a test) that wants the append-only `ledger` row to be the
 * whole delivery record, replayable into `entitlements` by hand precisely because the
 * ledger is append-only — the same property §7's reconciliation leans on.
 */
import type { SkuGrant } from './skus';

export interface EntitlementGrantRequest {
  /**
   * The `ledger` row's own id, `purchase:<platform>:<txn>` — design/19 §4's named
   * idempotency key, already CLAIMED by the caller before this is called. An implementation
   * that persists anything keys it on this rather than minting its own id: the claim it
   * carries is stronger than one a delivery could make for itself, and sharing the key is
   * what lets a human join a delivery back to the money that caused it in one SQL query.
   */
  ledgerId: string;
  accountId: string;
  /** The SKU that was paid for. */
  sku: string;
  /** What that SKU unlocks — `(kind, id)` pairs, never a quantity or a balance. */
  grants: readonly SkuGrant[];
  orderId: string;
  /** `${platform}:${receipt}` — the row in `receipts` that authorised this grant. */
  receiptId: string;
  ts: number;
}

export interface EntitlementDelivery {
  /**
   * Called INSIDE the settlement transaction, exactly once per delivered order (the
   * caller has already won the idempotency claim, so this never sees a redelivery).
   *
   * Throwing is the documented way to refuse: it aborts the whole settlement, so the
   * order stays open and the platform's next retry can try again. Returning normally is a
   * promise that the grant is durable within this transaction — an implementation that
   * does async work and returns before it completes breaks the guarantee this seam exists
   * to provide, which is why the signature is synchronous and `void`.
   */
  grant(request: EntitlementGrantRequest): void;
}

/**
 * The default: record nothing beyond the `ledger` row `BillingService` already wrote.
 * Not a stub for a missing implementation — it is the correct behaviour until ROADMAP
 * 8.2's `entitlements` table exists to write into (see the file header).
 */
export const ledgerOnlyDelivery: EntitlementDelivery = {
  grant() {
    /* the ledger row is the record */
  },
};
