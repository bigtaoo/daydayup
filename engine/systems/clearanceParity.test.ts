/**
 * Does every site that PLACES something use the same clearance that will later push it?
 * (design/18-test-strategy.md, G4 / Layer 2.)
 *
 * An actor carries three radii and they are not interchangeable — `radius` (drawn body),
 * `footprintRadius` (feet, for actor-vs-actor crowding), `solidRadius` (clearance against a
 * static solid). `state/actorRadius.ts` names the third one because the convention was already
 * broken twice by code that was trying to follow it:
 *
 *   - `DeathDropsSystem` clamps a spawning minion by `footprintRadius` under a comment saying
 *     "a spawned actor needs its own solid clearance";
 *   - `DoorSystem.inLockingDoorway` tests the passage by `footprintRadius` under a comment
 *     saying that is "the feet circle solids actually push out".
 *
 * Both comments describe the rule correctly and both cite the wrong radius, because the rule
 * MOVED underneath them: solids have pushed `solidRadius`, not `footprintRadius`, since
 * ENGINE_VERSION 43 (players) and 48 (enemies). Nothing failed when that happened.
 *
 * This file's job is to stop that class of drift by MEASURING the consequence rather than
 * asserting a relationship between two constants — a test that says
 * `expect(clampRadius).toBe(pushRadius)` proves the arithmetic and not the intent, which is the
 * failure mode `shield.test.ts` was caught by (see `daydayup-testing-conventions`). So the
 * assertions below run the real systems and look at where things actually end up.
 *
 * Nothing here CHANGES behaviour: fixing either site is a sim change and needs an
 * ENGINE_VERSION bump. The tests are written as live assertions of what the engine does today,
 * so that fixing it turns them red and forces the bump to be deliberate.
 */
import { describe, expect, it } from 'vitest';
import { createGameState, type GameState } from '../state/GameState';
import { pxToFp } from '../content/convert';
import { PLAYER_BASE } from '../content/players';
import { buildEnemyActor, ENEMY_BLUEPRINTS } from '../content/enemies';
import { SIM } from '../sim.config';
import { blockingRadius } from '../state/actorRadius';
import type { Fp } from '../math/fixed';
import type { AABB } from '../state/entities';
import { circlesOverlap, clampToWalkable } from './geom';

const px = (n: number): Fp => pxToFp(n);

function withWall(rect: AABB): GameState {
  const s = createGameState({ seed: 1, worldW: 1600, worldH: 1200, waves: [] });
  s.walls.push(rect);
  s.rebuildSpatialIndex();
  return s;
}

