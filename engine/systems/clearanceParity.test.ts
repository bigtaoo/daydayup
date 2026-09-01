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
import { blockingRect } from './solidBounds';
import { dropClearance } from '../state/actorRadius';
import { DeathDropsSystem } from './DeathDropsSystem';
import { PickupSystem } from './PickupSystem';
import { SpawnSystem } from './SpawnSystem';
import { EnvironmentSystem } from './EnvironmentSystem';
import { ZoneSystem } from './ZoneSystem';
import { toFpGrid } from '../content/convert';

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

  it('a built enemy blocks by its BODY radius, floored at the player\'s (v48, v50)', () => {
    const s = createGameState({ seed: 1, worldW: 800, worldH: 800, waves: [] });
    // `basic` is one of the four blueprints the v50 floor binds on (15 px body vs the player's
    // 16), so the assertion is the floor rather than the body here — see
    // `content/enemies.test.ts` for the same rule stated over the whole registry, including the
    // wide bodies that do keep their own silhouette.
    const e = buildEnemyActor(s, px(400), px(400), 'basic');
    expect(blockingRadius(e)).toBe(PLAYER_BASE.solidRadius);
    expect(blockingRadius(e) as number).toBeGreaterThanOrEqual(e.radius as number);
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

describe('a drop lands where a PLAYER BODY fits (ENGINE_VERSION 50)', () => {
  it('is clamped by dropClearance(), and settles in one pass', () => {
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64), freeStanding: true });
    const out = clampToWalkable(px(800), px(595), dropClearance(), s);
    const again = clampToWalkable(out.gx, out.gy, dropClearance(), s);
    expect(again).toEqual(out); // idempotent — it settles in one pass and stays there
  });

  it("dropClearance() IS the player's own solid clearance, and it is wider than the collect padding", () => {
    // The premise. Through v49 the drop sites used `SIM.pickupRadius`, on the reasoning that a
    // pickup is not an actor and its clamp answers "can the player reach me". Right question,
    // wrong radius: the thing that has to reach it is a player's BODY.
    expect(dropClearance()).toBe(PLAYER_BASE.solidRadius);
    expect(dropClearance() as number).toBeGreaterThan(SIM.pickupRadius as number);
  });

  it('MEASURED: the real death drop comes to rest somewhere a player body can stand', () => {
    // End-to-end through `DeathDropsSystem`, not through the clamp in isolation — the defect
    // class this whole file exists for is a placement SITE citing the wrong radius, so the
    // assertion has to run the site.
    //
    // The geometry is chosen to separate the two radii, because shipped content does not: the
    // ember floors are authored on a 1000 fp lattice, so their narrowest gap is exactly
    // 2 x PLAYER_BASE.solidRadius and a 469 fp circle is never the only thing that fits. A
    // 970 fp slot is the smallest interesting case — a 469 fp drop settles happily inside it,
    // a 500 fp player body does not fit at all.
    const s = slotState(970);
    const mob = buildEnemyActor(s, 4485 as Fp, 7500 as Fp, 'basic');
    mob.hp = 0;
    s.enemies.push(mob);
    new DeathDropsSystem().tick(s);
    const drop = s.pickups[0];
    expect(drop, 'the mob died without dropping anything — pick a seed whose roll produces one').toBeDefined();
    // Pre-v50 this landed at (4485, 7500) untouched, because a 469 fp circle clears both faces
    // by 16 fp. Post-v50 the clamp is a 500 fp circle and the slot pushes it.
    expect({ gx: drop!.gx as number, gy: drop!.gy as number }).not.toEqual({ gx: 4485, gy: 7500 });
  });

  /**
   * ALL THREE placement sites, on the one fixture built to separate the two radii.
   *
   * The case above runs `DeathDropsSystem` only, and that was the whole behavioural coverage
   * of v50's second half. The other two sites were free: reverting `PickupSystem.applyWeapon`
   * or `SpawnSystem.spawnArenaLoot` to `SIM.pickupRadius` — or deleting `applyWeapon`'s clamp
   * outright — left both packages green, because
   *
   *   - `pickups.test.ts` exercises the weapon swap for the SLOT it lands in and the item it
   *     leaves behind, never for that item's POSITION, and its CFG has no walls at all;
   *   - `arenaSpawn.test.ts` asserts the marker lands at `toFpGrid(2)` in a wall-free map, so
   *     the clamp is a no-op there and any radius passes.
   *
   * `PickupSystem.ts:171-174` says the call "exists to keep the three sites from drifting
   * apart again". This is the thing that enforces it. Each row drives the real system and is
   * checked BOTH ways: it must land where `dropClearance()` puts it, and it must NOT land
   * where `SIM.pickupRadius` would — the second half is what makes the row a measurement of
   * the radius rather than a restatement of "some clamp ran".
   */
  const SRC = { gx: 4485 as Fp, gy: 7500 as Fp };

  interface Site {
    name: string;
    /** Runs the real placement site with its source at `SRC`, returning the state it ran
     *  against (so the two reference clamps below are computed on the SAME geometry) and
     *  where the drop actually came to rest. */
    run: () => { s: GameState; pos: { gx: number; gy: number } };
  }

  const SITES: Site[] = [
    {
      name: 'DeathDropsSystem — a mob dies inside the slot',
      run: () => {
        const s = slotState(970);
        const mob = buildEnemyActor(s, SRC.gx, SRC.gy, 'basic');
        mob.hp = 0;
        s.enemies.push(mob);
        new DeathDropsSystem().tick(s);
        const drop = s.pickups[0];
        expect(drop, 'the mob died without dropping anything — pick a seed whose roll produces one').toBeDefined();
        return { s, pos: { gx: drop!.gx as number, gy: drop!.gy as number } };
      },
    },
    {
      name: 'PickupSystem.applyWeapon — the weapon a swap knocks out of the player\'s hands',
      run: () => {
        const s = slotState(970);
        const p = s.players[0]!;
        p.gx = SRC.gx;
        p.gy = SRC.gy;
        expect(p.weapons.length, 'the swap only drops something if the slot was already full').toBeGreaterThan(0);
        // A ranged weapon, so `slotFor` picks the slot the starter blaster is in and the
        // blaster is the thing that gets displaced. Collected through the real click path:
        // `pickupTargetId` set, `spawnTick` in the past, inside `lootRevealRadius`.
        const offered = { id: s.nextId(), kind: 'weapon' as const, weaponId: 'repeater', gx: SRC.gx, gy: SRC.gy, spawnTick: 0, alive: true };
        s.pickups.push(offered);
        s.tick = 1;
        p.pickupTargetId = offered.id;
        new PickupSystem().tick(s);
        const dropped = s.pickups.filter((q) => q.id !== offered.id);
        expect(dropped.length, 'the swap did not drop the outgoing weapon at all').toBe(1);
        return { s, pos: { gx: dropped[0]!.gx as number, gy: dropped[0]!.gy as number } };
      },
    },
    {
      name: 'SpawnSystem.spawnArenaLoot — an authored arena loot marker',
      run: () => {
        const s = arenaSlotState();
        // Room A covers the whole map, so standing anywhere clear of the slot activates it;
        // `EnvironmentSystem` is what assigns room membership, exactly as `arenaSpawn.test.ts`
        // drives it.
        const p = s.players[0]!;
        p.gx = 1000 as Fp;
        p.gy = 1000 as Fp;
        new ZoneSystem().tick(s);
        new EnvironmentSystem().tick(s);
        new SpawnSystem().tick(s);
        expect(s.pickups.length, 'the room never activated, so no loot was placed').toBe(1);
        const item = s.pickups[0]!;
        return { s, pos: { gx: item.gx as number, gy: item.gy as number } };
      },
    },
  ];

  for (const site of SITES) {
    it(`${site.name} — lands where dropClearance() puts it, not where SIM.pickupRadius would`, () => {
      const { s, pos } = site.run();
      const byBody = clampToWalkable(SRC.gx, SRC.gy, dropClearance(), s);
      const byPadding = clampToWalkable(SRC.gx, SRC.gy, SIM.pickupRadius, s);

      // Per-row anti-vacuity: on THIS geometry the two radii must actually disagree, or
      // the `not.toEqual` below would hold for a site with no clamp at all.
      expect(
        { gx: byBody.gx as number, gy: byBody.gy as number },
        'the fixture stopped discriminating the two radii — the rows below prove nothing',
      ).not.toEqual({ gx: byPadding.gx as number, gy: byPadding.gy as number });

      expect(pos).toEqual({ gx: byBody.gx as number, gy: byBody.gy as number });
      expect(pos).not.toEqual({ gx: byPadding.gx as number, gy: byPadding.gy as number });
    });
  }

  it('a drop clamped against a wall is still within collection range of where the player can stand', () => {
    // The invariant the v48 report (*"角色根本无法拾取掉落的物品"*) is really about, stated
    // end-to-end instead of as a comparison between two constants. Kept from v49 — it is now
    // implied by the stronger property above on open geometry, but it is the statement that
    // stays meaningful if the collect radius is ever retuned independently.
    const s = withWall({ x: px(700), y: px(600), w: px(200), h: px(64), freeStanding: true });
    const drop = clampToWalkable(px(800), px(595), dropClearance(), s);
    // The closest the player's own body may ever come to this face, brim included.
    const playerClosest = clampToWalkable(px(800), px(599), PLAYER_BASE.solidRadius, s);
    expect(
      circlesOverlap(drop.gx, drop.gy, SIM.pickupRadius, playerClosest.gx, playerClosest.gy, PLAYER_BASE.radius),
      'a drop settled against a wall is out of reach from the closest legal standing spot',
    ).toBe(true);
  });
});

