/**
 * Apple App Store receipt verification — SHAPE ONLY (design/19-server-platform.md §5/§9).
 *
 * No Apple merchant credential exists anywhere in this project, so this adapter cannot be
 * verified past the dev stub and MUST NOT pretend otherwise. It therefore has exactly two
 * outcomes, both failures, and both fail closed: no shared secret configured, or a secret
 * configured but the App Store round trip not implemented. Nothing is ever granted from
 * here. Filling it in is a bounded edit — the credential read and the result mapping are
 * already where they belong.
 *
 * What the real implementation is: POST the base64 receipt plus `password: <sharedSecret>`
 * to `verifyReceipt` (production first, retrying against sandbox only on status 21007),
 * then map the newest `in_app` entry's `product_id` onto `product` and its
 * `original_transaction_id` onto `platformTxnId`. The production-first-then-sandbox order
 * is not optional: doing it the other way round accepts sandbox receipts in production.
 */
import { missingCredentials, type IapVerifyResult } from './types';

export interface AppleCredentials {
  /** App Store Connect shared secret (`DDU_APPLE_SHARED_SECRET`). */
  sharedSecret?: string;
}

export async function verifyAppleReceipt(receipt: string, creds: AppleCredentials): Promise<IapVerifyResult> {
  if (!creds.sharedSecret) return missingCredentials('apple', 'App Store shared secret');
  if (!receipt) return { ok: false, reason: 'apple: empty receipt' };
  return {
    ok: false,
    reason: 'apple: App Store verifyReceipt round trip not implemented — no credential exists to test it against',
  };
}
