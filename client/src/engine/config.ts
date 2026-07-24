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
 *
 * v12: two-pool health (design/02/05/07). Actors gain shield/maxShield/ticksSinceHit;
 * all damage (direct hit, chain, DoT) routes through a shared shield-first `takeDamage`
 * and StatusEffectSystem grows an idle shield-regen sub-pass. A shielded actor now
 * soaks damage differently and its ticksSinceHit advances every tick, so any v11
 * stream where the player (maxShield > 0) takes a hit — or simply idles — diverges.
 *
 * v13: characters = SkinDef (design/02/09/14). The player's (maxHp, maxShield) now
 * come from a chosen SkinDef and it carries a shield-break passive: when its shield
 * empties, takeDamage fires the passive (default 'vanguard' bursts AoE damage to
 * nearby enemies). The default character's break now damages enemies where v12 did
 * nothing, so any v12 stream where the player's shield breaks diverges.
 *
 * v14: pickup taxonomy → design/09 names (heal/material/weapon/buff). The old `coin`
 * becomes `material` and now draws an extra dropPrng roll to pick its element from
 * MATERIAL_DROP_POOL (a distinct carry-out currency), so the drop stream diverges from
 * v13 at the first material drop. (`health`→`heal` is a rename with no behaviour change.)
 *
 * v15: frame library beyond `straight` (design/03/09 Frame axis, ROADMAP 1.1).
 * WeaponFireSystem now fires `bullets` pellets per trigger, jittering each within
 * ±spreadHalf via a NEW combatPrng draw site (a spread weapon's cone is randomized;
 * single-pellet weapons still draw nothing). Four new ballistics — homing (turns
 * toward the nearest foe), lob (AoE blast on landing instead of a silent despawn),
 * beam (hitscan line, damage on a beamTickInterval cadence, doesn't move or clash),
 * boomerang (velocity reverses mid-flight) — replace `straight`'s `pos += vel` for
 * any bullet whose spec names them; existing `straight` weapons are byte-identical.
 * The WEAPON_DROP_POOL grew (scattergun/seeker/mortar/lasercutter/tomahawk/hammer/
 * spear), shifting every dropPrng weapon-id roll. Any v14 stream diverges the first
 * time a spread/homing/lob/beam/boomerang shot fires, or at the first weapon drop.
 *
 * (RoomState collision geometry, ROADMAP 1.2, shipped between v15 and here WITHOUT
 * a bump — additive, like intrinsic rarity in v11's note. `state.walls: AABB[]`
 * is a NEW GameState array, and MovementSystem/ProjectileStepSystem gained a wall-
 * resolution pass, but every existing EngineConfig omits `walls` — so state.walls
 * stays empty and the new code paths are no-ops. No pre-1.2 replay is affected.)
 *
 * (Seeded dungeon assembly — GENERATION ONLY, ROADMAP 1.3 — also shipped without a
 * bump: `state.roomgenPrng` is a new, never-yet-read PRNG stream, and
 * `world/dungeon.ts generateFloor` is pure and unwired into GameEngine.step().)
 *
 * (Extraction rooms + materials carry-out, ROADMAP 1.4/1.5, ALSO shipped without a
 * bump: EngineConfig gained an optional `floors` field and GameState gained
 * `floorIndex`/`floorMaterials`/`bankedMaterials`/`extractHoldTicks` +
 * `floorsEnabled` (= `config.floors !== undefined`) + a 13th step, ExtractionSystem,
 * inserted between Spawns and WinCondition. ExtractionSystem is a hard no-op unless
 * `floorsEnabled`; WinConditionSystem's altered branch is gated the same way. Every
 * config that omits `floors` (every config before this feature existed) is
 * completely untouched. `PickupSystem` now always tracks a collected material into
 * `state.floorMaterials` regardless of `floorsEnabled` — this is new bookkeeping,
 * not new BEHAVIOR: nothing reads that map unless `floorsEnabled`, so it changes no
 * observable outcome for an old config. `rollDrop` gained an optional `tier` param
 * (default 0, identical to the old call) so `DeathDropsSystem` can pass
 * `state.floorIndex` as the material's depth signal.)
 */
export const ENGINE_VERSION = 15;

// ── Two-pool health tuning (design/07; final values are 07 "to design") ──────────
// Whole ticks @30Hz. Shield regen is an idle timer, not a heal: after taking ANY
// damage an actor must stay unhit for DELAY ticks before shield refills +1 per
// INTERVAL, capped at maxShield. A DoT tick resets the timer (StatusEffectSystem),
// so clearing a lingering status is a precondition for regen.
export const SHIELD_REGEN_DELAY = 90; // ~3 s idle before regen starts
export const SHIELD_REGEN_INTERVAL = 300; // ~10 s per +1 shield thereafter

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
