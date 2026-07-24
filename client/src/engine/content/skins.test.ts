import { describe, it, expect } from 'vitest';
import {
  SKIN_DEFS,
  DEFAULT_SKIN_ID,
  resolveSkin,
  toShieldBreakSim,
  type SkinDef,
} from '@dd/engine/content/skins';
import { createGameState } from '@dd/engine/state/GameState';

const ALL: SkinDef[] = Object.values(SKIN_DEFS);

describe('SKIN_DEFS — characters as balanced defensive identities (design/14)', () => {
  it('the default id resolves to a real skin', () => {
    expect(SKIN_DEFS[DEFAULT_SKIN_ID]).toBeDefined();
  });

  it('every skin has a positive HP pool and a valid id/keys', () => {
    for (const s of ALL) {
      expect(s.maxHp).toBeGreaterThan(0);
      expect(s.maxShield).toBeGreaterThanOrEqual(0);
      expect(s.id).toBeTruthy();
      expect(s.atlasKey).toBeTruthy(); // render ref (sim ignores it)
    }
  });

  it('ships at least one non-default character (design/14 roster)', () => {
    expect(ALL.some((s) => s.id !== DEFAULT_SKIN_ID)).toBe(true);
  });

  // The locked side-grade rule (design/14): no character is strictly better than
  // another. Encoded as: no skin Pareto-dominates another on (maxHp, maxShield).
  // This is the balance-test STUB the roadmap asks for — the full 2.3 suite widens it.
  it('no character Pareto-dominates another on (maxHp, maxShield) — no all-rounder', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        if (a.id === b.id) continue;
        const dominates =
          a.maxHp >= b.maxHp &&
          a.maxShield >= b.maxShield &&
          (a.maxHp > b.maxHp || a.maxShield > b.maxShield);
        expect(dominates, `${a.id} strictly dominates ${b.id}`).toBe(false);
      }
    }
  });
});

describe('resolveSkin — forward-compatible selection', () => {
  it('absent or unknown id → the default (design/09)', () => {
    expect(resolveSkin().id).toBe(DEFAULT_SKIN_ID);
    expect(resolveSkin('does_not_exist').id).toBe(DEFAULT_SKIN_ID);
  });

  it('a known id resolves to that character', () => {
    expect(resolveSkin('skirmisher').id).toBe('skirmisher');
  });
});

describe('toShieldBreakSim — human units → fp (convert once)', () => {
  it('converts aoe radius to fp and carries integer damage', () => {
    const sim = toShieldBreakSim({ kind: 'aoe', radiusGrid: 2, damage: 3 });
    expect(sim).toEqual({ kind: 'aoe', radius: 2000, damage: 3 });
  });

  it('converts knock radius + impulse', () => {
    const sim = toShieldBreakSim({ kind: 'knock', radiusGrid: 2, impulseGridPerSec: 10 });
    expect(sim.kind).toBe('knock');
    if (sim.kind === 'knock') {
      expect(sim.radius).toBe(2000);
      expect(sim.impulse).toBeGreaterThan(0);
    }
  });
});

describe('character selection wires into the PlayerActor (design/14)', () => {
  const CFG = { seed: 1, worldW: 800, worldH: 800, waves: [] as const };

  it('the default character spawns with the default skin stats + passive', () => {
    const p = createGameState(CFG).players[0]!;
    const def = resolveSkin();
    expect(p.maxHp).toBe(def.maxHp);
    expect(p.maxShield).toBe(def.maxShield);
    expect(p.shield).toBe(def.maxShield); // spawns with a full shield
    expect(p.shieldBreak).toBeDefined();
  });

  it('selecting a non-default character changes (maxHp, maxShield) + passive', () => {
    const p = createGameState({ ...CFG, skinId: 'skirmisher' }).players[0]!;
    expect(p.maxHp).toBe(3);
    expect(p.maxShield).toBe(8);
    expect(p.shieldBreak).toEqual({ kind: 'aoe', radius: 3500, damage: 3 });
  });
});
