import { describe, it, expect } from 'vitest';
import { buildRunSpecs, buildArenaSpecs, PVP_SCALE_FACTOR, ARENA_PRESET_IDS } from '@dd/engine/balance/build';
import { BLASTER_SIM, SABER_SIM, WEAPON_SIM_BY_ID } from '@dd/engine/content/weapons';
import { PLAYER_BASE } from '@dd/engine/content/players';
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

  it('scales EVERY landing-kit weapon\'s damage, without mutating the shared authored specs', () => {
    const result = buildArenaSpecs('landing_basic');
    expect(result.weapons).toHaveLength(2); // gun + melee (ENGINE_VERSION 45)
    expect(result.weapons.map((w) => w.spec.damage)).toEqual([
      Math.round(BLASTER_SIM.damage * PVP_SCALE_FACTOR),
      Math.round(SABER_SIM.damage * PVP_SCALE_FACTOR),
    ]);
    // The shared PvE constants are untouched — scaleWeaponDamage copies (design/15).
    expect(BLASTER_SIM.damage).toBe(1);
    expect(SABER_SIM.damage).toBe(2);
  });

  /**
   * The class-level gate for "a character always carries a gun AND a melee weapon"
   * (ENGINE_VERSION 45) on the PvP side. PvE gets this from `resolveLoadout`, which an
   * arena kit deliberately does NOT go through (the fairness wall keeps arena content
   * arena-scoped), so the invariant has to be asserted against the authored presets
   * themselves — swept from `ARENA_PRESET_IDS` rather than a hand-written id list, so a
   * preset added later is covered the day it is authored.
   */
  describe('every authored landing kit, swept', () => {
    it('the sweep has real subjects', () => {
      expect(ARENA_PRESET_IDS.length).toBeGreaterThan(0);
    });

    it.each(ARENA_PRESET_IDS)('%s: one gun + one melee weapon, within the carried-slot budget', (presetId) => {
      const weapons = buildArenaSpecs(presetId).weapons;
      expect(weapons.length).toBeLessThanOrEqual(PLAYER_BASE.weaponSlots);
      expect(new Set(weapons.map((w) => w.spec.kind))).toEqual(new Set(['ranged', 'melee']));
    });

    it.each(ARENA_PRESET_IDS)('%s: the melee slot can parry — design/03 trade-off reachable from the drop', (presetId) => {
      const melee = buildArenaSpecs(presetId).weapons.find((w) => w.spec.kind === 'melee');
      expect(melee).toBeDefined();
      expect(melee!.spec.kind === 'melee' && melee!.spec.deflect).toBe(true);
    });

    it.each(ARENA_PRESET_IDS)('%s: every slot is PvP-scaled — nothing ships at raw PvE damage', (presetId) => {
      // A kit weapon left unscaled would be a real balance hole (a 2-damage saber against
      // a 30 HP pool), and `scaleWeaponDamage` is applied by the builder, not the data.
      for (const w of buildArenaSpecs(presetId).weapons) {
        const authored = WEAPON_SIM_BY_ID[w.spec.name]!;
        expect(w.spec.damage).toBe(Math.round(authored.damage * PVP_SCALE_FACTOR));
      }
    });
  });
});
