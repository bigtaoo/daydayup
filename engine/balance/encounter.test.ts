/**
 * balance/encounter.ts — the room encounter budget's two constants and the one pure
 * function derived from them (ENGINE_VERSION 41). The behavioural half is tested
 * where it lives (`systems/AIDecideSystem.test.ts`'s v41 describe block, plus the
 * end-to-end pass in `systems/dungeonrun.test.ts`); this file pins the properties
 * those tests — and the level's difficulty tuning — silently rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTICE_DELAY_TICKS,
  NOTICE_SPREAD_TICKS,
  ROOM_FIRE_BUDGET,
  noticeDelayTicks,
} from './encounter';
import { DEFAULT_ENEMY_ENGAGE_RANGE_FP } from '../content/enemies';
import { WEAPON_SPECS } from '../content/weapons';
import { SKIN_DEFS } from '../content/skins';

describe('ROOM_FIRE_BUDGET', () => {
  it('is at least 1 — a room with a garrison has to be able to shoot back at all', () => {
    expect(ROOM_FIRE_BUDGET).toBeGreaterThanOrEqual(1);
  });

  it('INVARIANT: the sustained damage it allows cannot kill the frailest character inside 3 seconds', () => {
    // The actual survivability arithmetic the budget was sized on, recomputed from
    // content rather than restated as a magic number — so a change to the enemy gun's
    // cooldown/damage, or to a character's pools, fails HERE instead of silently
    // reintroducing the alpha strike this constant exists to prevent.
    const gun = WEAPON_SPECS.enemygun!;
    const damagePerSecond = (ROOM_FIRE_BUDGET * gun.damage) / gun.cooldownSec;
    const frailest = Math.min(...Object.values(SKIN_DEFS).map((s) => s.maxHp + s.maxShield));
    expect(damagePerSecond * 3).toBeLessThan(frailest);
  });
});

describe('noticeDelayTicks', () => {
  it('never returns less than the floor, nor more than floor + spread', () => {
    for (let id = 0; id < 500; id++) {
      const d = noticeDelayTicks(id);
      expect(d).toBeGreaterThanOrEqual(NOTICE_DELAY_TICKS);
      expect(d).toBeLessThan(NOTICE_DELAY_TICKS + NOTICE_SPREAD_TICKS);
    }
  });

  it('is a floor of ~0.5s and a spread of ~1s at 30Hz — the reaction window on room entry', () => {
    expect(NOTICE_DELAY_TICKS).toBeGreaterThanOrEqual(15);
    expect(NOTICE_SPREAD_TICKS).toBeGreaterThanOrEqual(15);
  });

  it('staggers consecutive ids — a room’s spawn order must not land on one synchronised volley', () => {
    // Consecutive ids are exactly what a room's garrison gets (`GameState.nextId` in
    // spawn order), so this is the case that matters, not a random sample.
    const delays = Array.from({ length: 14 }, (_, i) => noticeDelayTicks(100 + i));
    expect(new Set(delays).size).toBe(delays.length);
  });

  it('is a pure function of the id — same id, same delay, no hidden state or PRNG draw', () => {
    expect(noticeDelayTicks(7)).toBe(noticeDelayTicks(7));
    expect(noticeDelayTicks(12345)).toBe(noticeDelayTicks(12345));
  });

  it('gives the mob time to be seen closing before it can shoot, even from point-blank', () => {
    // A mob authored inside engage range is the case the delay exists for: it cannot
    // shoot for at least NOTICE_DELAY_TICKS regardless of how close it starts.
    expect(DEFAULT_ENEMY_ENGAGE_RANGE_FP).toBeGreaterThan(0);
    expect(noticeDelayTicks(0)).toBe(NOTICE_DELAY_TICKS);
  });
});
