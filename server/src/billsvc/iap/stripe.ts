/**
 * Stripe checkout verification — SHAPE ONLY (design/19-server-platform.md §5/§9).
 * Same posture as `apple.ts`: two outcomes, both failures, nothing ever granted.
 *
 * What the real implementation is: retrieve the Checkout Session / PaymentIntent by id
 * with the secret key and accept only `payment_status === 'paid'`. Stripe additionally
 * signs its webhook body (`Stripe-Signature`, an HMAC over `t=<ts>.<body>`), which is the
 * "authenticated by the platform's own signature instead" clause in design/19 §3 — a
 * webhook signature check belongs on the route, not in this file, because it authenticates
 * the CALLER rather than the purchase.
 */
import { missingCredentials, type IapVerifyResult } from './types';

export interface StripeCredentials {
  /** Secret API key (`DDU_STRIPE_SECRET_KEY`). */
  secretKey?: string;
  /** Webhook signing secret (`DDU_STRIPE_WEBHOOK_SECRET`). */
  webhookSecret?: string;
}

export async function verifyStripeReceipt(receipt: string, creds: StripeCredentials): Promise<IapVerifyResult> {
  if (!creds.secretKey) return missingCredentials('stripe', 'secret API key');
  if (!receipt) return { ok: false, reason: 'stripe: empty session id' };
  return {
    ok: false,
    reason: 'stripe: Checkout Session retrieval not implemented — no API key exists to test it against',
  };
}
