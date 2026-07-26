/**
 * PvP ladder rating (design/15, ROADMAP 4.6) — matchsvc-side ONLY, computed from
 * checkpoint-verified match placements (design/06/15's anti-cheat backstop, ROADMAP
 * 4.4). This file has NO dependency on `@dd/engine` at all, by construction — the
 * rating is account-level bookkeeping, never engine-replicated state, and must never
 * enter the replay/state hash (design/15's explicit "does NOT touch
 * state.bankedMaterials or any engine-replicated state").
 *
 * A simplified multiplayer Elo (the common FFA/battle-royale MMR shape): each
 * participant's ACTUAL score for the match is their normalized finish placement
 * (1st = 1, last = 0); their EXPECTED score is the logistic comparison of their own
 * rating against the field's average rating — "the field" standing in as one
 * aggregate opponent, the standard generalization of 2-player Elo to N participants.
 * Exact K-factor/starting rating are first-pass constants (design/15 doesn't lock
 * ladder tuning), not a tuned production curve.
 */
export const K_FACTOR = 32;
export const DEFAULT_RATING = 1000;

/**
 * Given each participant's CURRENT rating and 1-based finish place (1 = best, N =
 * worst — ties aren't modeled, matching design/15's same-tick placement tiebreak
 * already producing a total order with no draws), return the rating DELTA to apply
 * to each (same index order as `ratings`/`places`).
 */
export function computeRatingDeltas(ratings: readonly number[], places: readonly number[]): number[] {
  const n = ratings.length;
  if (n <= 1) return ratings.map(() => 0); // nothing to compare against — no-op match
  const avgRating = ratings.reduce((a, b) => a + b, 0) / n;
  return ratings.map((rating, i) => {
    const actual = (n - places[i]!) / (n - 1); // 1st place → 1, last place → 0
    const expected = 1 / (1 + Math.pow(10, (avgRating - rating) / 400));
    return Math.round(K_FACTOR * (actual - expected));
  });
}

export interface RatingChange {
  accountId: string;
  before: number;
  after: number;
}

/**
 * In-memory ladder store (matches the existing project convention — `Matchmaker`
 * is in-memory too, no DB in this repo yet). Keyed by an opaque `accountId` string;
 * this module doesn't define what an account IS — that's outside matchsvc's current
 * scope (no account/auth system exists yet anywhere in this project) — it only
 * defines the rating math and storage once given stable ids.
 */
export class RatingStore {
  private readonly ratings = new Map<string, number>();

  get(accountId: string): number {
    return this.ratings.get(accountId) ?? DEFAULT_RATING;
  }

  /** Apply one verified match's placements; returns every account's {before, after}. */
  applyMatch(accountIds: readonly string[], places: readonly number[]): RatingChange[] {
    const before = accountIds.map((id) => this.get(id));
    const deltas = computeRatingDeltas(before, places);
    return accountIds.map((accountId, i) => {
      const b = before[i]!;
      const after = b + deltas[i]!;
      this.ratings.set(accountId, after);
      return { accountId, before: b, after };
    });
  }
}
