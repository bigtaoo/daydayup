/**
 * Google Play purchase verification — SHAPE ONLY (design/19-server-platform.md §5/§9).
 * Same posture as `apple.ts`: two outcomes, both failures, nothing ever granted.
 *
 * What the real implementation is: a service-account JWT exchanged for an access token,
 * then `GET androidpublisher/v3/applications/{pkg}/purchases/products/{sku}/tokens/{token}`,
 * accepting only `purchaseState === 0`. Google's receipt is a JSON envelope carrying both
 * `productId` and `purchaseToken`, so unlike Apple the SKU is readable before the call —
 * which is a trap, not a shortcut: the envelope is client-supplied, so `product` must come
 * from the API response, never from the envelope the client sent.
 */
import { missingCredentials, type IapVerifyResult } from './types';

export interface GoogleCredentials {
  /** Service-account JSON (`DDU_GOOGLE_SERVICE_ACCOUNT_JSON`). */
  serviceAccountJson?: string;
  /** Android package name (`DDU_GOOGLE_PACKAGE_NAME`). */
  packageName?: string;
}

export async function verifyGoogleReceipt(receipt: string, creds: GoogleCredentials): Promise<IapVerifyResult> {
  if (!creds.serviceAccountJson) return missingCredentials('google', 'Play service-account JSON');
  if (!creds.packageName) return missingCredentials('google', 'Android package name');
  if (!receipt) return { ok: false, reason: 'google: empty receipt' };
  return {
    ok: false,
    reason: 'google: Play Developer API round trip not implemented — no credential exists to test it against',
  };
}
