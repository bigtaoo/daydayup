import { describe, it, expect } from 'vitest';
import { buildRunSpecs, buildArenaSpecs, PVP_SCALE_FACTOR } from '@dd/engine/balance/build';
import { BLASTER_SIM, SABER_SIM } from '@dd/engine/content/weapons';
import { SKIN_DEFS, DEFAULT_SKIN_ID } from '@dd/engine/content/skins';

describe('buildRunSpecs — PvE run builder', () => {
  it('resolves each loadout slot into a fresh, ready weapon runtime', () => {
    const specs = buildRunSpecs([BLASTER_SIM, SABER_SIM]);
    expect(specs).toHaveLength(2);
    expect(specs[0]!.spec).toEqual(BLASTER_SIM);
    expect(specs[1]!.spec).toEqual(SABER_SIM);
    expect(specs[0]!.cooldownTicks).toBe(0); // fresh weapon is ready
  });
});

describe('the PvP fairness wall (design/05/06/09/15)', () => {
  it('buildArenaSpecs takes exactly presetId + skinId — no THIRD (meta) arg exists', () => {
    // The wall is structural: buildArenaSpecs(presetId, skinId) has arity 2, so
    // persistent gear is compile-time impossible to leak into PvP (design/09
    // hard-wall). skinId is the wall's one named exception (design/14/15), not a
    // meta leak — it only selects which character's stats get scaled.
    expect(buildArenaSpecs.length).toBe(2);
  });

  it('rejects an unknown preset (validate-at-load)', () => {
    expect(() => buildArenaSpecs('does_not_exist')).toThrow();
  });

  it('scales the default character\'s (maxHp, maxShield) by PVP_SCALE_FACTOR when skinId is omitted', () => {
    const result = buildArenaSpecs('landing_basic');
    const defaultSkin = SKIN_DEFS[DEFAULT_SKIN_ID]!;
    expect(result.maxHp).toBe(Math.round(defaultSkin.maxHp * PVP_SCALE_FACTOR));
    expect(result.maxShield).toBe(Math.round(defaultSkin.maxShield * PVP_SCALE_FACTOR));
  });

  it('scales a NAMED character\'s (maxHp, maxShield), not always the default', () => {
    const result = buildArenaSpecs('landing_basic', 'juggernaut');
    const juggernaut = SKIN_DEFS['juggernaut']!;
    expect(result.maxHp).toBe(Math.round(juggernaut.maxHp * PVP_SCALE_FACTOR));
    expect(result.maxShield).toBe(Math.round(juggernaut.maxShield * PVP_SCALE_FACTOR));
  });

  it('scales the landing kit\'s weapon damage, without mutating the shared authored spec', () => {
    const result = buildArenaSpecs('landing_basic');
    expect(result.weapons).toHaveLength(1);
    expect(result.weapons[0]!.spec.damage).toBe(Math.round(BLASTER_SIM.damage * PVP_SCALE_FACTOR));
    expect(BLASTER_SIM.damage).toBe(1); // the shared PvE constant is untouched
  });
});
