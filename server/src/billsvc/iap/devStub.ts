/**
 * The local dev stub (design/19-server-platform.md §5). A receipt of the form
 * `product:<sku>` resolves here with no network call and no merchant account, which is
 * what makes order creation, idempotency, delivery and reconciliation drivable end to end
 * in tests and locally. design/19 states it plainly: this is a LONG-LIVED ASSET, not
 * scaffolding, and it is the only reason the rest of this package can be tested at all
 * given that no Apple/Google/WeChat/Stripe credential exists anywhere in this project.
 *
 * It is also the single most dangerous file here, so it holds no policy: whether the stub
 * may run is decided by `factory.ts` (and, a second time, by `startupGuard.ts`). This file
 * only knows how to parse the prefix.
 */
import type { IapVerifyResult } from './types';

export const DEV_RECEIPT_PREFIX = 'product:';

/** True when `receipt` is addressed to the stub at all. Cheap, and says nothing about policy. */
export function isDevStubReceipt(receipt: string): boolean {
  return receipt.startsWith(DEV_RECEIPT_PREFIX);
}

/** Builds the stub receipt for a SKU — what `paymentParams.ts` hands a dev client. */
export function devStubReceiptFor(sku: string): string {
  return `${DEV_RECEIPT_PREFIX}${sku}`;
}

/**
 * Resolves a `product:<sku>` receipt. Rejects an empty SKU rather than resolving to `''`,
 * which would otherwise sail through as a product that matches no order and produce a
 * confusing mismatch rejection two layers up instead of a clear one here.
 */
export function verifyDevStubReceipt(receipt: string): IapVerifyResult {
  if (!isDevStubReceipt(receipt)) {
    return { ok: false, reason: `dev: receipt is not a "${DEV_RECEIPT_PREFIX}<sku>" stub receipt` };
  }
  const product = receipt.slice(DEV_RECEIPT_PREFIX.length).trim();
  if (!product) return { ok: false, reason: 'dev: stub receipt names no SKU' };
  return { ok: true, product };
}
