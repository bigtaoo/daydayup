/**
 * Placement → rank conversion for the ladder-rating report (design/15, ROADMAP 4.6).
 * Pure, no network — the index.ts wiring around this is intentionally untested
 * directly (same convention as the rest of the socket-glue entrypoint).
 */
import { describe, it, expect } from 'vitest';
import { buildRatingReportBody, ratingReportKey } from '../src/ladderReport';
import { MAX_REPORT_KEY_LENGTH } from '../src/routes/rating';

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

/**
 * The exactly-once dedupe key (design/19 §3, closing ROADMAP 8.1's open item). Two
 * properties matter and they pull in opposite directions, which is why they are tested as a
 * pair rather than as "the key looks right":
 *
 *   STABLE  — the same settlement must produce the same key, or a retry claims a fresh row
 *             and double-applies the ratings, i.e. the whole mechanism does nothing.
 *   DISTINCT — two different settlements must not share a key, or the second one's ratings
 *             are silently dropped. That is the worse failure of the two: a double-credit is
 *             visible in the ladder and reversible, a settlement that never landed is
 *             neither, and nothing logs it.
 */
describe('ratingReportKey — the exactly-once dedupe key', () => {
  const REPORT = ['room-1', ['a', 'b'], [1, 2], [0, 1]] as const;
  const key = (...args: Parameters<typeof ratingReportKey>): string => ratingReportKey(...args);

  it('is stable: the same settlement digests to the same key every time', () => {
    // This is the property the retry ladder rests on. `internalFetch` serializes the body
    // once, so today a retry re-sends the same bytes — but the guarantee has to come from
    // the key being a pure function of the report, not from that implementation detail.
    expect(key(...REPORT)).toBe(key(...REPORT));
    expect(key('room-1', ['a', 'b'], [1, 2], [0, 1])).toBe(key('room-1', ['a', 'b'], [1, 2], [0, 1]));
  });

  it('names the room it belongs to, so an operator can find one room with plain SQL', () => {
    // design/19 §7 rules out an admin service; `WHERE report_key LIKE 'room-1:%'` is the
    // whole query, which only works while the room id is the PREFIX.
    expect(key(...REPORT).startsWith('room-1:')).toBe(true);
  });

  it('separates two rooms', () => {
    expect(key('room-1', ['a', 'b'], [1, 2], [0, 1])).not.toBe(key('room-2', ['a', 'b'], [1, 2], [0, 1]));
  });

  it.each([
    ['different accounts', ['a', 'c'], [1, 2], [0, 1]],
    ['a different result', ['a', 'b'], [2, 1], [0, 1]],
    ['different squads', ['a', 'b'], [1, 2], [0, 0]],
  ])('separates two settlements in the SAME room that differ by %s', (_label, accountIds, places, teamIds) => {
    // The reason the digest exists at all. In production a room id is a `randomUUID()` used
    // by exactly one match, so `roomId` alone would do — but `index.ts`'s legacy dev
    // handshake takes `roomId` off the query string, and a room is destroyed when it
    // settles, so a local `?roomId=dev` really can host a second, different match. Without
    // the digest that match's rating would be swallowed as a duplicate.
    expect(key('room-1', accountIds, places, teamIds)).not.toBe(key(...REPORT));
  });

  it('cannot be made ambiguous by an id containing the separator', () => {
    // A hand-rolled `join(':')` would collapse these two: ('a', 'b:c') and ('a:b', 'c').
    expect(key('r', ['a', 'b:c'], [1, 2], [0, 1])).not.toBe(key('r', ['a:b', 'c'], [1, 2], [0, 1]));
  });

  it('stays well inside the route length bound for a real (UUID) room id', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const produced = key(uuid, ['acct-1', 'acct-2', 'acct-3', 'acct-4'], [1, 2, 3, 4], [0, 1, 2, 3]);
    expect(produced.length).toBeLessThan(MAX_REPORT_KEY_LENGTH);
    expect(produced).toBe(`${uuid}:${produced.slice(uuid.length + 1)}`);
    expect(produced.slice(uuid.length + 1)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('buildRatingReportBody — the key it ships with the body', () => {
  it('carries the key for exactly the report it built', () => {
    const body = buildRatingReportBody('room-9', 1, [2, 3, 0], 4);
    expect(body.reportKey).toBe(ratingReportKey('room-9', body.accountIds, body.places, body.teamIds));
  });

  it('two settlements of the same shape in DIFFERENT rooms get different keys', () => {
    const a = buildRatingReportBody('roomA', 0, [1], 2);
    const b = buildRatingReportBody('roomB', 0, [1], 2);
    expect(a.reportKey).not.toBe(b.reportKey);
  });

  it('a seat logging in changes the key — the accounts being rated are part of the report', () => {
    // Not a cosmetic difference: the same seats settling with a real account behind seat 0
    // move a DIFFERENT account's rating, so the two are not the same settlement.
    const guest = buildRatingReportBody('room-9', 0, [1], 2);
    const logged = buildRatingReportBody('room-9', 0, [1], 2, { 0: 'acct-real' });
    expect(logged.reportKey).not.toBe(guest.reportKey);
  });
});
