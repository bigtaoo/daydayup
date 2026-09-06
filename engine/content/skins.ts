/**
 * Characters (design/02/09/13/14). A **skin IS a character** — there is no cosmetic-
 * only layer (design/14). Every skin carries its own identity as a
 * `(maxHp, maxShield, maxEnergy)` triple + an optional shield-break passive. Characters
 * are balanced as **side-grades** (design/14 "no all-rounder"): none is better than
 * another on every axis — a big regenerating shield buys fragility, a high flat-HP body
 * buys no shield buffer and the shallowest energy pool. `skins.test.ts` guards that rule.
 *
 * `maxEnergy` joined the triple in ENGINE_VERSION 60, closing the gap volume 38 left open
 * ("`MAX_ENERGY` is a flat constant, not a `SkinDef` stat"). What made it safe to open is
 * that capacity is a BURST stat and provably not a dps one: energy regen is a flat shared
 * constant, so every character's sustained rate of fire on an empty bar is identical no
 * matter how big their pool is. The stat therefore crosses design/15's fairness wall (a
 * player's chosen character carries into PvP) without putting a raw power ladder on it.
 *
 * `atlasKey`/`animRef` are RENDER-only refs (the sim ignores them, like `tint`); the
 * defensive numbers are the sim's. Human-unit passive fields (grid radius, grid/s
 * impulse) convert ONCE here into the fp `ShieldBreakSim` the combat layer reads
 * (design/09 convert-once). Shared, character-independent constants live in
 * `PLAYER_BASE` (content/players.ts); the two merge into a PlayerActor at match start.
 */
import type { ShieldBreakSim } from '../state/entities';
import { BASE_MAX_ENERGY } from '../balance/energy';
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
  nameKey: string; // i18n KEY only, never display text (design/09) — client resolves via tName()
  atlasKey: string; // render-only texture atlas key (sim never reads it)
  animRef: string; // render-only animation set
  maxHp: number;
  maxShield: number;
  /**
   * Weapon-energy capacity (`balance/energy.ts`, ENGINE_VERSION 60). The roster's THIRD
   * axis, and the one that is not defensive: it buys burst length, never sustained dps
   * (regen is a flat shared constant), so it trades against the body rather than adding
   * to it — the fragile character gets the deepest bar, the one with the biggest body
   * gets the shallowest. `skins.test.ts` extends the side-grade rule to cover it.
   *
   * Deliberately NOT scaled by `PVP_SCALE_FACTOR` the way `maxHp`/`maxShield` are
   * (`GameState.buildSeat`): that factor exists to keep relative TTK unchanged at a
   * bigger absolute HP range, and it scales weapon DAMAGE alongside the pools it
   * inflates. `energyCost` is not scaled, so multiplying the pool by 5 would not
   * preserve a ratio — it would delete the ammo economy from PvP outright.
   */
  maxEnergy: number;
  shieldBreak?: ShieldBreakPassive;
}

/** The free default character (design/14 free roster). */
export const DEFAULT_SKIN_ID: SkinId = 'vanguard';

export const SKIN_DEFS: Record<string, SkinDef> = {
  // Vanguard — the balanced default: a solid HP body with a moderate shield and a
  // short defensive burst when that shield shatters.
  //
  // Tuned down 2026-07-28 (pvpBalanceSim.sim.ts, after ENGINE_VERSION 29's arena
  // weapon-scaling fix surfaced vanguard as the new dominant seat — was ~45-61% bot-
  // vs-bot win rate across seed sweeps, vs. an ~33% fair share): the HP+shield hybrid
  // out-earns either pure-HP (juggernaut) or mostly-shield (skirmisher) build at the
  // same total budget, since it gets both a persistent body AND a shield that resets
  // (fuelling repeat shieldBreak bursts) between fights. maxShield 4->3.2 trims that
  // edge (verified: shifts win rate toward fair share without moving HP, the weaker
  // lever here — shield does double duty for vanguard so it's the one that matters).
  // Deliberately NOT an integer: every whole-number total between 8 and 11 either
  // exactly matches another character's (hp+shield) budget — which empirically spikes
  // simultaneous-elimination ties (near-symmetric fights double-KO far more often,
  // confirmed across 3 different splits at total=9) — or overcorrects hard (total=8
  // crashed vanguard's win rate regardless of split). Safe only because shield regen
  // (StatusEffectSystem.ts) now clamps to maxShield instead of always `+1`-ing past it.
  vanguard: {
    id: 'vanguard',
    nameKey: 'skin.vanguard.name',
    atlasKey: 'char_vanguard',
    animRef: 'humanoid',
    maxHp: 6,
    maxShield: 3.2,
    // The reference pool itself — every `energyCost` in `content/weaponSpecs/` was priced
    // against this number on the default character, so it is the one value in this column
    // that is a definition rather than a tuning choice (`skins.test.ts` pins it).
    maxEnergy: BASE_MAX_ENERGY,
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
    nameKey: 'skin.skirmisher.name',
    atlasKey: 'char_skirmisher',
    animRef: 'humanoid',
    maxHp: 3,
    maxShield: 6,
    // +30% pool (ENGINE_VERSION 60). The 3 HP body cannot win a long trade, so what it
    // gets is a longer OPENING one: roughly one extra pull of the heaviest frame in the
    // game off a full bar. It buys nothing at all once the bar is empty, which is the
    // property that stops this from simply being "the best character" on a third axis.
    maxEnergy: 130,
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
    nameKey: 'skin.juggernaut.name',
    atlasKey: 'char_juggernaut',
    animRef: 'humanoid',
    maxHp: 11,
    maxShield: 0,
    // -30% pool (ENGINE_VERSION 60) — the counterweight to the biggest body in the
    // roster. This is the character whose fights are long by construction (no shield, no
    // regen, it stands and trades), and length is exactly the regime where capacity stops
    // mattering and the flat regen rate takes over. Paying for 11 HP on the axis that
    // fades in its own preferred fight is the cheapest tax the roster can charge it.
    // Note it collects a proportionally BIGGER share of each `energy` pickup for the same
    // reason (`ENERGY_PICKUP_AMOUNT` is a flat 30, not a fraction of the pool).
    maxEnergy: 70,
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
