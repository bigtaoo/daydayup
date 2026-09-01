/**
 * Drop-reachability sweep — the v50 write-up's central measurement, turned into something
 * that can be re-run.
 *
 * ENGINE_VERSION 50 ("both rules were right, and neither was the bug") rests on a number:
 * *"903 real drops over 16 bot-driven runs of all five floors, checked at drop time AND on
 * every change to the wall set, so a door locking over an existing drop is covered: zero
 * unreachable, zero in stone"*. That sweep was ad-hoc. It existed in a scratch script, was
 * never committed, and so the strongest evidence behind two ENGINE_VERSION bumps could not
 * be reproduced by anyone — including the next person to touch `dropClearance()`.
 *
 * What the repo had instead:
 *   - `engine/smoke.test.ts`'s "every alive pickup sits where a player body could stand"
 *     checks the same property per tick, but only on the five fixed-seed `GOLDEN_SCENARIOS`,
 *     and its own comment records the honest limit: reverting `dropClearance()` does NOT turn
 *     it red, because shipped rooms are authored on a 1000 fp lattice and 1000 fp is exactly
 *     two player radii, so nothing there separates the two radii;
 *   - `clearanceParity.test.ts` owns the code half on geometry built to separate them.
 *
 * Neither is a SWEEP. This is: real bot-driven runs of the shipped level 1, many seeds, with
 * the property checked at every event that can break it. It belongs in the opt-in `.sim.ts`
 * tier alongside `pveLevelSim.sim.ts` — it plays full-length runs and is far too slow to
 * belong in every default `npm test`.
 *
 * How deep the runs actually go, stated up front because it bounds what this file can claim:
 * level 1 has five hand-authored floors, but the bot is a LOWER bound on a human (it never
 * swaps to the saber, never dodges on purpose) and `pveLevelSim.sim.ts`'s own difficulty gate
 * only requires 2 of 8 careful runs to descend off floor 0 at all. In practice this sweep
 * reaches floors 0-2. The floors it never enters are covered by `smoke.test.ts`'s per-tick
 * version of the same property on the golden scenarios, not by this file.
 *
 * WHEN the check runs is the whole design of this file, and it is what makes it different
 * from a per-tick scan that would be 40,000x more expensive for no extra information:
 *
 *   1. every tick a NEW pickup appears — the drop SITE, which is what `dropClearance()`
 *      governs (`DeathDropsSystem`, `PickupSystem.applyWeapon`, `SpawnSystem.spawnArenaLoot`);
 *   2. every tick the WALL SET changes — a resting place that was legal when the item landed
 *      and stopped being legal afterwards. `DoorSystem.rebuildWalls` is the only thing in the
 *      engine that moves a wall mid-run, and a door passage is exactly where a drop comes
 *      from: a mob dies on the threshold, the room activates, the door closes over the loot.
 *      ENGINE_VERSION 51 re-clamps every alive pickup on that rebuild; before it, the item was
 *      sealed in stone with no mitigation anywhere. This sim is the sweep that would have
 *      found it, so it stays as the regression gate for v51 as much as a re-run of v50.
 *
 * ## What this sweep does and does NOT discriminate — measured, 2026-09-01
 *
 * Recorded here for the same reason `smoke.test.ts` records its own version: a gate whose
 * limits are not written down gets credited with more than it proves.
 *
 *   - reverting `DeathDropsSystem`'s `dropClearance()` to `SIM.pickupRadius` does NOT turn
 *     this red. Every one of the 796 drops came back at a byte-identical position: on shipped
 *     content neither clamp ever fires, because the ember floors are authored on a 1000 fp
 *     lattice and 1000 fp is exactly two player radii, so no pocket exists that a 469 fp
 *     circle fits and a 500 fp one does not. `clearanceParity.test.ts` owns that
 *     discrimination, on geometry built for it;
 *   - reverting ENGINE_VERSION 51 (removing `DoorSystem.rebuildWalls`'s pickup re-clamp) does
 *     NOT turn it red either: across 142 wall-set changes with loot on the floor, no door in
 *     these 16 runs ever closed over a drop. `doors.test.ts` owns that case constructively.
 *
 * So this is a CONTENT gate, not a proof about the code — the same status `smoke.test.ts`
 * claims, on a much larger sample and with the mid-run wall change that smoke's fixed golden
 * scenarios never produce. What it buys: a new room piece with a tighter pocket, a wider body
 * radius, or a new drop site that forgets to clamp fails HERE, on real runs, and the v50
 * write-up's central number can be re-measured by anyone instead of taken on trust.
 *
 * A drop that lands somewhere no player body fits is unreachable in the only sense the
 * report ever meant: `PickupSystem` collects on a radius test that does not consult walls, so
 * a pickup buried in a passage rect is collectable only if the player can get their own body
 * within `pickupRadius + p.radius` of a point inside stone. Asserting "a player's own
 * collision circle fits here, unmoved" needs no flood fill, no notion of regions, and no
 * second copy of the collect rule — and it implies reachability outright, because the player
 * can stand ON the drop.
 */
