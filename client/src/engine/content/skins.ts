/**
 * Characters (design/02/09/13/14). A **skin IS a character** — there is no cosmetic-
 * only layer (design/14). Every skin carries its own defensive identity: a
 * `(maxHp, maxShield)` pair + an optional shield-break passive. Characters are
 * balanced as **side-grades** (design/14 "no all-rounder"): none is strictly better
 * than another on both defensive axes — a big regenerating shield buys fragility, a
 * high flat-HP body buys no shield buffer. `skins.test.ts` guards that rule.
 *
 * `atlasKey`/`animRef` are RENDER-only refs (the sim ignores them, like `tint`); the
 * defensive numbers are the sim's. Human-unit passive fields (grid radius, grid/s
 * impulse) convert ONCE here into the fp `ShieldBreakSim` the combat layer reads
 * (design/09 convert-once). Shared, character-independent constants live in
 * `PLAYER_BASE` (content/players.ts); the two merge into a PlayerActor at match start.
 */
import type { ShieldBreakSim } from '../state/entities';
import { toFpGrid, toFpPerTick } from './convert';

export type SkinId = string;

/** Authored shield-break passive (human units); converted to ShieldBreakSim below. */
export interface AoeBreak {
  kind: 'aoe';
  radiusGrid: number; // burst reach, grid
  damage: number; // integer, dealt to every foe in reach
}
export interface KnockBreak {
  kind: 'knock';
  radiusGrid: number; // shove reach, grid
  impulseGridPerSec: number; // outward impulse, grid/s (persistent knockback friction is design/07 to-come)
}
export type ShieldBreakPassive = AoeBreak | KnockBreak;

export interface SkinDef {
  id: SkinId;
  atlasKey: string; // render-only texture atlas key (sim never reads it)
  animRef: string; // render-only animation set
  maxHp: number;
  maxShield: number;
  shieldBreak?: ShieldBreakPassive;
}

/** The free default character (design/14 free roster). */
export const DEFAULT_SKIN_ID: SkinId = 'vanguard';

export const SKIN_DEFS: Record<string, SkinDef> = {
  // Vanguard — the balanced default: a solid HP body with a moderate shield and a
  // short defensive burst when that shield shatters.
  vanguard: {
    id: 'vanguard',
    atlasKey: 'char_vanguard',
    animRef: 'humanoid',
    maxHp: 6,
    maxShield: 4,
    shieldBreak: { kind: 'aoe', radiusGrid: 2.5, damage: 2 },
  },
  // Skirmisher — the fragile-but-shielded side-grade (design/05/14 example): low HP,
  // a big regenerating shield, and a wider break burst. Trades body for shield —
  // neither Pareto-dominates the vanguard (guarded by skins.test.ts).
  skirmisher: {
    id: 'skirmisher',
    atlasKey: 'char_skirmisher',
    animRef: 'humanoid',
    maxHp: 3,
    maxShield: 8,
    shieldBreak: { kind: 'aoe', radiusGrid: 3.5, damage: 3 },
  },
};

/** Convert an authored passive into the fp shape the combat layer reads (once). */
export function toShieldBreakSim(p: ShieldBreakPassive): ShieldBreakSim {
  return p.kind === 'aoe'
    ? { kind: 'aoe', radius: toFpGrid(p.radiusGrid), damage: p.damage }
    : { kind: 'knock', radius: toFpGrid(p.radiusGrid), impulse: toFpPerTick(p.impulseGridPerSec) };
}

/** Resolve a skin id to its def; unknown/absent → the default (forward-compat, design/09). */
export function resolveSkin(id?: SkinId): SkinDef {
  return (id ? SKIN_DEFS[id] : undefined) ?? SKIN_DEFS[DEFAULT_SKIN_ID]!;
}
