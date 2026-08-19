/**
 * buildEnemyActor's movement AI fields (ENGINE_VERSION 37 — see AIDecideSystem's
 * `chase()` and this module's `DEFAULT_ENEMY_MOVE_SPEED_PER_TICK`/
 * `DEFAULT_ENEMY_ENGAGE_RANGE_FP`). Complements bossai.test.ts, which exercises the
 * boss-trait fields (enrage/onDeathSpawn) through the same factory — this file is
 * scoped to the moveSpeedPerTick/engageRangeFp knobs specifically.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import {
  buildEnemyActor,
  ENEMY_BLUEPRINTS,
  BASIC_ENEMY,
  BLIGHTLORD,
  DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
  DEFAULT_ENEMY_ENGAGE_RANGE_FP,
  DEFAULT_ENEMY_AGGRO_RANGE_FP,
} from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import { pxToFp } from '@dd/engine/content/convert';
import { PLAYER_BASE } from '@dd/engine/content/players';

const CFG = { seed: 3, worldW: 1600, worldH: 1200, waves: [] as const };
const state = (): GameState => createGameState(CFG);

describe('buildEnemyActor — movement AI fields (ENGINE_VERSION 37)', () => {
  it('a basic mob gets the shared defaults (no blueprint override authored yet)', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'basic');
    expect(e.moveSpeedPerTick).toBe(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK);
    expect(e.engageRangeFp).toBe(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
    // Confirms this actually exercised the `??` fallback branch, not an authored value.
    expect(BASIC_ENEMY.moveSpeedPerTick).toBeUndefined();
    expect(BASIC_ENEMY.engageRangeFp).toBeUndefined();
  });

  it('a blightlord (boss) also gets the shared defaults — no distinct kiting behavior yet', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'blightlord');
    expect(e.moveSpeedPerTick).toBe(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK);
    expect(e.engageRangeFp).toBe(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
    expect(BLIGHTLORD.moveSpeedPerTick).toBeUndefined();
    expect(BLIGHTLORD.engageRangeFp).toBeUndefined();
  });

  it('an unknown type falls back to BASIC_ENEMY, movement fields included', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'nonexistent-type');
    expect(e.moveSpeedPerTick).toBe(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK);
    expect(e.engageRangeFp).toBe(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
  });

  it('a blueprint-level override wins over the shared default (the knob a future rush/sniper variant would use)', () => {
    const TEST_TYPE = '__test_fast_rusher';
    ENEMY_BLUEPRINTS[TEST_TYPE] = {
      ...BASIC_ENEMY,
      type: TEST_TYPE,
      moveSpeedPerTick: toFp(1), // far above the default — should dominate
      engageRangeFp: toFp(0), // melee-style, closes all the way to the target
    };
    try {
      const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), TEST_TYPE);
      expect(e.moveSpeedPerTick).toBe(toFp(1));
      expect(e.engageRangeFp).toBe(toFp(0));
    } finally {
      delete ENEMY_BLUEPRINTS[TEST_TYPE]; // don't leak a fake registry entry into other test files
    }
  });
});

// Perception radius (ENGINE_VERSION 42) — the third knob in the same family, wired
// through the same `??` fallback. `AIDecideSystem.test.ts` covers what the radius DOES;
// this file covers only that a mob is built carrying it.
describe('buildEnemyActor — perception radius (ENGINE_VERSION 42)', () => {
  it('a fresh mob starts un-aggroed and carries the shared default radius', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'basic');
    expect(e.aggroed).toBe(false); // nothing has noticed the player yet
    expect(e.aggroRangeFp).toBe(DEFAULT_ENEMY_AGGRO_RANGE_FP);
    expect(BASIC_ENEMY.aggroRangeFp).toBeUndefined(); // really took the fallback branch
  });

  it('every shipped blueprint uses the shared radius — no per-mob perception authored yet', () => {
    for (const [type, bp] of Object.entries(ENEMY_BLUEPRINTS)) {
      expect(bp.aggroRangeFp, `${type} authors its own aggroRangeFp`).toBeUndefined();
      expect(buildEnemyActor(state(), pxToFp(400), pxToFp(400), type).aggroRangeFp)
        .toBe(DEFAULT_ENEMY_AGGRO_RANGE_FP);
    }
  });

  it('a blueprint-level override wins over the shared default', () => {
    const TEST_TYPE = '__test_short_sighted';
    ENEMY_BLUEPRINTS[TEST_TYPE] = { ...BASIC_ENEMY, type: TEST_TYPE, aggroRangeFp: toFp(2) };
    try {
      expect(buildEnemyActor(state(), pxToFp(400), pxToFp(400), TEST_TYPE).aggroRangeFp).toBe(toFp(2));
    } finally {
      delete ENEMY_BLUEPRINTS[TEST_TYPE];
    }
  });

  it("the perception radius is WIDER than the engage range, so v40's reaction window survives", () => {
    // A mob that notices the player must still have ground to cover before it may fire.
    // Invert these two and a mob would wake up already in range — the alpha-strike shape
    // v40/v41 exist to prevent.
    expect(DEFAULT_ENEMY_AGGRO_RANGE_FP).toBeGreaterThan(DEFAULT_ENEMY_ENGAGE_RANGE_FP);
  });

  it('a mob is slower than the player, so backing off always opens the gap', () => {
    expect(DEFAULT_ENEMY_MOVE_SPEED_PER_TICK).toBeLessThan(PLAYER_BASE.speedPerTick);
  });
});

describe('buildEnemyActor — solid clearance (ENGINE_VERSION 43)', () => {
  // v43 gave the PLAYER a wall clearance equal to its body radius; mobs deliberately kept
  // the feet circle, because widening a mob's clearance moves every chase path that hugs a
  // wall and that is a balance change to garrisons measured against the current paths
  // (client/sim/pveLevelSim.sim.ts). These pin the opt-out for every shipped blueprint, so
  // a new mob can't quietly inherit the player's number either.
  it('every blueprint builds an actor whose solid clearance is still its feet circle', () => {
    for (const type of Object.keys(ENEMY_BLUEPRINTS)) {
      const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), type);
      expect(e.solidRadius, `${type} widened its wall clearance`).toBe(e.footprintRadius);
    }
  });

  it('every blueprint keeps a clearance SMALLER than its body — mobs still overlap a solid', () => {
    // The fake-3D depth cue design/07 describes is still on for enemies: the sprite may sit
    // against a pillar its body overlaps. This is what v43 changed for the player only.
    for (const type of Object.keys(ENEMY_BLUEPRINTS)) {
      const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), type);
      expect(e.solidRadius, `${type}'s clearance is not below its body radius`).toBeLessThan(e.radius);
    }
  });

  it('a mob\'s clearance is narrower than the player\'s — the asymmetry is intentional, not drift', () => {
    const e = buildEnemyActor(state(), pxToFp(400), pxToFp(400), 'basic');
    expect(e.solidRadius).toBeLessThan(PLAYER_BASE.solidRadius);
  });
});
