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
import type { DamageType } from '../content/damage';
import { DAMAGE_TYPES } from '../content/damage';

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
  | 'set_element' //     overrides the weapon's damageType (weapon, non-numeric)
  | 'flat_maxhp'; //     +N max hp, also heals N (actor)

/** The numeric kinds — the ones sumAffixes stacks and EFFECT_CAPS bounds. */
type NumericAffixKind = Exclude<AffixKind, 'set_element'>;

export const WEAPON_AFFIX_KINDS = new Set<AffixKind>([
  'flat_damage',
  'mult_firerate',
  'mult_bulletspeed',
  'mult_range',
  'set_element',
]);

/**
 * id → kind (+ the element for `set_element`). Unknown ids are dropped by
 * applyAffixes (forward-compat, design/09).
 */
export const AFFIX_FIELD_MAP: Record<string, { kind: AffixKind; element?: DamageType }> = {
  dmg: { kind: 'flat_damage' },
  rof: { kind: 'mult_firerate' },
  vel: { kind: 'mult_bulletspeed' },
  reach: { kind: 'mult_range' },
  vit: { kind: 'flat_maxhp' },
  // Element-adding drops: grant any weapon an element (and its on-hit status). A
  // roll's `value` is ignored — the element comes from the id via this map.
  elem_fire: { kind: 'set_element', element: 'fire' },
  elem_ice: { kind: 'set_element', element: 'ice' },
  elem_lightning: { kind: 'set_element', element: 'lightning' },
  elem_poison: { kind: 'set_element', element: 'poison' },
};

/** Σ-then-clamp ceiling per numeric kind (design/09 §7.7). Values match the affix unit. */
export const EFFECT_CAPS: Record<NumericAffixKind, number> = {
  flat_damage: 8, //       +8 damage max
  mult_firerate: 700, //   +70% rate (cooldown floors at 1 tick regardless)
  mult_bulletspeed: 1500, // +150% speed
  mult_range: 800, //      +80% reach
  flat_maxhp: 10, //       +10 max hp
};

/** Sum numeric affix values per kind, clamped by EFFECT_CAPS. Unknown/set_element ignored. */
export function sumAffixes(affixes: readonly Affix[]): Map<NumericAffixKind, number> {
  const sums = new Map<NumericAffixKind, number>();
  for (const a of affixes) {
    const def = AFFIX_FIELD_MAP[a.id];
    if (!def || def.kind === 'set_element') continue; // forward-compat / non-numeric
    sums.set(def.kind, (sums.get(def.kind) ?? 0) + a.value);
  }
  for (const [kind, total] of sums) sums.set(kind, Math.min(total, EFFECT_CAPS[kind]));
  return sums;
}

/**
 * Resolve the element granted by the affix stack, or undefined if none. A "set", not
 * a sum: when several element affixes are present the winner is fixed by DAMAGE_TYPES
 * order (the highest-indexed element present), so the result is order-independent —
 * same guarantee as the Σ-then-clamp numeric stack (design/09).
 */
export function resolveElement(affixes: readonly Affix[]): DamageType | undefined {
  let best: DamageType | undefined;
  let bestRank = -1;
  for (const a of affixes) {
    const el = AFFIX_FIELD_MAP[a.id]?.element;
    if (!el) continue;
    const rank = DAMAGE_TYPES.indexOf(el);
    if (rank > bestRank) {
      bestRank = rank;
      best = el;
    }
  }
  return best;
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
  // An element affix overrides the weapon's own type; absent, the base type stands.
  const damageType = resolveElement(affixes) ?? base.damageType;

  if (base.kind === 'ranged') {
    const rof = sums.get('mult_firerate') ?? 0;
    const vel = sums.get('mult_bulletspeed') ?? 0;
    return {
      ...base,
      damage,
      damageType,
      // Faster fire = fewer ticks between shots; floor at 1 so it never hits 0.
      fireRateTicks: Math.max(1, Math.round((base.fireRateTicks * 1000) / (1000 + rof))),
      bulletSpeed: fp(Math.round((base.bulletSpeed * (1000 + vel)) / 1000)),
    };
  }

  const reach = sums.get('mult_range') ?? 0;
  return {
    ...base,
    damage,
    damageType,
    range: fp(Math.round((base.range * (1000 + reach)) / 1000)),
  };
}