import { describe, expect, it } from 'vitest';
import { createGameEngine } from '@dd/engine';
import type { GameState } from '@dd/engine';
import { dropClearance } from '@dd/engine/state/actorRadius';
import { blockingRect } from '@dd/engine/systems/solidBounds';
import type { Fp } from '@dd/engine/math/fixed';
import { buildDungeonRunConfig } from '../src/game/match/offlineConfig';
import { BOT_PROFILES, PveBotController } from './pve/PveBotController';

/** Eight seeds x two bot profiles = the same 16 bot-driven runs the v50 sweep reported, on
 *  the same seed list `pveLevelSim.sim.ts` uses, so a floor-content edit moves both files'
 *  numbers together instead of one silently sampling different runs. */
const SEEDS = [101, 202, 303, 404, 505, 606, 707, 808];
const PROFILES = ['careful', 'aggressive'] as const;
/** Same runaway guard as `pve/levelSim.ts` — a cap, not an expected outcome. */
const MAX_TICKS = 40_000;
/** Same tolerance `engine/smoke.test.ts` uses: one fp unit, for the push's own `Math.trunc`
 *  residue and nothing more. Anything deeper is a body's worth of stone, not rounding. */
const PENETRATION_ALLOWANCE = 1;
/** One extra authored grid cell of body on top of the real one, used ONLY by the
 *  anti-vacuity control below — never as a claim about the game. */
const PROBE_RADIUS = ((dropClearance() as number) + 1000) as Fp;

interface Unreachable {
  seed: number;
  profile: string;
  tick: number;
  /** 'drop' — caught at the moment it was placed; 'wallchange' — it was fine where it
   *  landed and a door/floor swap moved stone on top of it afterwards. The two point at
   *  completely different code, so they are never collapsed into one count. */
  trigger: 'drop' | 'wallchange';
  pickupId: number;
  kind: string;
  gx: number;
  gy: number;
  depthFp: number;
}

interface SweepResult {
  seed: number;
  profile: string;
  ticks: number;
  floorReached: number;
  /** Distinct pickups observed over the run — the "903 drops" figure. */
  dropsSeen: number;
  /** How many times the wall set changed under a live drop (doors locking/unlocking, and
   *  the whole-floor swap on a descent). Reported because it is the anti-vacuity number for
   *  the second trigger: if it were 0, this sim would silently be measuring only drop sites. */
  wallChanges: number;
  /** Total pickup-vs-stone checks performed. */
  checks: number;
  violations: Unreachable[];
  /** Worst penetration seen against the real `dropClearance()` body. */
  worstDepthFp: number;
  /** The same measurement against a deliberately OVERSIZED body (`PROBE_RADIUS`). Not a
   *  claim about the game — the control that says this sweep's drops are near enough to
   *  stone for the check to be capable of failing at all. See the assertion that reads it. */
  worstProbeDepthFp: number;
}

/**
 * How far a circle of radius `r` at (gx, gy) reaches into the nearest solid; positive means
 * overlap. Deliberately geometric rather than "would the clamp move it": in a pocket
 * narrower than the radius, `clampToWalkable`'s own fixed-point exit reports "settled" on a
 * point still inside stone (`clearanceParity.test.ts` pins that limit), so asking the clamp
 * would launder exactly the failure this sim is looking for.
 *
 * Same shape as `engine/smoke.test.ts`'s own local copy — that one lives in a test file and
 * cannot be imported from here.
 */
function deepestSolidPenetration(s: GameState, gx: Fp, gy: Fp, r: Fp): number {
  let worst = 0;
  for (const w of s.walls) {
    const b = blockingRect(w);
    const cx = Math.max(b.left as number, Math.min(gx as number, b.right as number));
    const cy = Math.max(b.top as number, Math.min(gy as number, b.bottom as number));
    const dx = (gx as number) - cx;
    const dy = (gy as number) - cy;
    worst = Math.max(worst, (r as number) - Math.sqrt(dx * dx + dy * dy));
  }
  for (const o of s.obstacles) {
    const dx = (gx as number) - (o.gx as number);
    const dy = (gy as number) - (o.gy as number);
    worst = Math.max(worst, (r as number) + (o.radius as number) - Math.sqrt(dx * dx + dy * dy));
  }
  return worst;
}