describe('the honest limit: a clamp separates, it does not escape', () => {
  /**
   * `clampToWalkable` pushes a point out of what it overlaps, repeated to a fixed point. In a
   * pocket NARROWER than the clamp radius there is nothing to converge on: each wall pushes the
   * point into the other, the pass makes no net movement, and the early exit reports "settled"
   * on a point that is still inside stone.
   *
   * That is not a bug to fix in the clamp — no radius produces a standable answer in a slot no
   * body fits — but it IS what stops v50 from being a construction proof. What actually keeps
   * drops standable on shipped floors is that no shipped floor has such a pocket, and that is a
   * CONTENT property. `smoke.test.ts`'s "every alive pickup sits where a player body could
   * stand" is where it is enforced, per tick, on every shipped scenario.
   *
   * Recorded here so the next person to widen a body radius or author a tighter room knows
   * which test will catch them, and why it is that one and not this file.
   */
  it('a slot narrower than a player admits no standable point, at any clamp radius', () => {
    const s = slotState(970);
    for (const r of [SIM.pickupRadius, dropClearance()]) {
      const out = clampToWalkable(4485 as Fp, 7500 as Fp, r, s);
      expect(
        deepestWallOverlap(s, out.gx, out.gy, PLAYER_BASE.solidRadius),
        `a ${r} fp clamp found a player-standable spot in a 970 fp slot — geometry says there is none`,
      ).toBeGreaterThan(0);
    }
  });

  it('one authored grid cell is EXACTLY two player radii — the margin content relies on', () => {
    // 1000 fp of gap, 500 fp of body each side. Every shipped room is authored on this lattice
    // (`world/dungeons/ember/pieces/*.json`, `world/rooms/ember.ts`), so a single-cell corridor
    // is passable by exactly tangency and no more. Raising PLAYER_BASE.solidRadius by ONE fp
    // seals every one of them — the same wall v48 hit when it tried a 24 px north brim and
    // `launchArena.test.ts` reported 45 regions becoming 61.
    //
    // Asserted as the relationship, not as the two numbers, so it reads as the constraint it is.
    expect((PLAYER_BASE.solidRadius as number) * 2).toBe(toFpGrid(1) as number);
  });

  it('the slot fixture really is the discriminating case — a 1000 fp gap is fine for both', () => {
    // Anti-vacuity for the pair above: if `slotState` were subtly wrong (walls not where the
    // numbers say) every clamp would report "inside stone" and both tests would pass for free.
    const s = slotState(1000);
    const out = clampToWalkable(4500 as Fp, 7500 as Fp, dropClearance(), s);
    expect(out).toEqual({ gx: 4500, gy: 7500 });
    expect(deepestWallOverlap(s, out.gx, out.gy, PLAYER_BASE.solidRadius)).toBeLessThanOrEqual(0);
  });
});

