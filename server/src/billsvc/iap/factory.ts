/**
 * The credential-reading dispatch (design/19-server-platform.md §5): one factory that
 * closes over an environment and returns a `ReceiptVerifier`. Borrowed shape — funny's
 * `commercial/src/iap/` is a per-platform set of independent functions behind one
 * factory, which is CLAUDE.md's preferred split form and survived four platforms there.
 *
 * FAIL CLOSED, FIRST OF TWO DEFENCES. This file enforces:
 *
 *   1. Under `NODE_ENV=production` the dev stub is off, FULL STOP — `DDU_BILLING_DEV_STUB`
 *      is not consulted at all, so a mis-set env var on a production box cannot switch it
 *      back on.
 *   2. Missing credentials mean VERIFICATION FAILS. There is no fallback to the stub, in
 *      any environment. A platform with nothing configured returns a failure (never a
 *      throw, so one unconfigured platform cannot 500 the webhook route for the others),
 *      and a failure grants nothing.
 *
 * The second defence is `../startupGuard.ts`, which refuses to START the process with the
 * dev flag set in production. design/19: "One of those checks is the design; two is the
 * design surviving a deploy." The two deliberately share no code — see that file's note.
 */
import { verifyAppleReceipt } from './apple';
import { verifyGoogleReceipt } from './google';
import { verifyWechatReceipt } from './wechat';
import { verifyStripeReceipt } from './stripe';
import { isDevStubReceipt, verifyDevStubReceipt } from './devStub';
import type { IapPlatform, IapVerifyResult, ReceiptVerifier } from './types';

/** Only the variables this layer reads — a plain record so tests need no `process.env`. */
export type BillingEnv = Readonly<Record<string, string | undefined>>;

/** True for the one value that means "this is a production deployment". */
export function isProductionEnv(env: BillingEnv): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Whether the `product:<sku>` stub may resolve receipts.
 *
 * The production check comes FIRST and returns without reading the flag, which is the
 * whole point: the ordering is what makes a mis-set `DDU_BILLING_DEV_STUB=1` on a
 * production box inert rather than catastrophic.
 */
export function devStubEnabled(env: BillingEnv): boolean {
  if (isProductionEnv(env)) return false;
  const flag = env.DDU_BILLING_DEV_STUB;
  return flag === '1' || flag === 'true';
}

export function createReceiptVerifier(env: BillingEnv = process.env): ReceiptVerifier {
  const stub = devStubEnabled(env);
  const apple = { sharedSecret: env.DDU_APPLE_SHARED_SECRET };
  const google = {
    serviceAccountJson: env.DDU_GOOGLE_SERVICE_ACCOUNT_JSON,
    packageName: env.DDU_GOOGLE_PACKAGE_NAME,
  };
  const wechat = { mchId: env.DDU_WECHAT_MCH_ID, apiV3Key: env.DDU_WECHAT_API_V3_KEY };
  const stripe = { secretKey: env.DDU_STRIPE_SECRET_KEY, webhookSecret: env.DDU_STRIPE_WEBHOOK_SECRET };

  return async (platform: IapPlatform, receipt: string): Promise<IapVerifyResult> => {
    // A `product:` receipt resolves locally on ANY platform while the stub is enabled —
    // that is what lets `/webhook/apple` be driven end to end with no Apple account. When
    // the stub is off, the same receipt falls through to the real adapter and fails there,
    // which is the correct answer and NOT a fallback in the other direction.
    if (stub && isDevStubReceipt(receipt)) return verifyDevStubReceipt(receipt);

    switch (platform) {
      case 'apple':
        return verifyAppleReceipt(receipt, apple);
      case 'google':
        return verifyGoogleReceipt(receipt, google);
      case 'wechat':
        return verifyWechatReceipt(receipt, wechat);
      case 'stripe':
        return verifyStripeReceipt(receipt, stripe);
      case 'dev':
        // Reached only when the stub is disabled, or when the receipt is malformed for it.
        return stub
          ? verifyDevStubReceipt(receipt)
          : { ok: false, reason: 'dev: the dev stub is disabled in this environment' };
    }
  };
}
