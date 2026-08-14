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
} from '@dd/engine/content/enemies';
import { toFp } from '@dd/engine/math/fixed';
import { pxToFp } from '@dd/engine/content/convert';

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