/**
 * The SAME slot, reached through the arena pipeline — the only way to drive
 * `SpawnSystem.spawnArenaLoot`, which reads its source point off an authored `lootMarker`
 * rather than taking one. One room covering the whole map, one marker on the slot's centre
 * line (grid 4.485 = 4485 fp, matching `SRC`), and `slotState`'s own wall list swapped in for
 * the map's (empty) geometry, so all three sites are measured against literally the same
 * stone instead of a second hand-built approximation of it.
 */
function arenaSlotState(): GameState {
  const s = createGameState({
    seed: 1,
    worldW: 0,
    worldH: 0,
    waves: [],
    arena: {
      id: 'clearance_slot',
      sizeGrid: { w: 20, h: 20 },
      rooms: [
        {
          id: 'A',
          rectGrid: { x: 0, y: 0, w: 20, h: 20 },
          solids: [],
          lootMarkers: [{ point: { x: 4.485, y: 7.5 }, tableId: 'common' }],
        },
      ],
      doors: [],
      spawns: [{ x: 1, y: 1 }],
      eyeCandidates: [{ roomId: 'A' }],
    },
  });
  s.walls.length = 0;
  s.walls.push(...slotState(970).walls);
  s.rebuildSpatialIndex();
  return s;
}

/**
 * A dead-end slot `gap` fp wide, open to the north: two blocks whose facing edges are `gap`
 * apart, and a cap across the south end. The slot's centre line is x = 4000 + gap/2.
 */
