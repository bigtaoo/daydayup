/**
 * Damage types & status effects (design/03 "distinct behavior", design/07 combat).
 * A hit carries a DamageType; physical is the plain flat-damage path, the four
 * elements each layer an on-hit status the combat systems interpret:
 *
 *   physical  → raw damage only (the existing behaviour)
 *   fire      → BURN: a refreshing damage-over-time (keeps topping up while hit)
 *   ice       → CHILL: a movement slow for a duration (MovementSystem scales vx/vy)
 *   lightning → CHAIN: the hit arcs to the nearest other same-side actor in range
 *   poison    → POISON: independent stacks, each its own timer (ramps with uptime)
 *
 * DETERMINISM (design/06): every number here is an integer or an Fp; status
 * magnitudes derive from the (already-integer) hit damage with integer arithmetic;
 * DoT ticks on the global `state.tick % DOT_INTERVAL` cadence (no float, no clock
 * field); chain uses squared-distance nearest (no trig). Nothing draws a PRNG, so
 * types add no new random-draw site. This module holds ONLY types + constants +
 * pure helpers on primitives — it never imports GameState, so content/state can
 * depend on it without a cycle (mirrors how entities.ts imports Affix).
 *
 * Any change to a constant or the arithmetic below alters outcomes → bump
 * ENGINE_VERSION (design/08).
 */
import type { Fp } from '../math/fixed';
import { toFpGrid } from './convert';

export type DamageType = 'physical' | 'fire' | 'ice' | 'lightning' | 'poison';

/** All types, for content validation / UI enumeration. */
export const DAMAGE_TYPES: readonly DamageType[] = [
  'physical',
  'fire',
  'ice',
  'lightning',
  'poison',
];

// ── Status runtime (plain data on every Actor; systems are the only mutators) ──
//
// One poison stack — its own remaining ticks + per-hit damage, so stacks expire
// independently (the "ramp with uptime" identity vs fire's single refreshing timer).

export interface PoisonStack {
  ticks: number; // remaining ticks
  dmg: number; // damage per DoT interval
}

export interface StatusState {
  burnTicks: number; // remaining burn duration (0 = not burning)
  burnDmg: number; // damage per DoT interval while burning
  chillTicks: number; // remaining chill duration (0 = not chilled)
  chillSlow: number; // per-mille movement slow while chilled (0..1000)
  poison: PoisonStack[]; // independent stacks, ascending age (push order)
}

/** A fresh, effect-free status block. Every actor is constructed with one. */
export function freshStatus(): StatusState {
  return { burnTicks: 0, burnDmg: 0, chillTicks: 0, chillSlow: 0, poison: [] };
}

// ── Tuning (design/07 "engine config, tuned vs play"; first pass) ──────────────
// Economy anchor: player 6 HP, basic enemy 3 HP, sim @30Hz.

/** DoT damage lands every N ticks (0.5 s). Burn and poison share this cadence. */
export const DOT_INTERVAL = 15;

/** Burn (fire): a refreshing DoT — reapplying resets the timer and takes the bigger tick. */
export const BURN_DURATION = 45; // 1.5 s → ~3 DoT ticks
/** Burn damage per interval, derived from the hit: half the hit, min 1. */
export function burnDamageFor(hitDamage: number): number {
  return Math.max(1, hitDamage >> 1);
}

/** Chill (ice): a movement slow. */
export const CHILL_DURATION = 45; // 1.5 s
export const CHILL_SLOW = 400; // 40% slower while chilled (per-mille)

/** Poison: independent stacks that ramp with sustained hits. */
export const POISON_STACK_DURATION = 60; // 2 s per stack → ~4 DoT ticks each
export const POISON_MAX_STACKS = 6;
export const POISON_STACK_DMG = 1; // each stack ticks 1 (stacking is the power)

/** Lightning (chain): the hit arcs to one nearby same-side actor. */
export const CHAIN_RANGE: Fp = toFpGrid(3); // reach of the arc, grid → fp
export const CHAIN_DMG_PERMILLE = 500; // chained hit deals 50% of the primary (min 1)

// ── Resist / weakness ──────────────────────────────────────────────────────────
// A per-type multiplier in per-mille on the target (1000 = normal, 2000 = weak/×2,
// 500 = resistant/×½). Missing type → 1000. A hit never rounds below 1 (design/07
// min-1), so a resist reduces toward 1, a weakness amplifies.

export type ResistMap = Partial<Record<DamageType, number>>;

/**
 * Apply a target's resist/weakness to a raw hit. Integer, floors at 1.
 *
 * Weakness (mult > 1000) rounds so a small hit still SHOWS its bonus — a base-1 hit
 * ×1.8 rounds to 2 rather than truncating back to 1, which would make weakness
 * invisible on low-damage elemental weapons. Resistance (mult < 1000) truncates
 * toward the min-1 floor so it always reduces. Changing this rounding diverges
 * replays → bump ENGINE_VERSION (design/08).
 */
export function applyResist(rawDamage: number, type: DamageType, resist?: ResistMap): number {
  const mult = resist?.[type] ?? 1000;
  if (mult === 1000) return rawDamage;
  const scaled = (rawDamage * mult) / 1000;
  const out = mult > 1000 ? Math.round(scaled) : Math.trunc(scaled);
  return Math.max(1, out);
}
