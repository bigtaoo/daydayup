/**
 * Affixes — the in-run power axis (design/05 "in-run drops are the real power
 * axis", design/09 "AFFIX_FIELD_MAP + caps"). An affix is plain data ({id,value});
 * AFFIX_FIELD_MAP tags each id with the sim field it modifies, EFFECT_CAPS bounds
 * the summed stack, and applyAffixes clones a weapon spec and mutates the copy.
 *
 * DETERMINISM (design/06): affixes operate on the ALREADY-CONVERTED sim spec with
 * integer arithmetic — multiplicative kinds carry their value in per-mille (‰), so
 * `base · (1000+Σ) / 1000` then Math.round stays exact and platform-identical (no
 * float survives into stored state, only IEEE round which design/06 permits). This
 * diverges from design/09's "affix targets keyof WeaponSpec (human units), applied
 * at construction" — we apply post-conversion so an in-run pickup can re-resolve a
 * live weapon mid-match without re-reading config. The stack is Σ-then-clamp so it
 * is order-independent (design/09 "order of application is fixed → deterministic").
 *
 * Forward-compat (design/09): an unknown affix id is silently ignored, never a
 * crash — but any change to this arithmetic bumps ENGINE_VERSION (design/08).
 */
import { fp } from '../math/fixed';
import type { WeaponSimSpec } from '../state/entities';

/** An in-run affix roll. `value` is per-mille for `mult_` kinds, absolute for `flat_`/`add_`. */
export interface Affix {
  id: string;
  value: number;
}

/**
 * What a stacked affix kind does. Weapon kinds re-resolve a WeaponSimSpec via
 * applyAffixes; actor kinds (flat_maxhp) are applied to the PlayerActor directly on
 * pickup (they are cumulative state, not re-derived from a base — see PickupSystem).
 */
export type AffixKind =
  | 'flat_damage' //     +N integer damage (weapon)
  | 'mult_firerate' //   +N‰ rate → fewer cooldown ticks (ranged weapon)
  | 'mult_bulletspeed' // +N‰ bullet speed (ranged weapon)
  | 'mult_range' //      +N‰ melee reach (melee weapon)
  | 'flat_maxhp'; //     +N max hp, also heals N (actor)

export const WEAPON_AFFIX_KINDS = new Set<AffixKind>([
  'flat_damage',
  'mult_firerate',
  'mult_bulletspeed',
  'mult_range',
]);

/** id → kind. Unknown ids are dropped by applyAffixes (forward-compat, design/09). */
export const AFFIX_FIELD_MAP: Record<string, { kind: AffixKind }> = {
  dmg: { kind: 'flat_damage' },
  rof: { kind: 'mult_firerate' },
  vel: { kind: 'mult_bulletspeed' },
  reach: { kind: 'mult_range' },
  vit: { kind: 'flat_maxhp' },
};

/** Σ-then-clamp ceiling per kind (design/09 §7.7). Values match the affix unit. */
export const EFFECT_CAPS: Record<AffixKind, number> = {
  flat_damage: 8, //       +8 damage max
  mult_firerate: 700, //   +70% rate (cooldown floors at 1 tick regardless)
  mult_bulletspeed: 1500, // +150% speed
  mult_range: 800, //      +80% reach
  flat_maxhp: 10, //       +10 max hp
};

/** Sum affix values per kind, clamped by EFFECT_CAPS. Unknown ids ignored. */
export function sumAffixes(affixes: readonly Affix[]): Map<AffixKind, number> {
  const sums = new Map<AffixKind, number>();
  for (const a of affixes) {
    const def = AFFIX_FIELD_MAP[a.id];
    if (!def) continue; // forward-compat: unknown id → no-op
    sums.set(def.kind, (sums.get(def.kind) ?? 0) + a.value);
  }
  for (const [kind, total] of sums) sums.set(kind, Math.min(total, EFFECT_CAPS[kind]));
  return sums;
}

/**
 * Clone a weapon's base sim spec and apply the weapon-targeting affixes in the
 * stack. Actor-kind affixes (flat_maxhp) are ignored here — PickupSystem applies
 * those to the actor. Integer-only; safe to call every time the stack grows.
 */
export function applyAffixes(base: WeaponSimSpec, affixes: readonly Affix[]): WeaponSimSpec {
  const sums = sumAffixes(affixes);
  const flatDamage = sums.get('flat_damage') ?? 0;
  const damage = base.damage + flatDamage;

  if (base.kind === 'ranged') {
    const rof = sums.get('mult_firerate') ?? 0;
    const vel = sums.get('mult_bulletspeed') ?? 0;
    return {
      ...base,
      damage,
      // Faster fire = fewer ticks between shots; floor at 1 so it never hits 0.
      fireRateTicks: Math.max(1, Math.round((base.fireRateTicks * 1000) / (1000 + rof))),
      bulletSpeed: fp(Math.round((base.bulletSpeed * (1000 + vel)) / 1000)),
    };
  }

  const reach = sums.get('mult_range') ?? 0;
  return {
    ...base,
    damage,
    range: fp(Math.round((base.range * (1000 + reach)) / 1000)),
  };
}
