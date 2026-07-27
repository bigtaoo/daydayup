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
  boss?: boolean; // render-only (like tint): the view draws a health bar for a boss
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
  tint: 0x81d4fa, // frost blue — matches design/13's locked ice element hue (ELEMENT_COLORS.ice)
};

/** Charged mob: shrugs off lightning, rots to poison. */
export const GALVANIST: EnemyBlueprint = {
  type: 'galvanist',
  maxHp: 4,
  radius: pxToFp(15),
  footprintRadius: pxToFp(7),
  weapon: ENEMY_GUN_SIM,
  resist: { lightning: 400, poison: 1800 },
  tint: 0xfff176, // charged yellow — matches design/13's locked lightning element hue (ELEMENT_COLORS.lightning)
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

// ── Boss ────────────────────────────────────────────────────────────────────────
// The durable finale — a big, tanky mob that survives long enough to *show* the
// combat systems working (design/03/07): its huge HP pool lets poison stacks ramp
// to full and lingering burn/chill/poison auras persist visibly, while its broad
// resist profile forces the player to find the right damage type. It shrugs bullets
// (physical, floored to min-1) and partially resists fire/ice/lightning, but is
// doubly WEAK to poison — so the intended kill is to stack venom and let the DoT
// melt it, the clearest showcase of independent poison stacks on a target that
// doesn't die first. Neutral-ish elements still land, so their auras read too.
export const BLIGHTLORD: EnemyBlueprint = {
  type: 'blightlord',
  maxHp: 40, // ~a dozen full-poison DoT ticks; bullets alone take forever (min-1)
  radius: pxToFp(30), // twice a basic mob — reads as a boss; auras/bar scale with it
  footprintRadius: pxToFp(14),
  weapon: ENEMY_GUN_SIM,
  resist: { physical: 400, fire: 800, ice: 800, lightning: 800, poison: 2000 },
  tint: 0x8e24aa, // toxic purple
  boss: true,
};

/** Blueprint registry, keyed by `type` (design/09 "content is plain data keyed by
 *  type"). SpawnSystem resolves a wave entry's type through this; unknown → basic. */
export const ENEMY_BLUEPRINTS: Record<string, EnemyBlueprint> = {
  basic: BASIC_ENEMY,
  emberling: EMBERLING,
  frostling: FROSTLING,
  galvanist: GALVANIST,
  ironclad: IRONCLAD,
  blightlord: BLIGHTLORD,
};
