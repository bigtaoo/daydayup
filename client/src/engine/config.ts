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
 * (Dungeon mode WIRED LIVE, ROADMAP 1.3 — ALSO no bump: EngineConfig gained an optional
 * `dungeon` field. When present, SpawnSystem drives spawns from a generated room
 * sequence (drawing roomgenPrng), swaps `state.walls`/`obstacles` + `worldW`/`worldH`
 * per room via `roomGeometry`, and ExtractionSystem's descend generates the next floor
 * instead of loading a flat wave list; `floorsEnabled` is now true for a `dungeon`
 * config too. Every config that omits `dungeon` (every config before this) never draws
 * roomgenPrng, never mutates walls/obstacles/world bounds, and keeps `roomIndex` at -1 —
 * byte-identical, no observable change. `worldW`/`worldH` and the walls/obstacles arrays
 * became mutable-in-dungeon-mode, but a non-dungeon config sets them once and never
 * again, exactly as when they were `readonly`.)
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
 *
 * (v15→16 — orbit ballistic + radial emission, ROADMAP 1.1 tier-4 follow-up: the last
 * two frame-library shapes. `BallisticId` gained 'orbit' (a projectile that circles its
 * owner — new Projectile `ownerId`/`orbitRadius`/`orbitAngleBrad`/`orbitAngularVelBrad`
 * fields + an orbit branch in ProjectileStepSystem); `RangedSimSpec` gained a required
 * `pattern` ('spread' | 'radial') driving WeaponFireSystem's emission layout — 'spread'
 * is the byte-identical default every prior weapon converts to. Why this bumps: two
 * showcase weapons (novaburst/gyre) join WEAPON_DROP_POOL, shifting the dropPrng
 * weapon-id roll — same precedent as the 1.1 frame weapons.)
 *
 * (v16→17 — co-op downed/revive, ROADMAP 3.2: a lethal hit now sends a player `downed`
 * (frozen, 0 HP, `alive` stays true) instead of dead — DeathDropsSystem sets it, a new
 * ReviveSystem (step 13) runs the bleedout timer + a teammate's sustained-INTERACT revive
 * channel, and WinConditionSystem ends a run when no player is "up" (`alive && !downed`).
 * PlayerActor gained `downed`/`bleedoutTicks`/`reviveProgressTicks` (serialized). Why this
 * bumps even though single-player outcomes are unchanged: the player-death representation
 * changed (downed vs alive=false, a 'downed' event instead of the immediate 'death'), so
 * replay bytes move. Downed players are invulnerable and untargetable — HitResolve/AIDecide/
 * ProjectileStep/StatusEffect skip them via isDowned.)
 *
 * v18: team/hostility model (design/15, ROADMAP 4.2a — PvP prerequisite #1). Every
 * `Actor`/`Projectile` gains a `teamId: number`, independent of `faction` — a NEW axis,
 * since `faction` only ever answered "player-controlled or AI" and combat code used it
 * as a stand-in for "who's on my side" by hardcoding a 2-array split. A shared
 * `isHostile(a,b) = a.teamId !== b.teamId` predicate (state/entities.ts) plus
 * `hostileTargets`/`nearestHostile` (new systems/targeting.ts) replace every
 * `faction === 'player' ? state.enemies : state.players`-shaped ternary in
 * HitResolveSystem, DeflectSystem, ProjectileStepSystem, and combat.ts. Enemies get the
 * reserved `ENEMY_TEAM_ID` (-1); every player seat defaults to a SHARED team 0
 * (`PlayerConfig.teamId ?? 0`, `GameState.buildSeat`) unless a config assigns each seat
 * its own — so every existing single-player and co-op config keeps allies non-hostile,
 * byte-identical in the SET of (bullet, target) pairs tested. Why this still bumps
 * despite that: (1) bullets can now hit ANY hostile actor rather than "the other array" —
 * a rival player's bullet/melee/deflect now reaches another player once a config assigns
 * distinct teamIds (PvP, not yet built, but the capability itself is new code on the hot
 * path); (2) two INCIDENTAL corrections ride along, closing latent gaps the old
 * 2-faction ternaries had: `resolveBulletClash` used to skip same-`faction` bullets
 * (so two hypothetically-hostile players' bullets, both 'player'-faction, would never have
 * clashed) — now gated on `isHostile`, matching intent; and the lightning chain's
 * candidate pool (and the lob/beam blast pool) now flow through the shared
 * `hostileTargets`, which excludes downed players — previously chain's `group` was a raw
 * `state.players` array that `chain()` only filtered by `alive`, so a downed teammate
 * could technically still be chained to, inconsistent with 3.2's "downed = invulnerable."
 * Both are correctness fixes, not intentional design changes, but either could move an
 * old replay's bytes at the exact tick it would have mattered. Single-player and existing
 * co-op are unaffected in every practical scenario; the guard is there because "provably
 * safe for the default case" is not the same promise as "provably safe for every old
 * recorded replay," and design/08's rule is to fail loud rather than risk the latter.
 *
 * v19: anti-cheat `integrityPrng` (design/15, ROADMAP 4.4) + closing a hash-coverage
 * gap left by v18's zone/placement work (4.2d/4.2e). `GameState` gains a new seeded
 * stream drawn once per tick, unconditionally, in `GameEngine.step` — NEVER read by
 * any gameplay system (see its doc comment), so no outcome for any config/mode
 * changes. `serializeState` (replay.ts) now also hashes `ringPrng`/`integrityPrng`'s
 * cursors and `state.zone`/`state.placements` directly (previously a zone-state
 * divergence would only surface indirectly, once it produced different damage) —
 * both null/empty and stable for every non-arena config. Bumps because
 * `hashState()`'s output value moves for every tick of every replay — the "state
 * shape gained a field, so replay bytes move" precedent v17 (downed/revive) already
 * established as sufficient on its own, even with zero gameplay effect for existing
 * modes.
 *
 * v20: `buildArenaSpecs` wired into `GameState.buildSeat` (design/15, ROADMAP 4.2c —
 * the last unwired PvP-prerequisite piece). When `config.arena` is set, a seat's
 * weapons/`maxHp`/`maxShield` now come from `buildArenaSpecs(config.arenaPreset ??
 * 'landing_basic', seat.skinId)` — the landing-kit loadout + `PVP_SCALE_FACTOR`-scaled
 * body stats — instead of the PvE run-builder path (`seat.loadout` via
 * `WEAPON_SIM_BY_ID` + the character's plain `SkinDef` numbers). `seat.loadout` is now
 * structurally never read for an arena seat (the fairness wall enforced at
 * construction, not just by convention). Bumps because this is a REAL, intentional
 * gameplay-affecting change to every arena-mode config's player numbers (HP/damage,
 * not just hash bookkeeping) — every config that omits `arena` (every PvE/co-op config)
 * is completely untouched, byte-identical.
 */
export const ENGINE_VERSION = 20;

// ── Two-pool health tuning (design/07; final values are 07 "to design") ──────────
// Whole ticks @30Hz. Shield regen is an idle timer, not a heal: after taking ANY
// damage an actor must stay unhit for DELAY ticks before shield refills +1 per
// INTERVAL, capped at maxShield. A DoT tick resets the timer (StatusEffectSystem),
// so clearing a lingering status is a precondition for regen.
export const SHIELD_REGEN_DELAY = 90; // ~3 s idle before regen starts
export const SHIELD_REGEN_INTERVAL = 300; // ~10 s per +1 shield thereafter

// ── Co-op downed / revive (design/05/07, ROADMAP 3.2). Whole ticks @30Hz. A lethal
// hit sends a player `downed`; a teammate revives via a sustained INTERACT channel.
export const DOWNED_BLEEDOUT_TICKS = 900; // ~30 s downed before permanent death (paused while being revived)
export const REVIVE_CHANNEL_TICKS = 450; // ~15 s sustained INTERACT to complete a revive (design/05 locked)
export const REVIVE_HP = 2; // HP a revived player comes back with (a small amount, design/07)
export const REVIVE_RANGE_GRID = 1.5; // how close the reviver must stand, grid units

// ── PvP anti-cheat periodic checkpoints (design/15, ROADMAP 4.4) ──────────────────
// Generalizes the existing end-of-match `ClientMsg.result.stateHash` (replay.ts
// hashState) into a tick-indexed check DURING a match. Design/15 is explicit these
// numbers are a first-pass proposal, not tuned ("real play required").
export const CHECKPOINT_TICKS = 150; // ~5s @ 30Hz cadence between periodic reports
// Below this many REAL (connected) seats, run no consensus check at all — an early
// bot-padded low-population match is expected to be internally inconsistent
// (design/15), and "not enough honest signal to trust a majority" applies at any
// seat count this low regardless of population stage.
export const CHECKPOINT_QUORUM = 3;
// A seat is only kicked once it disagrees with the majority at the SAME historical
// tick across this many CONSECUTIVE checkpoints — never a single stray mismatch
// (which is more likely a client still catching up under the lag/backlog
// multiplier than an actual state fork, design/15).
export const INTEGRITY_KICK_STREAK = 2;

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
