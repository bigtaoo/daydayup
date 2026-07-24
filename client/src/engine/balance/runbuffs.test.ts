import { describe, it, expect } from 'vitest';
import {
  RUN_BUFFS,
  BUFF_CAPS,
  NO_BUFFS,
  sumBuffs,
  buffedDamage,
  buffedCooldown,
} from './runbuffs';
import { createGameState } from '../state/GameState';
import { WeaponFireSystem } from '../systems';

const CFG = { seed: 5, worldW: 800, worldH: 800, waves: [] as const };

describe('run-buff catalogue (design/14 in-run power layer)', () => {
  it('every buff maps to a known kind and a valid magnitude', () => {
    for (const def of Object.values(RUN_BUFFS)) {
      expect(BUFF_CAPS[def.kind]).toBeGreaterThan(0);
      expect(def.value).toBeGreaterThan(0);
      expect(def.nameKey).toMatch(/^buff\./); // i18n key only, never display text
    }
  });
});

describe('sumBuffs — Σ-then-clamp, deterministic', () => {
  it('empty stack is the identity', () => {
    expect(sumBuffs([])).toEqual(NO_BUFFS);
  });

  it('sums per kind then clamps at the cap', () => {
    // 5× dmg_up (+500 each = 2500) clamps to the +2000 cap.
    const many = Array.from({ length: 5 }, () => 'dmg_up');
    expect(sumBuffs(many).mult_damage).toBe(BUFF_CAPS.mult_damage);
    // 2× dmg_up = 1000, under the cap → exact sum.
    expect(sumBuffs(['dmg_up', 'dmg_up']).mult_damage).toBe(1000);
  });

  it('is order-independent (Σ-then-clamp)', () => {
    const a = sumBuffs(['dmg_up', 'rof_up', 'vit_up']);
    const b = sumBuffs(['vit_up', 'dmg_up', 'rof_up']);
    expect(a).toEqual(b);
  });

  it('ignores unknown buff ids (forward-compat, design/09)', () => {
    expect(sumBuffs(['dmg_up', 'not_a_real_buff'])).toEqual(sumBuffs(['dmg_up']));
  });

  it('flat_hp clamps independently of the mult kinds', () => {
    const stack = Array.from({ length: 9 }, () => 'vit_up'); // 9×2 = 18 → cap 10
    expect(sumBuffs(stack).flat_hp).toBe(BUFF_CAPS.flat_hp);
  });
});

describe('buff application (integer, deterministic)', () => {
  it('buffedDamage is identity with no buffs, scales up with the damage buff', () => {
    expect(buffedDamage(3, NO_BUFFS)).toBe(3);
    // +50% (dmg_up): 1→2 (round 1.5), 2→3, 3→5 (round 4.5).
    const one = sumBuffs(['dmg_up']);
    expect(buffedDamage(1, one)).toBe(2);
    expect(buffedDamage(2, one)).toBe(3);
    expect(buffedDamage(3, one)).toBe(5);
  });

  it('buffedCooldown is identity with no buffs, and shortens with attack speed', () => {
    expect(buffedCooldown(6, NO_BUFFS)).toBe(6);
    // +40% rate (rof_up): 6 → round(6000/1400) = round(4.28) = 4.
    expect(buffedCooldown(6, sumBuffs(['rof_up']))).toBe(4);
  });

  it('cooldown never floors below 1 tick even at the cap', () => {
    const maxed = Array.from({ length: 3 }, () => 'rof_up'); // clamps to +70%
    expect(buffedCooldown(1, sumBuffs(maxed))).toBe(1);
  });
});

describe('run buffs through WeaponFireSystem (measurable + player-only)', () => {
  const fire = new WeaponFireSystem();

  /** Fire the starter blaster once from a fresh player carrying `buffs`; return the shot. */
  function fireOnce(buffs: string[]) {
    const s = createGameState(CFG);
    const p = s.players[0]!;
    p.buffs = buffs;
    p.firing = true;
    fire.tick(s);
    return { projectile: s.projectiles[0]!, cooldown: p.weapon!.cooldownTicks };
  }

  it('a damage buff measurably raises the fired projectile damage', () => {
    const base = fireOnce([]).projectile.damage; // blaster dmg 1
    const buffed = fireOnce(['dmg_up']).projectile.damage;
    expect(buffed).toBeGreaterThan(base);
    expect(buffed).toBe(buffedDamage(base, sumBuffs(['dmg_up'])));
  });

  it('an attack-speed buff measurably shortens the cooldown', () => {
    const base = fireOnce([]).cooldown;
    const buffed = fireOnce(['rof_up']).cooldown;
    expect(buffed).toBeLessThan(base);
  });

  it('is deterministic and order-independent — identical buffed runs produce identical shots', () => {
    expect(fireOnce(['dmg_up', 'rof_up'])).toEqual(fireOnce(['rof_up', 'dmg_up']));
  });
});
