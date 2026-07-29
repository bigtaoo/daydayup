/**
 * PartyService (design/05/15 PvP squad follow-up). Drives the pure core with injected
 * fakes (hand-advanced clock, deterministic id/code source) — mirrors
 * Matchmaker.test.ts's style.
 */
import { describe, it, expect } from 'vitest';
import { PartyService, MAX_PARTY_SIZE, type PartyServiceDeps } from '../src/PartyService';

function make(overrides: Partial<PartyServiceDeps> = {}) {
  let now = 1_000;
  let partyN = 0;
  let codeN = 0;
  const deps: PartyServiceDeps = {
    nowMs: () => now,
    newPartyId: () => `party-${++partyN}`,
    newCode: () => `CODE${++codeN}`,
    ...overrides,
  };
  const svc = new PartyService(deps);
  return { svc, advance: (ms: number) => (now += ms) };
}

describe('PartyService — create/join/leave', () => {
  it('creates a party with the creator as sole member and leader', () => {
    const { svc } = make();
    const p = svc.create('alice');
    expect(p).toMatchObject({ leaderId: 'alice', members: ['alice'], matching: false });
    expect(p.code).toBeTruthy();
    expect(p.partyId).toBeTruthy();
  });

  it('lets another player join via the code', () => {
    const { svc } = make();
    const p = svc.create('alice');
    const joined = svc.join(p.code, 'bob');
    expect(joined).toMatchObject({ partyId: p.partyId, members: ['alice', 'bob'] });
  });

  it('joining twice with the same playerId is idempotent, not a duplicate', () => {
    const { svc } = make();
    const p = svc.create('alice');
    svc.join(p.code, 'bob');
    const again = svc.join(p.code, 'bob');
    expect(again!.members).toEqual(['alice', 'bob']);
  });

  it('rejects join on an unknown code', () => {
    const { svc } = make();
    expect(svc.join('NOPE', 'bob')).toBeNull();
  });

  it(`caps membership at MAX_PARTY_SIZE (${MAX_PARTY_SIZE})`, () => {
    const { svc } = make();
    const p = svc.create('p0');
    for (let i = 1; i < MAX_PARTY_SIZE; i++) {
      expect(svc.join(p.code, `p${i}`)).not.toBeNull();
    }
    expect(svc.join(p.code, 'overflow')).toBeNull();
    expect(svc.get(p.partyId)!.members).toHaveLength(MAX_PARTY_SIZE);
  });

  it('leaving reassigns leadership to the next member, never leaves it dangling', () => {
    const { svc } = make();
    const p = svc.create('alice');
    svc.join(p.code, 'bob');
    const afterLeave = svc.leave(p.partyId, 'alice');
    expect(afterLeave).toMatchObject({ leaderId: 'bob', members: ['bob'] });
  });

  it('dissolves the party once the last member leaves, freeing the code', () => {
    const { svc } = make();
    const p = svc.create('alice');
    expect(svc.leave(p.partyId, 'alice')).toBeNull();
    expect(svc.get(p.partyId)).toBeNull();
    // The code is free again — a fresh party could theoretically reuse it (not
    // asserted here since newCode() never repeats in this fake), but joining the old
    // code must now fail rather than resurrecting the dissolved party.
    expect(svc.join(p.code, 'carol')).toBeNull();
  });

  it('leave on an unknown partyId is a no-op null, not a throw', () => {
    const { svc } = make();
    expect(svc.leave('nope', 'alice')).toBeNull();
  });
});

describe('PartyService — startMatching', () => {
  it('only the leader can start matching', () => {
    const { svc } = make();
    const p = svc.create('alice');
    svc.join(p.code, 'bob');
    expect(svc.startMatching(p.partyId, 'bob')).toBeNull(); // not the leader
    const started = svc.startMatching(p.partyId, 'alice');
    expect(started!.matching).toBe(true);
    expect(svc.get(p.partyId)!.matching).toBe(true);
  });

  it('returns null for an unknown party', () => {
    const { svc } = make();
    expect(svc.startMatching('nope', 'alice')).toBeNull();
  });
});

describe('PartyService — expiry', () => {
  it('an idle party expires after its TTL and frees its code', () => {
    const { svc, advance } = make();
    const p = svc.create('alice');
    advance(10 * 60_000 + 1); // past the default 10 min idle TTL
    expect(svc.get(p.partyId)).toBeNull();
    expect(svc.join(p.code, 'bob')).toBeNull();
  });

  it('activity (join/leave/startMatching) resets the idle clock', () => {
    const { svc, advance } = make();
    const p = svc.create('alice');
    advance(9 * 60_000);
    svc.join(p.code, 'bob'); // refreshes updatedAt
    advance(9 * 60_000); // would have expired from create-time alone, not from join-time
    expect(svc.get(p.partyId)).not.toBeNull();
  });
});
