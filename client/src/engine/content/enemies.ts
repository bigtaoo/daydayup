/**
 * Enemy blueprints (design/09 actor content). The basic mob plus a set of elemental
 * variants that carry a resist/weakness profile, so damage types matter tactically:
 * match the enemy's weakness to melt it, hit its resistance and it shrugs the hit
 * toward the min-1 floor (design/07). SpawnSystem reads a blueprint by `type` (the
 * optional third field of a wave spawn entry; missing = 'basic').
 *
 * HP / footprint / radius / loadout are in human/px units re-anchored to grid via
 * pxToFp (÷32); the weapon is the shared enemy-gun sim spec (content/weapons.ts).
 * `resist` and `tint` are the variant knobs — `resist` is read by the sim (per-type
 * multiplier), `tint` is render-only (Scene colours the body by it; the sim never
 * reads it, like Actor.z). Adding a new variant here + a new `type` id in a wave is
 * a forward-compatible content add (design/09) — no ENGINE_VERSION bump.
 */
import type { Fp } from '../math/fixed';
import type { RangedSimSpec } from '../state/entities';
import type { ResistMap } from './damage';
import { pxToFp } from './convert';
import { ENEMY_GUN_SIM } from './weapons';

export interface EnemyBlueprint {
  type: string; // registry key + the id a wave spawn entry references
  maxHp: number;
  radius: Fp;
  footprintRadius: Fp; // feet circle for solid push-out (< radius); see Actor.footprintRadius
  weapon: RangedSimSpec;
  // Per-type damage multiplier (per-mille; 1000 = normal, 2000 = weak/×2, 500 = resist/×½).
  // Missing type = neutral. The knob that makes damage types matter per mob (design/07).
  resist?: ResistMap;
  tint?: number; // render-only body colour (design/01); the sim never reads it
}

// ── Basic (neutral) ─────────────────────────────────────────────────────────────
export const BASIC_ENEMY: EnemyBlueprint = {
  type: 'basic',
  maxHp: 3,
  radius: pxToFp(15), // demo 15px
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  // Neutral to every type; status effects still apply. tint omitted → default palette.
};

// ── Elemental variants ──────────────────────────────────────────────────────────
// Each resists its own element (shrug it off) and is weak to a counter, so all four
// elemental weapons have a target they excel against. Slightly higher HP than basic
// so the resist/weakness actually reads before the mob dies. First-pass numbers.

/** Fire mob: shrugs off fire, melts to ice. */
export const EMBERLING: EnemyBlueprint = {
  type: 'emberling',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { fire: 400, ice: 1800 }, // ×0.4 fire, ×1.8 ice
  tint: 0xff7043, // ember orange
};

/** Ice mob: shrugs off ice, melts to fire. */
export const FROSTLING: EnemyBlueprint = {
  type: 'frostling',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { ice: 400, fire: 1800 },
  tint: 0x4fc3f7, // frost blue
};

/** Charged mob: shrugs off lightning, rots to poison. */
export const GALVANIST: EnemyBlueprint = {
  type: 'galvanist',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { lightning: 400, poison: 1800 },
  tint: 0xffd54f, // charged yellow
};

/** Armoured mob: shrugs off bullets (physical) and fire, but conducts lightning.
 *  Tougher — the "bring the right tool" wall. */
export const IRONCLAD: EnemyBlueprint = {
  type: 'ironclad',
  maxHp: 6,
  radius: pxToFp(17),
  footprintRadius: pxToFp(8),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 500, fire: 700, lightning: 1900 }, // armour vs bullets/fire, weak to shock
  tint: 0x90a4ae, // steel grey
};

/** Blueprint registry, keyed by `type` (design/09 "content is plain data keyed by
 *  type"). SpawnSystem resolves a wave entry's type through this; unknown → basic. */
export const ENEMY_BLUEPRINTS: Record<string, EnemyBlueprint> = {
  basic: BASIC_ENEMY,
  emberling: EMBERLING,
  frostling: FROSTLING,
  galvanist: GALVANIST,
  ironclad: IRONCLAD,
};
