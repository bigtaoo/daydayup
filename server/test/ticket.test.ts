/**
 * Match ticket sign/verify (ROADMAP 3.3). The tamper-proof handshake the control plane
 * issues and the gameserver trusts — so its rejection surface (bad sig, wrong secret,
 * expiry, malformed) is the security boundary and gets pinned here.
 */
import { describe, it, expect } from 'vitest';
import { signTicket, verifyTicket, type TicketPayload } from '../src/ticket';

const SECRET = 'test-secret';
const payload: TicketPayload = { roomId: 'r1', owner: 1, seed: 42, playerCount: 2, exp: 10_000 };

describe('ticket — round-trip', () => {
  it('verifies a freshly-signed ticket before expiry and returns the exact payload', () => {
    const token = signTicket(payload, SECRET);
    expect(verifyTicket(token, SECRET, 9_999)).toEqual(payload);
  });

  it('round-trips every field including negative/large seeds', () => {
    const p: TicketPayload = { roomId: 'room-xyz', owner: 3, seed: -2_000_000_000, playerCount: 4, exp: 1 };
    expect(verifyTicket(signTicket(p, SECRET), SECRET, 0)).toEqual(p);
  });
});

describe('ticket — rejection surface', () => {
  it('rejects a wrong secret', () => {
    const token = signTicket(payload, SECRET);
    expect(verifyTicket(token, 'other-secret', 0)).toBeNull();
  });

  it('rejects a tampered body (owner escalation)', () => {
    const token = signTicket(payload, SECRET);
    const sig = token.split('.')[1];
    const forged = Buffer.from(JSON.stringify({ ...payload, owner: 0 }), 'utf8').toString('base64url');
    expect(verifyTicket(`${forged}.${sig}`, SECRET, 0)).toBeNull();
  });

  it('rejects an expired ticket even with a valid signature', () => {
    const token = signTicket(payload, SECRET);
    expect(verifyTicket(token, SECRET, payload.exp + 1)).toBeNull();
    expect(verifyTicket(token, SECRET, payload.exp)).toEqual(payload); // exp is inclusive
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'nodot', '.sigonly', 'bodyonly.', 'a.b.c', 'not-base64!.x']) {
      expect(verifyTicket(bad, SECRET, 0)).toBeNull();
    }
  });

  it('rejects a truncated / wrong-length signature without throwing', () => {
    const token = signTicket(payload, SECRET);
    const body = token.split('.')[0];
    expect(verifyTicket(`${body}.short`, SECRET, 0)).toBeNull();
  });
});