/**
 * A cheap signature of the current wall set. `DoorSystem.rebuildWalls` swaps the array's
 * CONTENTS in place (never reassigns the reference), and a floor descent rebuilds it
 * wholesale, so identity comparison sees nothing — the count plus a coordinate sum catches
 * both. Not a hash with collision guarantees, and it does not need to be: a locked door adds
 * or removes a whole rect, which moves the count.
 */
function wallSignature(s: GameState): number {
  let sig = s.walls.length * 1_000_003 + s.floorIndex * 7_919;
  for (const w of s.walls) sig = (sig + (w.x as number) * 31 + (w.y as number) * 17 + (w.w as number) * 7 + (w.h as number) * 3) | 0;
  return sig;
}

function sweepOne(seed: number, profile: (typeof PROFILES)[number]): SweepResult {
  const engine = createGameEngine(
    buildDungeonRunConfig({
      seed,
      coop: false,
      // `[]` is a fresh save's real state — the starter blaster + saber, i.e. exactly what a
      // new player walks in with, which is also the loadout a weapon SWAP drop comes from.
      localSeat: { skinId: 'vanguard', loadout: [] },
      allySkinId: 'juggernaut', // ignored: a single-player config has no ally seat
    }),
  );
  const bot = new PveBotController(BOT_PROFILES[profile]);
  const violations: Unreachable[] = [];
  const seen = new Set<number>();
  let dropsSeen = 0;
  let wallChanges = 0;
  let checks = 0;
  let worstDepthFp = -Infinity;
  let worstProbeDepthFp = -Infinity;
  let sig = wallSignature(engine.state);
  let ticks = 0;

  const clearance = dropClearance();
  const auditAll = (s: GameState, trigger: Unreachable['trigger']): void => {
    for (const item of s.pickups) {
      if (!item.alive) continue;
      checks++;
      const depth = deepestSolidPenetration(s, item.gx, item.gy, clearance);
      if (depth > worstDepthFp) worstDepthFp = depth;
      const probe = deepestSolidPenetration(s, item.gx, item.gy, PROBE_RADIUS);
      if (probe > worstProbeDepthFp) worstProbeDepthFp = probe;
      if (depth > PENETRATION_ALLOWANCE) {
        violations.push({
          seed, profile, tick: s.tick, trigger,
          pickupId: item.id, kind: item.kind,
          gx: item.gx as number, gy: item.gy as number,
          depthFp: Math.round(depth),
        });
      }
    }
  };

  auditAll(engine.state, 'drop'); // anything the config itself placed before tick 1
  while (ticks < MAX_TICKS) {
    engine.step([bot.build(engine.state, 0, engine.state.tick + 1)]);
    ticks++;
    const s = engine.state;

    let newDrop = false;
    for (const item of s.pickups) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      dropsSeen++;
      newDrop = true;
    }
    const nextSig = wallSignature(s);
    const wallsMoved = nextSig !== sig;
    if (wallsMoved) {
      sig = nextSig;
      // Only counts as an observation of trigger 2 if there was something live to break.
      if (s.pickups.some((q) => q.alive)) wallChanges++;
    }
    // Both triggers audit every alive pickup, not just the new one: a wall change is
    // global, and a fresh drop is cheap to fold into the same pass.
    if (newDrop || wallsMoved) auditAll(s, newDrop ? 'drop' : 'wallchange');

    if (s.phase === 'gameover') break;
  }

  return {
    seed, profile, ticks,
    floorReached: engine.state.floorIndex,
    dropsSeen, wallChanges, checks, violations,
    worstDepthFp: Math.round(worstDepthFp),
    worstProbeDepthFp: Math.round(worstProbeDepthFp),
  };
}

