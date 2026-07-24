/**
 * Engine-global constants (design/09 "all numbers live in @dd/engine config").
 * Balance/content numbers (weapons, enemies, drops) live under content/ and
 * balance/; this file holds only cross-cutting constants and the version guard.
 */
import { TICK_RATE, FP_SCALE } from './math/fixed';
import { BRAD_FULL } from './math/trig';

/**
 * Bumped whenever a change to the core could make an old recorded input stream
 * diverge (system reorder, fp/brad/table change, new PRNG draw site). design/08:
 * ReplayInputSource refuses a mismatched version — fail loud, never replay garbage.
 *
 * v2 (Stage C): spatial unit switched from px-as-fp to real grid (1 grid = 32 px)
 * and weapon/actor numbers moved to the content catalog, so every stored fp
 * position/velocity and weapon value differs from v1 — a v1 input stream would
 * diverge immediately.
 *
 * v3 (Stage D): the player carries a two-slot loadout and SWAP_WEAPON toggles the
 * active slot instead of replacing the weapon with a fresh one — a switch now
 * preserves each slot's cooldown, so a v2 stream that swaps would diverge.
 *
 * v4 (Stage F): the roguelite loop. Enemy deaths roll the full DROP_TABLE
 * (coin/health/affix/weapon) instead of a health-or-coin coin-flip — a different
 * (and branch-variable) number of dropPrng draws per kill — and pickups now mutate
 * the loadout (affix stack re-resolves weapon specs; weapon drops swap a slot). Any
 * v3 stream would diverge at the first kill.
 *
 * v5: static round solids (pillars) now collide. MovementSystem pushes actors out
 * of the EngineConfig obstacle circles (by the actor's feet `footprintRadius`, not
 * the body radius) each tick, and ProjectileStepSystem expires a bullet that
 * reaches a solid. Any v4 stream that walked an actor into — or fired a bullet
 * through — a pillar diverges (both used to pass through).
 *
 * v6: block/jump rework. Parry is no longer a held state — a melee swing deflects
 * enemy bullets caught in its arc (DeflectSystem keys off justSwung + the swing's
 * arc, not a BLOCK button / blockArc). Jump is removed: no z/gravity integration,
 * no JUMP button, actors are strictly 2D. The command bitfield and the serialized
 * state shape both changed, so any v5 stream diverges.
 *
 * v7: opposing-faction bullets collide. HitResolveSystem now cancels an overlapping
 * player/enemy bullet pair (mutual destruction) before the actor-hit loop, so a
 * v6 stream where two enemy/player bullets crossed paths — previously ghosting
 * through each other, now both expiring — diverges.
 *
 * v8: elemental damage types + status effects (design/03/07). Weapons/bullets carry
 * a DamageType; HitResolve applies per-type resist and an on-hit status (fire→burn
 * DoT, ice→chill slow, poison→stacks, lightning→chain to a neighbour), and a new
 * StatusEffectSystem ticks the lingering DoT/chill between hit-resolution (7) and
 * death (now 9). The step order gained a system and actors/bullets gained fields, so
 * any v7 stream diverges the first time a hit lands or an element ticks.
 *
 * v9: element-adding affixes (`elem_*` → set_element kind, overrides a weapon's
 * damageType) enlarge the AFFIX_DROP_POOL, shifting every dropPrng affix roll; and
 * applyResist now ROUNDS a weakness (mult>1000) instead of truncating, so a low-base
 * hit into a weakness lands harder. Either alone diverges a v8 stream.
 *
 * v10: the affix system is removed (design pivot 03/09/14 — Frame × Element, no
 * affixes). The DROP_TABLE no longer has an `affix` entry, so weightedIndex draws a
 * different kind per kill, and a weapon drop no longer re-applies an affix stack. Any
 * v9 stream diverges at the first enemy death.
 *
 * v11: run buffs — the in-run power layer that replaces affixes (design/05/14). The
 * DROP_TABLE gains a `buff` entry, so weightedIndex draws a different kind per kill
 * (diverges a v10 stream at the first drop), and a picked-up buff scales the player's
 * damage / attack-speed (WeaponFire, HitResolve) and max HP (Σ-then-clamp). Enemies
 * carry no buffs (identity), so their fire is unchanged. (Intrinsic rarity, ROADMAP
 * 0.2, shipped between v10 and here WITHOUT a bump — additive, damage byte-identical.)
 */
export const ENGINE_VERSION = 11;

/**
 * World scale — the anchor for every human-unit → fp/brad conversion (design/09).
 * 1 grid unit = 32 px. The demo slice runs render @60fps; the sim runs @30Hz.
 */
export const WORLD = {
  pxPerGrid: 32,
  tickRate: TICK_RATE,
  fpScale: FP_SCALE,
  bradFull: BRAD_FULL,
} as const;

export { TICK_RATE, FP_SCALE };
