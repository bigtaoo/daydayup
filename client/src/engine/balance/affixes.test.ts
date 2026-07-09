import { describe, it, expect } from 'vitest';
import {
  AFFIX_FIELD_MAP,
  EFFECT_CAPS,
  applyAffixes,
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

  it('every AFFIX_FIELD_MAP kind has a cap', () => {
    for (const { kind } of Object.values(AFFIX_FIELD_MAP)) {
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
