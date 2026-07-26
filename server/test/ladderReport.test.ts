/**
 * Placement → rank conversion for the ladder-rating report (design/15, ROADMAP 4.6).
 * Pure, no network — the index.ts wiring around this is intentionally untested
 * directly (same convention as the rest of the socket-glue entrypoint).
 */
import { describe, it, expect } from 'vitest';
import { buildRatingReportBody } from '../src/ladderReport';

describe('buildRatingReportBody', () => {
  it('the winner is place 1; the first-eliminated seat is the worst place', () => {
    // 4 seats: winner is seat 1; placements (elimination order) = [2, 3, 0] — seat 2
    // died first (worst, place 4), seat 0 died last before the winner (place 2).
    const body = buildRatingReportBody('room1', 1, [2, 3, 0]);
    const byAccount = new Map(body.accountIds.map((id, i) => [id, body.places[i]]));
    expect(byAccount.get('seat:room1:1')).toBe(1); // winner
    expect(byAccount.get('seat:room1:0')).toBe(2); // last-eliminated → 2nd place
    expect(byAccount.get('seat:room1:3')).toBe(3);
    expect(byAccount.get('seat:room1:2')).toBe(4); // first-eliminated → worst place
  });

  it('produces one entry per seat, index-aligned between accountIds and places', () => {
    const body = buildRatingReportBody('r', 0, [1]);
    expect(body.accountIds).toHaveLength(2);
    expect(body.places).toHaveLength(2);
    expect(body.accountIds.length).toBe(body.places.length);
  });

  it('a 2-seat match: winner is 1st, the sole loser is 2nd', () => {
    const body = buildRatingReportBody('r2', 0, [1]);
    const byAccount = new Map(body.accountIds.map((id, i) => [id, body.places[i]]));
    expect(byAccount.get('seat:r2:0')).toBe(1);
    expect(byAccount.get('seat:r2:1')).toBe(2);
  });

  it('accountIds are scoped per room (two rooms never collide)', () => {
    const a = buildRatingReportBody('roomA', 0, [1]);
    const b = buildRatingReportBody('roomB', 0, [1]);
    expect(a.accountIds[0]).not.toBe(b.accountIds[0]);
    expect(a.accountIds[0]).toBe('seat:roomA:0');
    expect(b.accountIds[0]).toBe('seat:roomB:0');
  });
});
