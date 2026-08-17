/**
 * PvE level balance sim — the PvE counterpart to `pvpBalanceSim.sim.ts`, and the
 * tool the "一进游戏就被集火秒杀" (I get focus-fired down the moment I enter) report
 * should have been answered with the first time. Run it with:
 *
 *     npm run test:pve-sim            (repo root, or -w client)
 *
 * It plays the shipped level 1 (`world/dungeons/ember/`, 5 hand-authored floors)
 * with a bot at two skill profiles and prints a per-room table: garrison size,
 * reaction window, peak simultaneous shooters, damage taken, clear rate. Kept out of
 * the default `npm test` glob for the same reason the PvP sim is — it runs real
 * multi-minute-of-game-time runs.
 *
 * The `it(...)` blocks below are deliberately a mix of two things:
 *   - a REPORT (always printed, no assertion) — the balance data itself;
 *   - a small set of BALANCE GATES — assertions that encode the survivability floor
 *     the level is supposed to clear. They exist so that a content edit that
 *     re-packs a room back to lethal density fails here instead of shipping and
 *     being re-reported by a player. See `design/05-gameplay.md` ("Room encounter
 *     budget") for what each threshold means and why it has that value.
 */
import { describe, expect, it } from 'vitest';
import { runLevel, type RunMetrics } from './pve/levelSim';
import { formatRoomTable, formatSummary, roomStats, summarize } from './pve/report';

const SEEDS = [101, 202, 303, 404, 505, 606, 707, 808];
const PROFILES = ['careful', 'aggressive'] as const;

function sweep(profileName: (typeof PROFILES)[number]): RunMetrics[] {
  return SEEDS.map((seed) => runLevel({ seed, profileName }));
}

describe('PvE level 1 balance sim (bot-driven real runs — first-signal data, not a substitute for playtesting)', () => {
  const bank = new Map<string, RunMetrics[]>();
  const runs = (p: (typeof PROFILES)[number]): RunMetrics[] => {
    const cached = bank.get(p);
    if (cached) return cached;
    const fresh = sweep(p);
    bank.set(p, fresh);
    return fresh;
  };

  it('reports per-room encounter data for both skill profiles', () => {
    for (const p of PROFILES) {
      const rows = runs(p);
      // eslint-disable-next-line no-console
      console.log(`\n${formatSummary(`profile=${p}`, summarize(rows))}`);
      // eslint-disable-next-line no-console
      console.log(formatRoomTable(roomStats(rows)));
    }
    expect(runs('careful').length).toBe(SEEDS.length);
  }, 600_000);

  // ── Balance gates (design/05 "Room encounter budget") ────────────────────────

  it("gate: the entrance room gives the player time to react — it is the first thing they ever see", () => {
    const rows = roomStats(runs('careful'));
    const entrance = rows.find((r) => r.floorIndex === 0);
    expect(entrance).toBeDefined();
    // ~1s @30Hz. A room that lands damage faster than a player can read it is the
    // reported bug, restated as a number.
    expect(entrance!.medianReactionTicks ?? Infinity).toBeGreaterThanOrEqual(30);
  }, 600_000);

  it('gate: no room focus-fires the player with more shooters than the effective HP pool can absorb', () => {
    for (const p of PROFILES) {
      const rows = runs(p);
      const worst = Math.max(...rows.map((r) => r.peakBurstDamage));
      const pool = rows[0]!.effectiveHp;
      // A one-second window must not be able to erase a full-health player outright:
      // survival has to be a matter of play, not of spawn luck.
      expect(worst, `profile=${p} worst 1s burst ${worst} vs ${pool} effective HP`).toBeLessThan(pool);
    }
  }, 600_000);

  it('gate: a careful player always clears the entrance room, and floor 1 is passable but not free', () => {
    const rows = runs('careful');
    const cleared = rows.filter((r) => r.encounters.some((e) => e.floorIndex === 0 && e.clearedTick !== null));
    expect(cleared.length).toBe(rows.length);

    // Difficulty target (chosen 2026-08-17: "整体偏难" — hard overall). Descending off
    // floor 0 means its whole roster plus the capstone went down, which is the real
    // "level 1 is playable" bar rather than "the first room is". Bounded on BOTH
    // sides on purpose: too few descents means the level is back to a wall, too many
    // means a tuning pass overshot into a walkover. Read the bot as a LOWER bound on
    // a human — it never swaps to the saber (2 damage, hits everything in the arc,
    // parries bullets) and never dodges a shot on purpose.
    const descended = rows.filter((r) => r.floorReached >= 1).length;
    expect(descended, `${descended}/${rows.length} careful runs descended off floor 0`).toBeGreaterThanOrEqual(2);
    const extracted = rows.filter((r) => r.outcome === 'extracted').length;
    expect(extracted, `${extracted}/${rows.length} careful runs extracted`).toBeLessThanOrEqual(Math.floor(rows.length * 0.5));
  }, 600_000);

  it('gate: nothing softlocks — a run always ends in a real outcome, never a stall', () => {
    // A timeout here is not a slow run, it is a wedged one: the run ran out of ticks
    // with the bot unable to reach whatever was left alive. That is how the v41
    // door-lock softlock was found (a room went into combat behind a door that had
    // just slammed on the player's own body and pushed them back out of it,
    // permanently locking them out of the only room that could ever be cleared) — so
    // this gate stays as its regression check.
    for (const p of PROFILES) {
      const stalled = runs(p).filter((r) => r.outcome === 'timeout');
      expect(stalled.map((r) => `${p}/seed=${r.seed}/${r.endRoom}`)).toEqual([]);
    }
  }, 600_000);
});