/**
 * A dead-end slot `gap` fp wide, open to the north: two blocks whose facing edges are `gap`
 * apart, and a cap across the south end. The slot's centre line is x = 4000 + gap/2.
 */
function slotState(gap: number): GameState {
  const s = createGameState({ seed: 1, worldW: 20000, worldH: 20000, waves: [] });
  s.walls.push({ x: 0 as Fp, y: 6000 as Fp, w: 4000 as Fp, h: 4000 as Fp });
  s.walls.push({ x: (4000 + gap) as Fp, y: 6000 as Fp, w: 4000 as Fp, h: 4000 as Fp });
  s.walls.push({ x: 4000 as Fp, y: 9000 as Fp, w: gap as Fp, h: 1000 as Fp });
  s.rebuildSpatialIndex();
  return s;
}

/**
 * How far a circle of radius `r` at (gx, gy) reaches into the nearest wall. Positive means
 * overlap. Deliberately geometric rather than "does the clamp move it": in a too-narrow pocket
 * the clamp's own fixed-point exit reports no movement while the point is still inside stone,
 * which is the trap the two tests above are about.
 */
function deepestWallOverlap(s: GameState, gx: Fp, gy: Fp, r: Fp): number {
  let worst = -Infinity;
  for (const w of s.walls) {
    const b = blockingRect(w);
    const cx = Math.max(b.left as number, Math.min(gx as number, b.right as number));
    const cy = Math.max(b.top as number, Math.min(gy as number, b.bottom as number));
    const dx = (gx as number) - cx;
    const dy = (gy as number) - cy;
    worst = Math.max(worst, (r as number) - Math.sqrt(dx * dx + dy * dy));
  }
  return worst;
}
