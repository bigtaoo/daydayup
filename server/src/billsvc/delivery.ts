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
 * cross-file transaction does not exist. The implementation that closes the loop is
 * therefore an internal call into the control plane, which is ROADMAP 8.2's work, not this
 * package's. What ships here is the seam plus `ledgerOnlyDelivery`, under which the
 * append-only `ledger` row IS the delivery record: hand-auditable with SQL, and replayable
 * into `entitlements` once that table exists (the ledger being append-only is what makes
 * that replay safe, and is the same property §7's reconciliation leans on).
 */
import type { SkuGrant } from './skus';

export interface EntitlementGrantRequest {
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
