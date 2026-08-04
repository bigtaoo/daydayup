/**
 * Engine-global constants (design/09 "all numbers live in @dd/engine config").
 * Balance/content numbers (weapons, enemies, drops) live under content/ and
 * balance/; this file holds only cross-cutting constants and the version guard.
 */
import { TICK_RATE, FP_SCALE, type Fp } from './math/fixed';
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
 *
 * v21: `PickupSystem`'s weapon-kind branch now matches design/03:121-126 ("weapons
 * are NOT auto-picked-up... button-driven") instead of auto-swapping on mere overlap
 * like every other pickup kind — it now requires a freshly-pressed INTERACT (rising
 * edge) while overlapping, and drops the outgoing weapon back onto the floor as a
 * new pickup. `PlayerActor` gained `wasInteracting` (PickupSystem's own cross-tick
 * edge memory — `prevButtons` can't serve this: ApplyInputSystem already overwrites
 * it with the CURRENT tick's bitfield before PickupSystem's step runs). Bumps because
 * a replay recorded under v20 that picked up a weapon via overlap alone, with no
 * INTERACT held, replays differently under this rule — a real outcome change for
 * identical commands, not additive.
 *
 * v22: actor–actor collision (design/07 step 4.3 — the one "still deferred" half of
 * movement/collision; every actor↔solid case had already shipped). `MovementSystem`
 * gains `resolveActorPairs`: every overlapping pair among ALL alive actors (players
 * AND enemies, not gated by faction — "same-plane pair" in the design doc), resolved
 * in a fixed ascending-id-ordered sequence, gets pushed apart along their centre
 * line by half the penetration each (footprint circles, same radius convention as
 * the existing solid-push code). Actors that used to freely overlap (two players
 * standing on each other, an enemy walking into another enemy, a player pushing
 * through a mob) now physically separate every tick they're close enough to
 * overlap — any replay where any two actors ever got that close diverges the first
 * tick it happens, even though no new PRNG draw or state field is involved.
 *
 * v23: enemy-enemy collision exception (design/07 "Open questions" — enemies lean
 * overlap rather than block, per the doc's own recommendation). `resolveActorPairs`
 * now skips a pair where BOTH actors are `faction === 'enemy'` before the push-apart
 * math runs; player-vs-player and player-vs-enemy pairs are unchanged, still pushed
 * apart unconditionally. Any replay where two enemies got close enough to overlap
 * under v22 diverges under v23 (they no longer separate) — a real outcome change,
 * even though no new PRNG draw or state field is involved.
 *
 * v24: drop/pickup spawn points are clamped into walkable space (`geom.ts`
 * `clampToWalkable`, no new PRNG draw — pure geometry against the existing
 * `state.walls`/`obstacles`/world bounds). A dead enemy's own position could be
 * on/behind a wall (a knockback shove, or a big footprint dying flush against
 * geometry), and arena loot markers / a swapped-out weapon's drop-back point were
 * never checked at all — any of those could previously spawn a pickup somewhere
 * the player couldn't reach. `DeathDropsSystem`, `PickupSystem.applyWeapon`, and
 * `SpawnSystem.spawnArenaLoot` now all push the computed point out of any
 * overlapping wall/obstacle and clamp it inside the world bounds before creating
 * the `PickupItem`. Any replay where a drop's pre-clamp point was already outside
 * that margin diverges (the pickup now sits at a different, walkable position).
 *
 * v25: knockback is real (design/07 "persistent-knockback friction", the one
 * remaining gap the doc's own "to design" list named). Two independent gaps closed
 * together since both live in the same knockVx/knockVy channel: (1) melee
 * `knockback` (grid/s, authored on every `MeleeSpec` since Stage C) was authored but
 * never converted by `toSimSpec` NOR applied by `HitResolveSystem` — a swing's shove
 * was pure flavour text until now; (2) the shield-break `knock` passive wrote its
 * impulse directly into `vx`/`vy`, which is broken for BOTH factions: a player's
 * vx/vy is fully overwritten every tick by `ApplyInputSystem` from input (the impulse
 * would be erased before `MovementSystem` ever integrated it), and an enemy's vx/vy
 * is never touched by AI at all (so once knocked it would drift at that exact velocity
 * forever, with no decay — the literal missing "friction" design/07 flagged). Actor
 * gained `knockVx`/`knockVy`, a channel independent of vx/vy: `MovementSystem.integrate`
 * adds it into this tick's displacement alongside vx/vy (unaffected by chill slow — a
 * shove is an external force, not the actor's own movement speed), then decays it by
 * `KNOCKBACK_FRICTION_PERMILLE` every tick, snapping to exactly 0 below
 * `KNOCKBACK_SNAP_FP` so it doesn't drift as a sub-pixel residual forever. Any replay
 * that ever triggers a `knock` shield-break passive or connects a melee swing with
 * nonzero `knockback` (saber/hammer/emberblade/frostbrand/stormglaive/spear all carry
 * one) diverges from its old (no-op) outcome — a real gameplay change, not additive.
 *
 * v26: the `crit` run-buff family is real (`balance/runbuffs.ts` — the roadmap's own
 * "needs a hit-time PRNG draw" deferral for this one family, now built). `RunBuffKind`
 * gains `crit_chance` (Σ-clamp, same shape as the other three) + a new `crit_up`
 * pickup; the multiplier itself (`CRIT_DAMAGE_MULT_PERMILLE`) is a fixed constant, not
 * stacked. `rollCrit` draws `combatPrng` once per fire (`WeaponFireSystem.spawnBullet`,
 * per pellet) or once per swing (`HitResolveSystem.meleeArc`, ONE roll covers every
 * target in that swing's arc) — but ONLY when `crit_chance > 0`, so a build/enemy that
 * can never crit never advances the stream (design/07's hard wall). Two independent
 * outcome changes: (1) `BUFF_DROP_POOL` grew from 3 to 4 entries, so `nextInt(4)`
 * instead of `nextInt(3)` at every buff-drop roll — any replay that ever rolled a buff
 * pickup diverges from that roll onward, even before any crit ever triggers; (2) any
 * build that actually holds `crit_up` now draws `combatPrng` on every fire/swing and
 * may deal bonus damage, diverging from the old (crit-less) outcome.
 *
 * v27: boss AI depth — `onDeathSpawn` and `enrage` (design/09's own aspirational
 * `EnemyBlueprint` fields, never built until now). `EnemyActor` gains `enrage?`/
 * `enraged`/`onDeathSpawn?`; `content/enemies.ts` gained the shared `buildEnemyActor`
 * factory (SpawnSystem and DeathDropsSystem now both call it, instead of each
 * hand-duplicating the full Actor field list — the exact bug class that dropped
 * `knockVx`/`knockVy` from a few test fixtures earlier in v25). The Blightlord boss
 * is the first (and so far only) blueprint to carry either trait: below 30% HP it
 * enrages (+50% damage, +50% fire rate, latched one-way, fx-only `enrage` event);
 * on death it spawns 2 `basic` adds ringed around its body, clamped into walkable
 * space. Both are strict no-ops for every OTHER enemy (neither field set) and for
 * any replay that never brings the Blightlord below that threshold — but any replay
 * that DOES diverges the instant enrage first latches or the boss dies, a real
 * gameplay change.
 *
 * v28: the first concrete batch of `k_*` on-hit procs (design/03/09 — "never
 * specified beyond a placeholder id prefix" until now) plus a real, adjacent bug
 * found while wiring them: `RangedSpec.piercing` had been authored since Stage C but
 * `toSimSpec` never converted it and `HitResolveSystem` never read it — a "piercing"
 * bullet behaved identically to a non-piercing one the whole time. All three (k_
 * lifesteal, k_ricochet, and piercing) now land, sharing one "what happens to a
 * bullet after it connects" decision point in `HitResolveSystem`'s main hit loop:
 * ricochet retargets first if it has bounces left (`retarget`, nearest OTHER hostile
 * within `RICOCHET_RANGE_FP`, preserving speed), else piercing keeps it flying
 * (remembering the hit id in the new `Projectile.hitIds` so a still-overlapping body
 * isn't hit twice), else it expires — the original default. `WeaponFireSystem` now
 * sets `ownerId` on EVERY bullet (previously orbit-only) so k_lifesteal can find who
 * to heal. Two new showcase weapons, `carom` (ricochet) and `leech` (lifesteal),
 * added to `WEAPON_DROP_POOL` (3rd outcome change: the pool's length changed, so
 * `nextInt(N)` at every weapon-drop roll shifts, independent of whether either new
 * weapon or proc ever actually triggers). Any replay that ever rolls a weapon drop,
 * or fires a `piercing`/`ricochetCount`/`lifestealPermille` weapon, diverges from its
 * old outcome.
 *
 * v29: a gameplay-design audit's fix batch (design/15 fairness wall + design/05's
 * open floor-scaling item). Three independent outcome changes:
 * (1) PvP arena floor pickups/drops now scale by `PVP_SCALE_FACTOR` on equip
 * (`PickupSystem.applyWeapon`), same as the landing kit (`balance/build.ts`) — before
 * this, picking up almost any arena floor weapon REPLACED a scaled kit weapon with an
 * unscaled one, inverting design/15's "the map's own loot is the real power curve."
 * Any zoneEnabled match where a player ever equips a floor weapon diverges from its
 * old (weaker) outcome.
 * (2) Arena `lootMarker`s no longer roll their contents at room-activation time —
 * `SpawnSystem.spawnArenaLoot` now spawns an unresolved `'crate'` pickup kind instead,
 * and `PickupSystem` rolls it (still off the same `dropPrng` stream) the first tick any
 * player comes within the new `SIM.lootRevealRadius`, instead of the tick its room
 * activates. Closes design/15's own "honest anti-cheat-limit" note: eager resolution
 * put every floor's exact loot identity in shared GameState (readable by a map-wide
 * state/free-camera cheat) long before a legitimate player could be near it. Any PvP
 * replay that ever activates a room with a `lootMarker` diverges — the roll still
 * happens, but on a different (later, player-gated) tick, and never at all if no
 * player ever comes within range.
 * (3) `WEAPON_DROP_POOL` gained two elemental frame-library siblings (`cinderscatter`,
 * `frostseeker`) — the pool's length changed, so `nextInt(N)` shifts at every
 * weapon-drop roll, same divergence shape as v28's own pool growth.
 * (4) `buildEnemyActor` now scales a dungeon enemy's `maxHp` by
 * `DungeonConfig.difficultyCurve` (`curveAt`, `world/dungeon.ts`) — authored on
 * `EMBER_DUNGEON` since ROADMAP 1.3 but never actually read until now (design/05's
 * "how enemy tier... escalate with depth" was still open). floorIndex 0 always
 * resolves to `curve.base` and every non-dungeon config has no `dungeonConfig` at all,
 * so this is byte-identical for floor 0 and every PvE/PvP config without floors — but
 * any dungeon replay that ever reaches floor 1+ diverges (tougher enemies, weapon
 * damage untouched). `BLUEPRINT_CATALOG` also grew substantially (design/14 follow-up)
 * but that catalog is meta-layer-only (client/src/meta, not the deterministic sim), so
 * it carries no replay/outcome divergence on its own.
 *
 * v30: PvP squads + gated revive (design/05/15's long-deferred squad follow-up,
 * finally scheduled). Four independent outcome changes:
 * (1) `buildPvpEngineConfig`/`Matchmaker` now assign `teamId` in squad-sized chunks
 * (`teamIdForOwner`, `@dd/game/pvpConfig`) instead of one distinct team per seat —
 * any zoneEnabled match whose `playerCount` divides evenly by `SQUAD_SIZE` (4) now
 * groups seats into shared-team squads; anything else (any seat count that doesn't
 * divide evenly, and all of PvE/co-op) is byte-identical to before.
 * (2) `WinConditionSystem.tickPlacement` computes elimination/placement per SQUAD
 * (every member `!alive`) instead of per player — diverges from v29 only where (1)
 * above actually changes teamId assignment.
 * (3) `ReviveSystem.hasReviver` now requires `reviver.teamId === downed.teamId` AND
 * `reviver.bandages > 0`, consuming one bandage on a successfully COMPLETED revive
 * (not on channel start). PvE co-op has no distinct teamIds (all players share the
 * implicit single team) so the teamId check is a no-op there — but the bandage check
 * is NOT: a PvE revive with `bandages` still at its default 0 would now be rejected
 * outright. Guarded off by `state.zoneEnabled` (see (4)) so PvE stays exactly the
 * free channel it always was; only a zoneEnabled (PvP) match enforces bandages.
 * (4) Downed players are no longer excluded from `hostileTargets` when
 * `state.zoneEnabled` (PvP) — they can be shot/meleed/AoE'd while down, unlike PvE's
 * standing invulnerability. Any PvP replay with a downed player now diverges the
 * instant an attack would have passed through them.
 * A new `{kind:'bandage'}` arena-only drop (`content/drops.ts`) also shifts
 * `ARENA_DROP_TABLE`'s roll weights — same divergence shape as any past drop-pool
 * growth (v28/v29's own weapon-pool entries).
 *
 * v31: in-run legibility pass (design/10, 2026-08-02). Three independent outcome
 * changes:
 * (1) `ExtractionSystem` no longer resolves the checkpoint from a hold-to-extract/
 * tap-to-descend INTERACT timer (`EXTRACT_HOLD_TICKS`, removed along with
 * `state.extractHoldTicks`) — it now resolves from explicit one-shot
 * `Button.CONFIRM_EXTRACT`/`CONFIRM_DESCEND` presses (a render-side portal + popup
 * replaces the old text prompt). Any replay that held/tapped INTERACT at a
 * checkpoint now does nothing instead — diverges the instant it would have resolved.
 * (2) `SpawnSystem.loadRoom` now clears `state.pickups` on every room-to-room
 * transition within a floor (previously only on floor-to-floor DESCEND) — an
 * uncollected drop from the room just left no longer persists into the next room.
 * (3) `EMBER_ROOMS` (content/world/rooms/ember.ts) gained perimeter walls with door
 * gaps on every piece (previously bare/near-empty `solids`) — existing dungeon
 * replays now collide with geometry that wasn't there before.
 *
 * v32: ground-weapon pickup is click-driven now, not INTERACT-driven (design/03,
 * reversing the v21 "tap INTERACT while overlapping" gesture — a render-side panel
 * listing every nearby weapon pickup replaces the single nearest-only ground compare
 * card). `PlayerCommand`/`PlayerActor` gain `pickupTargetId` (0 = none, else the
 * `PickupItem.id` the player clicked this tick — a one-shot value, same latch
 * convention as `CONFIRM_EXTRACT`/`CONFIRM_DESCEND`). `PickupSystem`'s weapon-kind
 * branch now collects when `pickupTargetId` matches an alive weapon item's id AND the
 * player is within `SIM.lootRevealRadius` (the wider "can see it" ring, not the tight
 * `SIM.pickupRadius` every other kind still uses) — INTERACT held/tapped next to a
 * weapon now does nothing. `PlayerActor.wasInteracting` (v21's rising-edge memory,
 * `PickupSystem`'s only reader) is removed as dead state. Any replay that collected a
 * ground weapon via INTERACT now leaves it uncollected — diverges the instant that
 * pickup would have resolved.
 *
 * v33: manual aim is removed entirely (design/10, reversed-then-reversed-again
 * 2026-08-03) — `PlayerCommand.aimBrad` and `state/input.ts`'s `quantizeAim` are
 * gone. `ApplyInputSystem` now sets `PlayerActor.facing` itself every tick: the
 * nearest hostile actor (unlimited range, same contract `nearestHostile` already
 * gives homing/deflect) if one exists, else the current movement direction, else
 * (idle, no target) last tick's facing is held, same as before. This also drives
 * melee's hit-arc (`HitResolveSystem.meleeArc` gates on `facing`), so melee swings
 * auto-face their target too. Any replay recorded before v33 has `aimBrad` values
 * that are now simply ignored — a manually-aimed shot that used to hit a target
 * off the auto-face line now diverges from the direction it fires.
 */
export const ENGINE_VERSION = 33;

// ── Two-pool health tuning (design/07; final values are 07 "to design") ──────────
// Whole ticks @30Hz. Shield regen is an idle timer, not a heal: after taking ANY
// damage an actor must stay unhit for DELAY ticks before shield refills +1 per
// INTERVAL, capped at maxShield. A DoT tick resets the timer (StatusEffectSystem),
// so clearing a lingering status is a precondition for regen.
export const SHIELD_REGEN_DELAY = 90; // ~3 s idle before regen starts
export const SHIELD_REGEN_INTERVAL = 300; // ~10 s per +1 shield thereafter

// ── Knockback friction (design/07, v25) ───────────────────────────────────────────
// knockVx/knockVy decay by this per-mille factor every tick (MovementSystem), so a
// shove fades out instead of persisting or drifting forever. 800 = keep 80%/tick —
// a saber swing's 198 fp/tick impulse falls under KNOCKBACK_SNAP_FP within ~20 ticks
// (~0.7s), covering roughly 1 grid unit of total slide. First-pass, tune against real
// play like every other number in this section.
export const KNOCKBACK_FRICTION_PERMILLE = 800;
export const KNOCKBACK_SNAP_FP = 5; // below this magnitude (either axis), snap to exactly 0

// ── k_* on-hit procs (design/03/09, v28) ──────────────────────────────────────────
// How far a ricochet may retarget from its current position — same "reasonable
// nearby range" idea as content/damage.ts's CHAIN_RANGE, kept separate since the two
// are semantically distinct knobs (a lightning chain's hop vs a ricochet's bounce).
// Computed inline (not via content/convert.ts's toFpGrid) to avoid a circular import
// — convert.ts itself imports WORLD from this file.
export const RICOCHET_RANGE_FP = Math.round(6 * FP_SCALE) as Fp;

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
