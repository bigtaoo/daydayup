/**
 * Headless bot-vs-bot PvP balance data (ROADMAP 4.x — `PVP_SCALE_FACTOR`
 * (balance/build.ts) and the zone shrink-step tuning (content/arenas.ts) are both
 * explicitly flagged "first-pass, real play required"). Real human playtesting is
 * the actual ground truth this feeds; this sim's job is a cheap, repeatable
 * FIRST SIGNAL — win-rate skew, whether matches converge, how long they run — that
 * doesn't need to wait for a human play session, and can be re-run after any tuning
 * change to see the direction it moved.
 *
 * Drives the engine directly (`createGameEngine` + `PvpBotController.build()` each
 * tick) rather than through MatchRoom/CoopSession/a real socket — this is a
 * gameplay-outcome question, not a net-layer one, and `buildPvpEngineConfig` is the
 * SAME function `Game.buildOnlineConfig`/`server/src/BotClient.ts` use for a real
 * match, so the simulated config is byte-identical to a real arena run (design/06
 * anti-drift — no hand-mirrored second copy of the config logic).
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@dd/engine';
import { buildPvpEngineConfig } from './pvpConfig';
import { PvpBotController } from './PvpBotController';

// Matches Matchmaker.MAX_PLAYERS' 8-seat ceiling (design/15); 7 skipped, no special
// meaning at odd counts a run of 6 doesn't already cover.
const PLAYER_COUNTS = [2, 3, 4, 5, 6, 8];
const SEEDS_PER_COUNT = 30;
// Real matches converge in ~1-2k ticks (observed) — this is a generous multiple, so a
// timeout is itself a real finding (the zone/bot-AI combo failed to converge), not an
// expected outcome the ceiling is meant to paper over.
const MAX_TICKS = 20000;

interface MatchResult {
  playerCount: number;
  seed: number;
  ticks: number;
  timedOut: boolean;
  winnerSkin: string; // 'tie' on the rare simultaneous-elimination edge case
  zoneStageAtEnd: number;
  placementsCount: number;
}

function runMatch(seed: number, playerCount: number): MatchResult {
  const config = buildPvpEngineConfig(seed, playerCount);
  const engine = createGameEngine(config);
  const bots = Array.from({ length: playerCount }, () => new PvpBotController());

  let ticks = 0;
  while (engine.state.phase !== 'gameover' && ticks < MAX_TICKS) {
    const nextTick = engine.state.tick + 1;
    const cmds = bots.map((bot, seat) => bot.build(engine.state, seat, nextTick));
    engine.step(cmds);
    ticks++;
  }

  const s = engine.state;
  const winnerSeat = s.players.findIndex((p) => p.alive);
  const winnerSkin = winnerSeat >= 0 ? (config.players![winnerSeat]!.skinId ?? 'unknown') : 'tie';

  return {
    playerCount,
    seed,
    ticks,
    timedOut: ticks >= MAX_TICKS,
    winnerSkin,
    zoneStageAtEnd: s.zone?.stage ?? -1,
    placementsCount: s.placements.length,
  };
}

describe('PvP balance sim (bot vs bot — first-signal data for PVP_SCALE_FACTOR/zone tuning, not a replacement for real playtesting)', () => {
  it('runs a sweep across seat counts and seeds, asserts convergence, reports win-rate/duration', () => {
    // (timeout below: 180 real bot-vs-bot matches genuinely take a few seconds of
    // wall-clock, past vitest's 5s default per-test timeout)
    const results: MatchResult[] = [];
    for (const playerCount of PLAYER_COUNTS) {
      for (let i = 0; i < SEEDS_PER_COUNT; i++) {
        results.push(runMatch(1_000_000 + playerCount * 10_000 + i, playerCount));
      }
    }

    // The zone's own no-stalemate structural bound (design/15 — the final shrink
    // stage loops HOLD forever rather than shrinking to nothing) should mean bots
    // always reach a winner well inside MAX_TICKS. A real regression check, not
    // just a report — if this ever fails, the zone/bot-AI combo stopped converging.
    const timedOut = results.filter((r) => r.timedOut);
    expect(timedOut).toEqual([]);

    // Every match should resolve with exactly one non-eliminated seat (winner absent
    // from `placements`), i.e. `placements.length === playerCount - 1` — the 'tie'
    // simultaneous-elimination edge case is allowed but should stay rare.
    const ties = results.filter((r) => r.winnerSkin === 'tie');
    for (const r of results) {
      if (r.winnerSkin !== 'tie') expect(r.placementsCount).toBe(r.playerCount - 1);
    }
    expect(ties.length).toBeLessThan(results.length * 0.05); // <5% ties — a spike would flag a real placement/elimination bug

    // Win rate per character. CAVEAT, not hidden: `buildPvpEngineConfig` skins seats
    // BY INDEX (seat i -> the i-th SKIN_DEFS entry), not by seed, so a seat/spawn-
    // position advantage at any single playerCount would confound this reading —
    // sweeping playerCount 2..8 rotates which character lands on which seat index
    // (since `i % skinCount` shifts with playerCount), diluting but not eliminating
    // that confound. Treat this as a first signal to sanity-check against real
    // playtesting, not a verdict.
    const bySkin = new Map<string, number>();
    for (const r of results) bySkin.set(r.winnerSkin, (bySkin.get(r.winnerSkin) ?? 0) + 1);

    const byPlayerCount = new Map<number, { avgTicks: number; maxZoneStage: number; n: number }>();
    for (const pc of PLAYER_COUNTS) {
      const rows = results.filter((r) => r.playerCount === pc);
      byPlayerCount.set(pc, {
        avgTicks: Math.round(rows.reduce((sum, r) => sum + r.ticks, 0) / rows.length),
        maxZoneStage: Math.max(...rows.map((r) => r.zoneStageAtEnd)),
        n: rows.length,
      });
    }

    // eslint-disable-next-line no-console
    console.log(`\n=== PvP balance sim: ${results.length} bot-vs-bot matches ===`);
    // eslint-disable-next-line no-console
    console.log('Win rate by character:', JSON.stringify(Object.fromEntries(bySkin)));
    // eslint-disable-next-line no-console
    console.log('Duration (ticks @30Hz) / max zone stage reached, by seat count:', JSON.stringify(Object.fromEntries(byPlayerCount)));
    // eslint-disable-next-line no-console
    console.log(`Ties (simultaneous elimination, no clear winner): ${ties.length}/${results.length}`);
  }, 30_000);
});