describe('drop reachability sweep (bot-driven real runs of the shipped level 1)', () => {
  const runs: SweepResult[] = [];
  for (const profile of PROFILES) for (const seed of SEEDS) runs.push(sweepOne(seed, profile));

  const total = (pick: (r: SweepResult) => number): number => runs.reduce((n, r) => n + pick(r), 0);

  it('reports what the sweep actually measured', () => {
    // A report, not a gate — but the numbers below are what every assertion in this file has
    // to be read against, and the v50 write-up's "903 drops over 16 runs" is exactly this
    // line. Printed so a future re-run can be compared to it rather than guessed at.
    const rows = runs.map(
      (r) =>
        `  seed=${r.seed} ${r.profile.padEnd(10)} floor=${r.floorReached} ticks=${String(r.ticks).padStart(5)} ` +
        `drops=${String(r.dropsSeen).padStart(3)} wallChanges=${String(r.wallChanges).padStart(3)} ` +
        `checks=${String(r.checks).padStart(5)} worstDepth=${r.worstDepthFp}fp (probe ${r.worstProbeDepthFp}fp) ` +
        `violations=${r.violations.length}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `\ndrop reachability: ${runs.length} runs, ${total((r) => r.dropsSeen)} distinct drops, ` +
        `${total((r) => r.wallChanges)} wall-set changes under live loot, ${total((r) => r.checks)} checks ` +
        `against a ${dropClearance()} fp player body\n${rows.join('\n')}`,
    );
    expect(runs.length).toBe(SEEDS.length * PROFILES.length);
  }, 900_000);

  // ── Anti-vacuity: this file's assertions are all "no violations", which an empty sweep
  //    satisfies perfectly. These say the sweep happened.

  it('actually produced drops to measure — on the order the v50 write-up reported', () => {
    // v50 reported 903 over 16 runs. Floored well below that rather than pinned to it: the
    // exact count moves with any content or drop-table edit, and a number that has to be
    // re-recorded gets re-recorded without being read. What must never happen is the sweep
    // quietly measuring nothing.
    expect(total((r) => r.dropsSeen), 'the sweep saw no drops at all').toBeGreaterThan(300);
    for (const r of runs) {
      expect(r.dropsSeen, `seed=${r.seed}/${r.profile} produced no drops`).toBeGreaterThan(0);
      expect(r.ticks, `seed=${r.seed}/${r.profile} produced no ticks`).toBeGreaterThan(50);
    }
  }, 900_000);

  it('actually observed the wall set changing under live loot — trigger 2 is not dead code', () => {
    // The ENGINE_VERSION 51 half. Without this, the "checked on every change to the wall set"
    // claim could be true of a sweep where the wall set never changed while loot was on the
    // floor, and the door-seals-a-drop case would go unmeasured while looking covered.
    expect(total((r) => r.wallChanges), 'no door ever locked or unlocked with loot on the floor').toBeGreaterThan(0);
  }, 900_000);

  // ── The property itself.

  it('every drop rests where a player body fits, at the moment it lands', () => {
    // The v50 measurement: `dropClearance()` at the three placement sites. Reverting any of
    // them makes a drop legal by the collect padding (469 fp) and illegal by the body (500
    // fp) — visible here only where shipped content has a pocket between the two, which is
    // why `clearanceParity.test.ts` owns the constructed case and this owns the sweep.
    const bad = runs.flatMap((r) => r.violations.filter((v) => v.trigger === 'drop'));
    expect(
      bad.map((v) => `seed=${v.seed}/${v.profile} t${v.tick} ${v.kind} #${v.pickupId} at (${v.gx},${v.gy}) is ${v.depthFp}fp inside stone`),
    ).toEqual([]);
  }, 900_000);

  it('and still rests there after the wall set changes under it', () => {
    // The ENGINE_VERSION 51 measurement: `DoorSystem.rebuildWalls` re-clamps every alive
    // pickup. Before v51 a locking door could seal a dropped item inside stone and nothing
    // anywhere moved it back out. Kept as its own assertion rather than folded into the one
    // above because the two failures point at different code, and a single combined list
    // would report the wrong one.
    const bad = runs.flatMap((r) => r.violations.filter((v) => v.trigger === 'wallchange'));
    expect(
      bad.map((v) => `seed=${v.seed}/${v.profile} t${v.tick} ${v.kind} #${v.pickupId} at (${v.gx},${v.gy}) is ${v.depthFp}fp inside stone after a wall change`),
    ).toEqual([]);
  }, 900_000);

  it('the check is CAPABLE of failing on this content — an oversized body does hit stone', () => {
    // The control that stops the two gates above from being satisfied by drops sitting in
    // open floor miles from any wall, where no radius mistake could ever show. Re-measured
    // over the identical drop positions with one extra grid cell of body: that must find
    // stone, or `deepestSolidPenetration` is answering "clear" for reasons that have nothing
    // to do with the radius the engine chose.
    //
    // MEASURED, and it is why this control is here rather than assumed: against the real
    // 500 fp body the worst reach across the whole sweep is 1 fp — i.e. exactly the trunc
    // residue, with no slack at all. Real drops DO come to rest touching stone; the gates
    // above are tight, not generous.
    const worstReal = Math.max(...runs.map((r) => r.worstDepthFp));
    const worstProbe = Math.max(...runs.map((r) => r.worstProbeDepthFp));
    expect(worstReal, `deepest drop-vs-stone reach at ${dropClearance()} fp is ${worstReal} fp`)
      .toBeLessThanOrEqual(PENETRATION_ALLOWANCE);
    expect(
      worstProbe,
      `a ${PROBE_RADIUS} fp body found no stone anywhere near ${total((r) => r.dropsSeen)} drops — ` +
        'the sweep is measuring open floor, so the gates above prove nothing',
    ).toBeGreaterThan(PENETRATION_ALLOWANCE);
  }, 900_000);
});
