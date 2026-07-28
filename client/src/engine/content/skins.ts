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
  // a regenerating shield, and a break burst. Trades body for shield — neither
  // Pareto-dominates the vanguard (guarded by skins.test.ts).
  //
  // Tuned down 2026-07-28 (client/src/game/pvpBalanceSim.sim.ts, seat-index confound
  // fixed first): a shield that fully regenerates between fights is worth more than
  // its raw number in a multi-fight battle royale, since it resets while a flat-HP
  // body's damage compounds — bot-vs-bot data showed a 66% win rate at 8 total budget
  // vs. juggernaut's 8%. maxShield 8->6 and the break burst 3.5/3->3.0/2 trim that
  // sustain edge without changing the character's identity (still the biggest shield
  // in the roster). Re-tune again once real playtesting data exists (design/15).
  skirmisher: {
    id: 'skirmisher',
    atlasKey: 'char_skirmisher',
    animRef: 'humanoid',
    maxHp: 3,
    maxShield: 6,
    shieldBreak: { kind: 'aoe', radiusGrid: 3.0, damage: 2 },
  },
  // Juggernaut — the flat-HP tank (design/14's "0 shield" archetype): the biggest
  // body in the roster and NO shield buffer at all, so it never regenerates between
  // fights and has no shield-break payload (an empty shield can't break). The polar
  // opposite of the skirmisher; neither Pareto-dominates the vanguard (guarded by
  // skins.test.ts). This completes the 3-character launch roster (design/13) with
  // three distinct playstyles.
  //
  // Tuned up 2026-07-28 (same pass as skirmisher above): maxHp 9->11 compensates for
  // having zero regen across a multi-fight match, where the no-comeback downside hurt
  // more than the flat-HP number alone suggested (8% bot-vs-bot win rate). Shield
  // stays 0 — the point of this character is no regen, not a smaller version of the
  // other two.
  juggernaut: {
    id: 'juggernaut',
    atlasKey: 'char_juggernaut',
    animRef: 'humanoid',
    maxHp: 11,
    maxShield: 0,
    // no shieldBreak: a character with no shield can never trigger one (design/14).
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
