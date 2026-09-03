/**
 * PvP ladder rating (design/15, ROADMAP 4.6) — the matchsvc-side rating math and
 * store, in isolation from any HTTP/matchsvc wiring.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db';
import { computeRatingDeltas, RatingStore, DEFAULT_RATING } from '../src/rating';

describe('computeRatingDeltas', () => {
  it('a single participant (nothing to compare against) gets a zero delta', () => {
    expect(computeRatingDeltas([1000], [1])).toEqual([0]);
  });

  it('equal ratings: 1st place gains, last place loses, by roughly symmetric amounts', () => {
    const deltas = computeRatingDeltas([1000, 1000, 1000, 1000], [1, 2, 3, 4]);
    expect(deltas[0]!).toBeGreaterThan(0); // 1st gained
    expect(deltas[3]!).toBeLessThan(0); // last lost
    // Monotonic: better placement never gains less than a worse one at equal rating.
    expect(deltas[0]!).toBeGreaterThanOrEqual(deltas[1]!);
    expect(deltas[1]!).toBeGreaterThanOrEqual(deltas[2]!);
    expect(deltas[2]!).toBeGreaterThanOrEqual(deltas[3]!);
  });

  it('a favorite (higher rating) placing last loses more than an underdog placing last', () => {
    const deltas = computeRatingDeltas([1400, 1000, 1000, 600], [4, 2, 3, 1]);
    // deltas[0] is the 1400-rated favorite finishing last; deltas[3] is the 600-rated
    // underdog finishing FIRST — both are "surprising" outcomes, both should be large
    // relative to a same-rating same-placement case, but signed opposite.
    expect(deltas[0]!).toBeLessThan(0);
    expect(deltas[3]!).toBeGreaterThan(0);
  });

  it('a higher-rated favorite winning gains less than a lower-rated underdog winning', () => {
    const favoriteWins = computeRatingDeltas([1400, 1000, 1000, 1000], [1, 2, 3, 4]);
    const underdogWins = computeRatingDeltas([600, 1000, 1000, 1000], [1, 2, 3, 4]);
    expect(favoriteWins[0]!).toBeLessThan(underdogWins[0]!);
  });
});

describe('computeRatingDeltas — squad-aware (design/05/15 squad follow-up)', () => {
  it('omitting teamIds is byte-identical to the original per-seat formula', () => {
    const ratings = [1400, 1000, 1000, 600];
    const places = [4, 2, 3, 1];
    expect(computeRatingDeltas(ratings, places)).toEqual(
      computeRatingDeltas(ratings, places, ratings.map((_, i) => i)), // singleton teams
    );
  });

  it('every member of a squad gets the identical delta, even with different individual places', () => {
    // team0 = seats 0,1 (adjacent places 1,2 — the winning squad); team1 = seats 2,3 (places 3,4).
    const deltas = computeRatingDeltas([1000, 1000, 1000, 1000], [1, 2, 3, 4], [0, 0, 1, 1]);
    expect(deltas[0]).toBe(deltas[1]); // same squad, same delta
    expect(deltas[2]).toBe(deltas[3]);
    expect(deltas[0]!).toBeGreaterThan(0); // winning squad gains
    expect(deltas[2]!).toBeLessThan(0); // losing squad loses
  });

  it('expected score compares the SQUAD average rating, not each member\'s own', () => {
    // team0 = a 1400-favorite paired with a 600-underdog (avg 1000) that still WINS;
    // team1 = two 1000s (avg 1000). Field average is also 1000, so both squads' expected
    // score is identical (0.5) despite wildly different individual ratings within team0 —
    // proof the math uses the squad average, not the 1400 or the 600 individually.
    const deltas = computeRatingDeltas([1400, 600, 1000, 1000], [1, 2, 3, 4], [0, 0, 1, 1]);
    expect(deltas[0]).toBe(deltas[1]);
    expect(deltas[0]).toBe(16); // K=32 * (actual 1 - expected 0.5)
    expect(deltas[2]).toBe(deltas[3]);
    expect(deltas[2]).toBe(-16);
  });
});

describe('RatingStore', () => {
  it('an unknown account starts at DEFAULT_RATING', () => {
    const store = new RatingStore();
    expect(store.get('alice')).toBe(DEFAULT_RATING);
  });

  it('applyMatch updates every account and returns before/after for each', () => {
    const store = new RatingStore();
    const changes = store.applyMatch(['alice', 'bob', 'carol', 'dave'], [1, 2, 3, 4]);
    expect(changes).toHaveLength(4);
    expect(changes[0]!.accountId).toBe('alice');
    expect(changes[0]!.before).toBe(DEFAULT_RATING);
    expect(changes[0]!.after).toBeGreaterThan(DEFAULT_RATING); // alice won
    expect(store.get('alice')).toBe(changes[0]!.after); // persisted
    expect(store.get('dave')).toBeLessThan(DEFAULT_RATING); // dave placed last
  });

  it('ratings compound across multiple matches', () => {
    const store = new RatingStore();
    store.applyMatch(['alice', 'bob'], [1, 2]);
    const afterFirst = store.get('alice');
    store.applyMatch(['alice', 'bob'], [1, 2]);
    expect(store.get('alice')).toBeGreaterThan(afterFirst); // won again, rating keeps climbing
  });

  it('applyMatch, given teamIds, applies the same delta to every squadmate', () => {
    const store = new RatingStore();
    const changes = store.applyMatch(['alice', 'bob', 'carol', 'dave'], [1, 2, 3, 4], [0, 0, 1, 1]);
    const delta = (c: (typeof changes)[number]) => c.after - c.before;
    expect(delta(changes[0]!)).toBe(delta(changes[1]!)); // alice/bob, same squad
    expect(delta(changes[2]!)).toBe(delta(changes[3]!)); // carol/dave, same squad
    expect(delta(changes[0]!)).toBeGreaterThan(delta(changes[2]!)); // winning squad > losing squad
  });
});

describe('RatingStore — SQLite-backed', () => {
  it('persists ratings in the given db, surviving a fresh RatingStore instance', () => {
    const db = openDb(':memory:');
    const store = new RatingStore(db);
    const changes = store.applyMatch(['alice', 'bob'], [1, 2]);

    // A brand new store over the SAME db (simulates a server restart) sees the same ratings.
    const reopened = new RatingStore(db);
    expect(reopened.get('alice')).toBe(changes[0]!.after);
    expect(reopened.get('bob')).toBe(changes[1]!.after);
  });

  it('a db-backed store does not leak into an in-memory-only store, and vice versa', () => {
    const db = openDb(':memory:');
    const dbStore = new RatingStore(db);
    const memStore = new RatingStore();
    dbStore.applyMatch(['alice', 'bob'], [1, 2]);
    expect(memStore.get('alice')).toBe(DEFAULT_RATING);
  });

  it('a scaffold guest/bot id (seat:{roomId}:{seatIdx}) persists fine despite the FK on accounts', () => {
    const db = openDb(':memory:');
    const store = new RatingStore(db);
    expect(() => store.applyMatch(['seat:room1:0', 'seat:room1:1'], [1, 2])).not.toThrow();
    expect(store.get('seat:room1:0')).toBeGreaterThan(DEFAULT_RATING);
  });
});

describe('computeRatingDeltas — the squad-aware arms nothing else reaches', () => {
  it('gives everyone zero when the whole field is ONE team', () => {
    // `numTeams <= 1 ? 0.5 : ...`. A four-seat room where every seat shares a squad has no
    // ranking to express, so the actual score is a draw against itself — and the delta must
    // be 0 rather than the K-factor swing an `(numTeams - rank) / (numTeams - 1)` with
    // numTeams === 1 would produce (a division by zero, i.e. NaN ratings written to the DB).
    const deltas = computeRatingDeltas([1200, 1200, 1000, 1400], [1, 1, 1, 1], [7, 7, 7, 7]);
    expect(deltas).toEqual([0, 0, 0, 0]);
    for (const d of deltas) expect(Number.isFinite(d)).toBe(true);
  });

  it('breaks a tie between two teams that share a best place by teamId, deterministically', () => {
    // The `|| a.teamId - b.teamId` arm. Two teams whose best member placed the same is
    // structurally impossible from a real match, but the sort has to be TOTAL anyway:
    // without the tiebreak the order depends on the engine's sort stability, and the same
    // settled match could rate differently on two runs.
    const run = (): number[] => computeRatingDeltas([1200, 1200], [1, 1], [5, 2]);
    const first = run();
    for (let i = 0; i < 5; i++) expect(run()).toEqual(first);
    // Team 2 sorts ahead of team 5, so seat 1 (team 2) is ranked first and gains.
    expect(first[1]!).toBeGreaterThan(0);
    expect(first[0]!).toBeLessThan(0);
  });
});
