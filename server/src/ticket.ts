/**
 * Match tickets (ROADMAP 3.3, design/06) — the tamper-proof handshake the matchmaking
 * control plane issues and the gameserver verifies. A ticket is the signed statement
 * "this client may take seat `owner` in room `roomId`, which runs `seed`/`playerCount`,
 * until `exp`". It closes the spoofing hole the raw-param handshake left open (a client
 * could claim any seat/seed): the gameserver now derives those values from a VERIFIED
 * ticket instead of trusting query params.
 *
 * Stateless HMAC-SHA256 — the matchsvc and the gameserver share only a secret, never a
 * store (mirrors funny's matchsvc "signs these params"). Format: `b64url(json).b64url(sig)`,
 * the compact JWT-shape without the algorithm-negotiation footguns (the algorithm is fixed).
 *
 * Pure of any env/global: the secret and the clock are passed in, so it is unit-testable
 * without configuration and either side (svc/server) wires its own secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MatchMode } from '@dd/engine';

export type { MatchMode };

/** The signed seat grant. `exp` is an absolute epoch-ms deadline (verify rejects past it). */
export interface TicketPayload {
  roomId: string;
  owner: number;
  seed: number;
  playerCount: number;
  exp: number;
  mode?: MatchMode;
}

const b64urlEncode = (s: string): string =>
  Buffer.from(s, 'utf8').toString('base64url');
const b64urlDecode = (s: string): string =>
  Buffer.from(s, 'base64url').toString('utf8');

const sign = (body: string, secret: string): string =>
  createHmac('sha256', secret).update(body).digest('base64url');

/** Sign a payload into a `body.sig` token. The caller sets `exp` (svc uses now + TTL). */
export function signTicket(payload: TicketPayload, secret: string): string {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a token against `secret` at `nowMs`. Returns the payload only if the signature
 * matches (constant-time) AND it has not expired; otherwise `null` — a bad signature,
 * a tampered body, a malformed token, and an expired-but-valid ticket are indistinguishable
 * to the caller (all "reject and close"), which is the posture we want.
 */
export function verifyTicket(token: string, secret: string, nowMs: number): TicketPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(body, secret);
  // timingSafeEqual throws on length mismatch — guard first so a wrong-length sig is a
  // plain reject, not an exception.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: TicketPayload;
  try {
    payload = JSON.parse(b64urlDecode(body)) as TicketPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.roomId !== 'string' ||
    !Number.isInteger(payload.owner) ||
    !Number.isInteger(payload.seed) ||
    !Number.isInteger(payload.playerCount) ||
    typeof payload.exp !== 'number' ||
    (payload.mode !== undefined && payload.mode !== 'coop' && payload.mode !== 'pvp')
  ) {
    return null;
  }
  if (nowMs > payload.exp) return null; // expired
  return payload;
}
