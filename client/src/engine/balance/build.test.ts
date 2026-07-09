import { describe, it, expect } from 'vitest';
import { buildRunSpecs, buildArenaSpecs, resolveWeapon } from '@dd/engine/balance/build';
import { BLASTER_SIM, SABER_SIM } from '@dd/engine/content/weapons';
import type { RangedSimSpec } from '@dd/engine/state/entities';

describe('resolveWeapon', () => {
  it('retains the base and applies the stack to the active spec', () => {
    const w = resolveWeapon(BLASTER_SIM, [{ id: 'dmg', value: 2 }]);
    expect(w.base).toBe(BLASTER_SIM); // unaffixed base retained for re-resolution
    expect((w.spec as RangedSimSpec).damage).toBe(BLASTER_SIM.damage + 2);
    expect(w.cooldownTicks).toBe(0); // fresh weapon is ready
  });
});

describe('buildRunSpecs — PvE run builder', () => {
  it('resolves each loadout slot with the run affix stack', () => {
    const specs = buildRunSpecs([BLASTER_SIM, SABER_SIM], [{ id: 'dmg', value: 1 }]);
    expect(specs).toHaveLength(2);
    expect(specs[0]!.spec.damage).toBe(BLASTER_SIM.damage + 1);
    expect(specs[1]!.spec.damage).toBe(SABER_SIM.damage + 1);
  });

  it('with no affixes yields the base specs unchanged', () => {
    const specs = buildRunSpecs([BLASTER_SIM], []);
    expect(specs[0]!.spec).toEqual(BLASTER_SIM);
  });
});

describe('the PvP fairness wall (design/05/06/09)', () => {
  it('buildArenaSpecs takes exactly one parameter — no meta/affix arg exists', () => {
    // The wall is structural: buildArenaSpecs(presetId) has arity 1, so persistent
    // gear is compile-time impossible to leak into PvP (design/09 hard-wall).
    expect(buildArenaSpecs.length).toBe(1);
  });

  it('rejects an unknown preset (validate-at-load)', () => {
    expect(() => buildArenaSpecs('does_not_exist')).toThrow();
  });
});
