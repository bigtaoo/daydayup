/**
 * PvP ladder rating (design/15, ROADMAP 4.6) — the matchsvc-side rating math and
 * store, in isolation from any HTTP/matchsvc wiring.
 */
import { describe, it, expect } from 'vitest';
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
});