describe('the three radii are genuinely different, so which one you pick matters', () => {
  it('every enemy blueprint has a footprint strictly smaller than its body', () => {
    // The premise of the whole file. If these were equal the two miscited sites would be
    // harmless and this suite would be theatre.
    const offenders: string[] = [];
    for (const bp of Object.values(ENEMY_BLUEPRINTS)) {
      if (!((bp.footprintRadius as number) < (bp.radius as number))) {
        offenders.push(`${bp.type}: footprint ${bp.footprintRadius} is not smaller than body ${bp.radius}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a built enemy blocks by its BODY radius, not its feet (v48)', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [] });
    const e = buildEnemyActor(s, px(400), px(400), 'basic');
    expect(blockingRadius(e)).toBe(e.radius);
    expect(blockingRadius(e)).not.toBe(e.footprintRadius);
  });

  it('the player likewise (v43)', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [] });
    const p = s.players[0]!;
    expect(blockingRadius(p)).toBe(PLAYER_BASE.radius);
    expect(blockingRadius(p)).toBeGreaterThan(PLAYER_BASE.footprintRadius as number);
  });
});

describe('the RULE: clamp an actor by the radius that will push it', () => {
  /**
   * The generic property, stated so it applies to placement sites added later rather than only
   * to the two that exist now. Clamping by anything SMALLER than the push radius leaves the
   * entity inside geometry that the next `MovementSystem.tick` will then teleport it out of.
   */
  const clampThenMeasure = (s: GameState, x: Fp, y: Fp, clampR: Fp, pushR: Fp): number => {
    const placed = clampToWalkable(x, y, clampR, s);
    const settled = clampToWalkable(placed.gx, placed.gy, pushR, s);
    const dx = (settled.gx as number) - (placed.gx as number);
    const dy = (settled.gy as number) - (placed.gy as number);
    return Math.round(Math.sqrt(dx * dx + dy * dy));
  };

  it('clamping by the correct radius leaves nothing further to resolve', () => {
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64) });
    const e = buildEnemyActor(s, px(800), px(590), 'brute');
    const r = blockingRadius(e);
    // Placed with the right radius, the follow-up resolve is a no-op. This is the control that
    // makes the failing case below meaningful rather than an artifact of the measurement.
    expect(clampThenMeasure(s, px(800), px(590), r, r)).toBe(0);
  });

  it('MEASURED DEFECT: clamping a minion by footprintRadius leaves it inside the wall', () => {
    // `DeathDropsSystem.onDeathSpawn` does exactly this. The minion is placed with a 9 px feet
    // circle against a wall that will push its 20 px body, so its first tick is a visible jump.
    // Asserted as a live number, not as `footprint < solid`, so it fails when the behaviour is
    // fixed rather than when the constants are merely renamed.
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64) });
    const brute = buildEnemyActor(s, px(800), px(590), 'brute');
    const jump = clampThenMeasure(s, px(800), px(590), brute.footprintRadius, blockingRadius(brute));
    expect(jump, 'if this is 0 the defect is fixed — invert this test and bump ENGINE_VERSION').toBeGreaterThan(0);
    // Bounded by the gap between the two radii rather than equated to it: the start point is
    // already partly clear, so the first clamp does less than the full gap's worth of work. The
    // upper bound is the part that means something — the error can never EXCEED the radius
    // mistake that causes it.
    const gap = (blockingRadius(brute) as number) - (brute.footprintRadius as number);
    expect(jump).toBeLessThanOrEqual(gap);
    expect(jump).toBeGreaterThan(gap / 4);
  });

  it('the defect scales with the mob — the biggest bodies jump furthest', () => {
    // Not decoration: it says the bug is proportional to body size, so it is worst exactly on
    // the bosses whose death spawns minions in the first place.
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64) });
    // `bp.type`, NOT `bp.id` — the blueprint's registry key is `type`, and passing `undefined`
    // to `buildEnemyActor` silently falls back to the default mob. The first version of this
    // test did exactly that and measured the same 'basic' enemy eight times, reporting an
    // identical jump for every blueprint. A fallback that swallows a bad id is a fixture that
    // makes every mutant equivalent.
    const jumps = Object.values(ENEMY_BLUEPRINTS).map((bp) => {
      const e = buildEnemyActor(s, px(800), px(590), bp.type);
      return { id: bp.type, jump: clampThenMeasure(s, px(800), px(590), e.footprintRadius, blockingRadius(e)) };
    });
    const worst = jumps.reduce((a, b) => (b.jump > a.jump ? b : a));
    const best = jumps.reduce((a, b) => (b.jump < a.jump ? b : a));
    expect(worst.jump).toBeGreaterThan(best.jump);
    expect(worst.jump, `worst first-tick teleport is ${worst.id} at ${worst.jump} fp`).toBeGreaterThan(px(10) as number);
  });
});

describe('a pickup is a different case, and correctly so', () => {
  it('is clamped by SIM.pickupRadius, and nothing ever pushes it afterwards', () => {
    // Worth pinning so the rule above is not "fixed" by making every site use `solidRadius`.
    // A pickup is not an actor: `MovementSystem` never touches it, so its clamp radius answers
    // "can the player reach me", not "will I be displaced". Different question, different
    // radius, deliberately.
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64), freeStanding: true });
    const out = clampToWalkable(px(800), px(595), SIM.pickupRadius, s);
    const again = clampToWalkable(out.gx, out.gy, SIM.pickupRadius, s);
    expect(again).toEqual(out); // idempotent — it settles in one pass and stays there
  });

  it('a drop clamped against a wall is still within collection range of where the player can stand', () => {
    // The invariant the v48 report (*"角色根本无法拾取掉落的物品"*) is really about, stated
    // end-to-end instead of as a comparison between two constants.
    //
    // Note `SIM.pickupRadius` (469 fp, 15 px) is SMALLER than `PLAYER_BASE.solidRadius`
    // (500 fp, 16 px), so a drop legitimately settles 1 px closer to a wall than the player's
    // centre can ever get. A naive `expect(pickupRadius).toBeGreaterThanOrEqual(solidRadius)`
    // therefore FAILS while the game is completely fine — the shortfall is 31 fp against a
    // collection range of 969 fp (pickupRadius + the player's body). Assert reach, not radii.
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64), freeStanding: true });
    const drop = clampToWalkable(px(800), px(595), SIM.pickupRadius, s);
    // The closest the player's own body may ever come to this face, brim included.
    const playerClosest = clampToWalkable(px(800), px(599), PLAYER_BASE.solidRadius, s);
    expect(
      circlesOverlap(drop.gx, drop.gy, SIM.pickupRadius, playerClosest.gx, playerClosest.gy, PLAYER_BASE.radius),
      'a drop settled against a wall is out of reach from the closest legal standing spot',
    ).toBe(true);
  });
});
