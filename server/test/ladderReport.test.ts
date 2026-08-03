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
    const body = buildRatingReportBody('room1', 1, [2, 3, 0], 4);
    const byAccount = new Map(body.accountIds.map((id, i) => [id, body.places[i]]));
    expect(byAccount.get('seat:room1:1')).toBe(1); // winner
    expect(byAccount.get('seat:room1:0')).toBe(2); // last-eliminated → 2nd place
    expect(byAccount.get('seat:room1:3')).toBe(3);
    expect(byAccount.get('seat:room1:2')).toBe(4); // first-eliminated → worst place
  });

  it('produces one entry per seat, index-aligned across accountIds/places/teamIds', () => {
    const body = buildRatingReportBody('r', 0, [1], 2);
    expect(body.accountIds).toHaveLength(2);
    expect(body.places).toHaveLength(2);
    expect(body.teamIds).toHaveLength(2);
    expect(body.accountIds.length).toBe(body.places.length);
  });

  it('a 2-seat match: winner is 1st, the sole loser is 2nd', () => {
    const body = buildRatingReportBody('r2', 0, [1], 2);
    const byAccount = new Map(body.accountIds.map((id, i) => [id, body.places[i]]));
    expect(byAccount.get('seat:r2:0')).toBe(1);
    expect(byAccount.get('seat:r2:1')).toBe(2);
  });

  it('accountIds are scoped per room (two rooms never collide)', () => {
    const a = buildRatingReportBody('roomA', 0, [1], 2);
    const b = buildRatingReportBody('roomB', 0, [1], 2);
    expect(a.accountIds[0]).not.toBe(b.accountIds[0]);
    expect(a.accountIds[0]).toBe('seat:roomA:0');
    expect(b.accountIds[0]).toBe('seat:roomB:0');
  });

  it('a solo/FFA match (squad size 1): every seat gets its own singleton teamId', () => {
    const body = buildRatingReportBody('r', 1, [2, 3, 0], 4);
    const teamBySeat = new Map(body.accountIds.map((id, i) => [id, body.teamIds[i]]));
    const values = new Set(teamBySeat.values());
    expect(values.size).toBe(4); // every seat its own team — no grouping
  });
});

describe('buildRatingReportBody — squad-aware (design/05/15 squad follow-up)', () => {
  // 8 seats, SQUAD_SIZE=4 → 2 squads: team0 = seats 0-3, team1 = seats 4-7.
  // Team1 is wiped (WinConditionSystem.tickPlacement pushes every one of its seats in
  // one batch); team0's seat 0 is the named `winner`, but seats 1-3 never appear in
  // `placements` OR `winner` — this is exactly the gap the playerCount param closes.
  it('every member of the winning squad is tied for 1st, not just the named winner seat', () => {
    const body = buildRatingReportBody('arena1', 0, [4, 5, 6, 7], 8);
    const byAccount = new Map(body.accountIds.map((id, i) => [id, body.places[i]]));
    expect(byAccount.get('seat:arena1:0')).toBe(1); // named winner
    expect(byAccount.get('seat:arena1:1')).toBe(1); // squadmate, never in placements/winner
    expect(byAccount.get('seat:arena1:2')).toBe(1);
    expect(byAccount.get('seat:arena1:3')).toBe(1);
  });

  it('the losing squad still lands adjacent (not tied) individual places, worst-eliminated first', () => {
    const body = buildRatingReportBody('arena1', 0, [4, 5, 6, 7], 8);
    const byAccount = new Map(body.accountIds.map((id, i) => [id, body.places[i]]));
    expect(byAccount.get('seat:arena1:4')).toBe(8); // first-eliminated → worst
    expect(byAccount.get('seat:arena1:5')).toBe(7);
    expect(byAccount.get('seat:arena1:6')).toBe(6);
    expect(byAccount.get('seat:arena1:7')).toBe(5);
  });

  it('teamIds group each squad together, one id per squad', () => {
    const body = buildRatingReportBody('arena1', 0, [4, 5, 6, 7], 8);
    const teamBySeat = new Map(body.accountIds.map((id, i) => [id, body.teamIds[i]]));
    const winningTeam = teamBySeat.get('seat:arena1:0')!;
    expect(teamBySeat.get('seat:arena1:1')).toBe(winningTeam);
    expect(teamBySeat.get('seat:arena1:2')).toBe(winningTeam);
    expect(teamBySeat.get('seat:arena1:3')).toBe(winningTeam);
    const losingTeam = teamBySeat.get('seat:arena1:4')!;
    expect(losingTeam).not.toBe(winningTeam);
    expect(teamBySeat.get('seat:arena1:5')).toBe(losingTeam);
    expect(teamBySeat.get('seat:arena1:6')).toBe(losingTeam);
    expect(teamBySeat.get('seat:arena1:7')).toBe(losingTeam);
  });

  it('produces all 8 seats, not just the 5 that appear in winner+placements', () => {
    const body = buildRatingReportBody('arena1', 0, [4, 5, 6, 7], 8);
    expect(body.accountIds).toHaveLength(8);
  });
});

describe('buildRatingReportBody — seatAccounts (design/16-accounts.md)', () => {
  it('uses the real accountId for a seat present in seatAccounts', () => {
    const body = buildRatingReportBody('room1', 0, [1], 2, { 0: 'acct-alice' });
    const byAccount = new Map(body.accountIds.map((id, i) => [id, body.places[i]]));
    expect(byAccount.get('acct-alice')).toBe(1); // winner, real account
    expect([...byAccount.keys()]).toContain('seat:room1:1'); // the other seat: still scaffold
  });

  it('falls back to the scaffold id for any seat missing from seatAccounts', () => {
    const body = buildRatingReportBody('room1', 0, [1], 2, {});
    expect(body.accountIds).toContain('seat:room1:0');
    expect(body.accountIds).toContain('seat:room1:1');
  });

  it('omitting seatAccounts entirely reproduces the exact pre-account scaffold behavior', () => {
    const withMap = buildRatingReportBody('room1', 0, [1], 2, undefined);
    const without = buildRatingReportBody('room1', 0, [1], 2);
    expect(withMap).toEqual(without);
  });
});
