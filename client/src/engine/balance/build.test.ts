import { describe, it, expect } from 'vitest';
import { buildRunSpecs, buildArenaSpecs } from '@dd/engine/balance/build';
import { BLASTER_SIM, SABER_SIM } from '@dd/engine/content/weapons';

describe('buildRunSpecs — PvE run builder', () => {
  it('resolves each loadout slot into a fresh, ready weapon runtime', () => {
    const specs = buildRunSpecs([BLASTER_SIM, SABER_SIM]);
    expect(specs).toHaveLength(2);
    expect(specs[0]!.spec).toEqual(BLASTER_SIM);
    expect(specs[1]!.spec).toEqual(SABER_SIM);
    expect(specs[0]!.cooldownTicks).toBe(0); // fresh weapon is ready
  });
});

describe('the PvP fairness wall (design/05/06/09)', () => {
  it('buildArenaSpecs takes exactly one parameter — no meta arg exists', () => {
    // The wall is structural: buildArenaSpecs(presetId) has arity 1, so persistent
    // gear is compile-time impossible to leak into PvP (design/09 hard-wall).
    expect(buildArenaSpecs.length).toBe(1);
  });

  it('rejects an unknown preset (validate-at-load)', () => {
    expect(() => buildArenaSpecs('does_not_exist')).toThrow();
  });
});
