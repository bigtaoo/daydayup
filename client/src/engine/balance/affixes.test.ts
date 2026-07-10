import { describe, it, expect } from 'vitest';
import {
  AFFIX_FIELD_MAP,
  EFFECT_CAPS,
  applyAffixes,
  resolveElement,
  sumAffixes,
  type Affix,
} from '@dd/engine/balance/affixes';
import { BLASTER_SIM, SABER_SIM } from '@dd/engine/content/weapons';
import type { RangedSimSpec, MeleeSimSpec } from '@dd/engine/state/entities';

describe('applyAffixes — weapon power stack', () => {
  it('flat_damage stacks additively', () => {
    const out = applyAffixes(BLASTER_SIM, [
      { id: 'dmg', value: 1 },
      { id: 'dmg', value: 2 },
    ]) as RangedSimSpec;
    expect(out.damage).toBe(BLASTER_SIM.damage + 3);
  });

  it('clamps a stack to EFFECT_CAPS (Σ-then-clamp)', () => {
    const many: Affix[] = Array.from({ length: 20 }, () => ({ id: 'dmg', value: 2 }));
    const out = applyAffixes(BLASTER_SIM, many) as RangedSimSpec;
    expect(out.damage).toBe(BLASTER_SIM.damage + EFFECT_CAPS.flat_damage);
  });

  it('mult_firerate lowers cooldown ticks and floors at 1', () => {
    const faster = applyAffixes(BLASTER_SIM, [{ id: 'rof', value: 350 }]) as RangedSimSpec;
    expect(faster.fireRateTicks).toBeLessThan(BLASTER_SIM.fireRateTicks);
    const capped = applyAffixes(BLASTER_SIM, [
      { id: 'rof', value: 100000 }, // far past the cap
    ]) as RangedSimSpec;
    expect(capped.fireRateTicks).toBeGreaterThanOrEqual(1);
  });

  it('mult_bulletspeed scales bullet speed up', () => {
    const out = applyAffixes(BLASTER_SIM, [{ id: 'vel', value: 500 }]) as RangedSimSpec;
    expect(out.bulletSpeed).toBe(Math.round((BLASTER_SIM.bulletSpeed * 1500) / 1000));
  });

  it('mult_range extends melee reach only', () => {
    const out = applyAffixes(SABER_SIM, [{ id: 'reach', value: 400 }]) as MeleeSimSpec;
    expect(out.range).toBe(Math.round((SABER_SIM.range * 1400) / 1000));
  });

  it('is order-independent (Σ-then-clamp is commutative)', () => {
    const a: Affix[] = [
      { id: 'dmg', value: 2 },
      { id: 'rof', value: 200 },
      { id: 'dmg', value: 1 },
    ];
    const b = [...a].reverse();
    expect(applyAffixes(BLASTER_SIM, a)).toEqual(applyAffixes(BLASTER_SIM, b));
  });

  it('ignores an unknown affix id (forward-compat)', () => {
    const out = applyAffixes(BLASTER_SIM, [{ id: 'not_a_real_affix', value: 999 }]);
    expect(out).toEqual(BLASTER_SIM);
  });

  it('ignores an actor-kind affix (flat_maxhp) on a weapon', () => {
    const out = applyAffixes(BLASTER_SIM, [{ id: 'vit', value: 5 }]);
    expect(out).toEqual(BLASTER_SIM);
  });

  it('does not mutate the base spec', () => {
    const before = { ...BLASTER_SIM };
    applyAffixes(BLASTER_SIM, [{ id: 'dmg', value: 3 }]);
    expect(BLASTER_SIM).toEqual(before);
  });

  it('every numeric AFFIX_FIELD_MAP kind has a cap (set_element is exempt)', () => {
    for (const { kind } of Object.values(AFFIX_FIELD_MAP)) {
      if (kind === 'set_element') continue; // non-numeric: overrides, never summed
      expect(EFFECT_CAPS[kind]).toBeTypeOf('number');
    }
  });

  it('sumAffixes clamps per kind', () => {
    const sums = sumAffixes([
      { id: 'dmg', value: 100 },
      { id: 'rof', value: 5 },
    ]);
    expect(sums.get('flat_damage')).toBe(EFFECT_CAPS.flat_damage);
    expect(sums.get('mult_firerate')).toBe(5);
  });
});

describe('element-adding affixes (set_element)', () => {
  it('grants a physical weapon its element and preserves other stats', () => {
    expect(BLASTER_SIM.damageType).toBe('physical'); // baseline assumption
    const out = applyAffixes(BLASTER_SIM, [{ id: 'elem_fire', value: 0 }]) as RangedSimSpec;
    expect(out.damageType).toBe('fire');
    expect(out.damage).toBe(BLASTER_SIM.damage); // value is unused, no stat change
    expect(out.fireRateTicks).toBe(BLASTER_SIM.fireRateTicks);
  });

  it('works on melee weapons too', () => {
    const out = applyAffixes(SABER_SIM, [{ id: 'elem_poison', value: 0 }]) as MeleeSimSpec;
    expect(out.damageType).toBe('poison');
  });

  it('composes with numeric affixes (element + damage in one stack)', () => {
    const out = applyAffixes(BLASTER_SIM, [
      { id: 'elem_ice', value: 0 },
      { id: 'dmg', value: 2 },
    ]) as RangedSimSpec;
    expect(out.damageType).toBe('ice');
    expect(out.damage).toBe(BLASTER_SIM.damage + 2);
  });

  it('leaves damageType alone when no element affix is present', () => {
    const out = applyAffixes(BLASTER_SIM, [{ id: 'dmg', value: 1 }]);
    expect(out.damageType).toBe(BLASTER_SIM.damageType);
  });

  it('resolveElement picks a fixed winner (order-independent) when several are present', () => {
    const a: Affix[] = [{ id: 'elem_fire', value: 0 }, { id: 'elem_poison', value: 0 }];
    const b = [...a].reverse();
    expect(resolveElement(a)).toBe(resolveElement(b));
    // poison is last in DAMAGE_TYPES → outranks fire.
    expect(resolveElement(a)).toBe('poison');
  });

  it('resolveElement returns undefined with no element affix', () => {
    expect(resolveElement([{ id: 'dmg', value: 2 }])).toBeUndefined();
  });
});
