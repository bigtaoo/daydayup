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

  it('ships the 3 launch characters (design/13 launch scope)', () => {
    expect(ALL.length).toBe(3);
  });

  // The locked side-grade rule (design/14): no character is strictly better than
  // another. Encoded as: no skin Pareto-dominates another on (maxHp, maxShield).
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

  // The full 2.3 suite (design/13/14 "playstyle-complete free roster"): the roster must
  // actually SPAN a range on each defensive axis — one balanced, one shield-heavy, one
  // HP-heavy — not three near-identical stat lines that happen to dodge Pareto domination.
  it('spans a real range on each defensive axis (distinct playstyles, not clones)', () => {
    const hps = ALL.map((s) => s.maxHp);
    const shields = ALL.map((s) => s.maxShield);
    expect(new Set(hps).size).toBeGreaterThanOrEqual(3); // every character a distinct body
    expect(new Set(shields).size).toBeGreaterThanOrEqual(3); // and a distinct shield buffer
    expect(Math.max(...hps) - Math.min(...hps)).toBeGreaterThanOrEqual(4); // meaningful HP spread
    expect(Math.max(...shields) - Math.min(...shields)).toBeGreaterThanOrEqual(4); // and shield spread
  });

  // Side-grades are of EQUAL WORTH (design/14 "never a power ladder"): total defensive
  // budget (hp + shield) must stay within a tight band, so no character is a global upgrade
  // in raw survivability even while trading one axis for the other.
  it('keeps total defensive budget within a tight band (equal worth, no power ladder)', () => {
    const budgets = ALL.map((s) => s.maxHp + s.maxShield);
    expect(Math.max(...budgets) - Math.min(...budgets)).toBeLessThanOrEqual(3);
  });

  // A shield-break passive is only meaningful on a character that HAS a shield to break
  // (design/14): a zero-shield body must not carry an inert passive.
  it('only shielded characters carry a shield-break passive', () => {
    for (const s of ALL) {
      if (s.maxShield === 0) expect(s.shieldBreak, `${s.id} has an inert passive`).toBeUndefined();
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
