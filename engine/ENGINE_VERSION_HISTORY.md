# ENGINE_VERSION replay-compatibility changelog

`ENGINE_VERSION` (`engine/versionHistory.ts`) guards replay compatibility —
see `design/08`. This file is the full per-bump history; it lives as Markdown,
not a TypeScript doc-comment, because it's pure prose with zero code (CLAUDE.md
"500-line file convention": a growing changelog isn't a code-organization
problem the split-priority list addresses, it's a documentation-placement one —
putting ~500 lines of prose inside a `.ts` comment just to attach it to one
constant was the actual mistake, not the file being long).

design/08: `ReplayInputSource` refuses a mismatched version — fail loud, never
replay garbage. Bump this whenever a change to the deterministic core could make
an old recorded input stream diverge (system reorder, fp/brad/table change, new
PRNG draw site).

v2 (Stage C): spatial unit switched from px-as-fp to real grid (1 grid = 32 px)
and weapon/actor numbers moved to the content catalog, so every stored fp
position/velocity and weapon value differs from v1 — a v1 input stream would
diverge immediately.

v3 (Stage D): the player carries a two-slot loadout and SWAP_WEAPON toggles the
active slot instead of replacing the weapon with a fresh one — a switch now
preserves each slot's cooldown, so a v2 stream that swaps would diverge.

v4 (Stage F): the roguelite loop. Enemy deaths roll the full DROP_TABLE
(coin/health/affix/weapon) instead of a health-or-coin coin-flip — a different
(and branch-variable) number of dropPrng draws per kill — and pickups now mutate
the loadout (affix stack re-resolves weapon specs; weapon drops swap a slot). Any
v3 stream that swaps would diverge at the first kill.

v5: static round solids (pillars) now collide. MovementSystem pushes actors out
of the EngineConfig obstacle circles (by the actor's feet `footprintRadius`, not
the body radius) each tick, and ProjectileStepSystem expires a bullet that
reaches a solid. Any v4 stream that walked an actor into — or fired a bullet
through — a pillar diverges (both used to pass through).

v6: block/jump rework. Parry is no longer a held state — a melee swing deflects
enemy bullets caught in its arc (DeflectSystem keys off justSwung + the swing's
arc, not a BLOCK button / blockArc). Jump is removed: no z/gravity integration,
no JUMP button, actors are strictly 2D. The command bitfield and the serialized
state shape both changed, so any v5 stream diverges.

v7: opposing-faction bullets collide. HitResolveSystem now cancels an overlapping
player/enemy bullet pair (mutual destruction) before the actor-hit loop, so a
v6 stream where two enemy/player bullets crossed paths — previously ghosting
through each other, now both expiring — diverges.

v8: elemental damage types + status effects (design/03/07). Weapons/bullets carry
a DamageType; HitResolve applies per-type resist and an on-hit status (fire→burn
DoT, ice→chill slow, poison→stacks, lightning→chain to a neighbour), and a new
StatusEffectSystem ticks the lingering DoT/chill between hit-resolution (7) and
death (now 9). The step order gained a system and actors/bullets gained fields, so
any v7 stream diverges the first time a hit lands or an element ticks.

v9: element-adding affixes (`elem_*` → set_element kind, overrides a weapon's
damageType) enlarge the AFFIX_DROP_POOL, shifting every dropPrng affix roll; and
applyResist now ROUNDS a weakness (mult>1000) instead of truncating, so a low-base
hit into a weakness lands harder. Either alone diverges a v8 stream.

v10: the affix system is removed (design pivot 03/09/14 — Frame × Element, no
affixes). The DROP_TABLE no longer has an `affix` entry, so weightedIndex draws a
different kind per kill, and a weapon drop no longer re-applies an affix stack. Any
v9 stream diverges at the first enemy death.

v11: run buffs — the in-run power layer that replaces affixes (design/05/14). The
DROP_TABLE gains a `buff` entry, so weightedIndex draws a different kind per kill
(diverges a v10 stream at the first drop), and a picked-up buff scales the player's
damage / attack-speed (WeaponFire, HitResolve) and max HP (Σ-then-clamp). Enemies
carry no buffs (identity), so their fire is unchanged. (Intrinsic rarity, ROADMAP
0.2, shipped between v10 and here WITHOUT a bump — additive, damage byte-identical.)

v12: two-pool health (design/02/05/07). Actors gain shield/maxShield/ticksSinceHit;
all damage (direct hit, chain, DoT) routes through a shared shield-first `takeDamage`
and StatusEffectSystem grows an idle shield-regen sub-pass. A shielded actor now
soaks damage differently and its ticksSinceHit advances every tick, so any v11
stream where the player (maxShield > 0) takes a hit — or simply idles — diverges.

v13: characters = SkinDef (design/02/09/14). The player's (maxHp, maxShield) now
come from a chosen SkinDef and it carries a shield-break passive: when its shield
empties, takeDamage fires the passive (default 'vanguard' bursts AoE damage to
nearby enemies). The default character's break now damages enemies where v12 did
nothing, so any v12 stream where the player's shield breaks diverges.

v14: pickup taxonomy → design/09 names (heal/material/weapon/buff). The old `coin`
becomes `material` and now draws an extra dropPrng roll to pick its element from
MATERIAL_DROP_POOL (a distinct carry-out currency), so the drop stream diverges from
v13 at the first material drop. (`health`→`heal` is a rename with no behaviour change.)

v15: frame library beyond `straight` (design/03/09 Frame axis, ROADMAP 1.1).
WeaponFireSystem now fires `bullets` pellets per trigger, jittering each within
±spreadHalf via a NEW combatPrng draw site (a spread weapon's cone is randomized;
single-pellet weapons still draw nothing). Four new ballistics — homing (turns
toward the nearest foe), lob (AoE blast on landing instead of a silent despawn),
beam (hitscan line, damage on a beamTickInterval cadence, doesn't move or clash),
boomerang (velocity reverses mid-flight) — replace `straight`'s `pos += vel` for
any bullet whose spec names them; existing `straight` weapons are byte-identical.
The WEAPON_DROP_POOL grew (scattergun/seeker/mortar/lasercutter/tomahawk/hammer/
spear), shifting every dropPrng weapon-id roll. Any v14 stream diverges the first
time a spread/homing/lob/beam/boomerang shot fires, or at the first weapon drop.

(RoomState collision geometry, ROADMAP 1.2, shipped between v15 and here WITHOUT
a bump — additive, like intrinsic rarity in v11's note. `state.walls: AABB[]`
is a NEW GameState array, and MovementSystem/ProjectileStepSystem gained a wall-
resolution pass, but every existing EngineConfig omits `walls` — so state.walls
stays empty and the new code paths are no-ops. No pre-1.2 replay is affected.)

(Seeded dungeon assembly — GENERATION ONLY, ROADMAP 1.3 — also shipped without a
bump: `state.roomgenPrng` is a new, never-yet-read PRNG stream, and
`world/dungeon.ts generateFloor` is pure and unwired into GameEngine.step().)

(Dungeon mode WIRED LIVE, ROADMAP 1.3 — ALSO no bump: EngineConfig gained an optional
`dungeon` field. When present, SpawnSystem drives spawns from a generated room
sequence (drawing roomgenPrng), swaps `state.walls`/`obstacles` + `worldW`/`worldH`
per room via `roomGeometry`, and ExtractionSystem's descend generates the next floor
instead of loading a flat wave list; `floorsEnabled` is now true for a `dungeon`
config too. Every config that omits `dungeon` (every config before this) never draws
roomgenPrng, never mutates walls/obstacles/world bounds, and keeps `roomIndex` at -1 —
byte-identical, no observable change. `worldW`/`worldH` and the walls/obstacles arrays
became mutable-in-dungeon-mode, but a non-dungeon config sets them once and never
again, exactly as when they were `readonly`.)

(Extraction rooms + materials carry-out, ROADMAP 1.4/1.5, ALSO shipped without a
bump: EngineConfig gained an optional `floors` field and GameState gained
`floorIndex`/`floorMaterials`/`bankedMaterials`/`extractHoldTicks` +
`floorsEnabled` (= `config.floors !== undefined`) + a 13th step, ExtractionSystem,
inserted between Spawns and WinCondition. ExtractionSystem is a hard no-op unless
`floorsEnabled`; WinConditionSystem's altered branch is gated the same way. Every
config that omits `floors` (every config before this feature existed) is
completely untouched. `PickupSystem` now always tracks a collected material into
`state.floorMaterials` regardless of `floorsEnabled` — this is new bookkeeping,
not new BEHAVIOR: nothing reads that map unless `floorsEnabled`, so it changes no
observable outcome for an old config. `rollDrop` gained an optional `tier` param
(default 0, identical to the old call) so `DeathDropsSystem` can pass
`state.floorIndex` as the material's depth signal.)

(v15→16 — orbit ballistic + radial emission, ROADMAP 1.1 tier-4 follow-up: the last
two frame-library shapes. `BallisticId` gained 'orbit' (a projectile that circles its
owner — new Projectile `ownerId`/`orbitRadius`/`orbitAngleBrad`/`orbitAngularVelBrad`
fields + an orbit branch in ProjectileStepSystem); `RangedSimSpec` gained a required
`pattern` ('spread' | 'radial') driving WeaponFireSystem's emission layout — 'spread'
is the byte-identical default every prior weapon converts to. Why this bumps: two
showcase weapons (novaburst/gyre) join WEAPON_DROP_POOL, shifting the dropPrng
weapon-id roll — same precedent as the 1.1 frame weapons.)

(v16→17 — co-op downed/revive, ROADMAP 3.2: a lethal hit now sends a player `downed`
(frozen, 0 HP, `alive` stays true) instead of dead — DeathDropsSystem sets it, a new
ReviveSystem (step 13) runs the bleedout timer + a teammate's sustained-INTERACT revive
channel, and WinConditionSystem ends a run when no player is "up" (`alive && !downed`).
PlayerActor gained `downed`/`bleedoutTicks`/`reviveProgressTicks` (serialized). Why this
bumps even though single-player outcomes are unchanged: the player-death representation
changed (downed vs alive=false, a 'downed' event instead of the immediate 'death'), so
replay bytes move. Downed players are invulnerable and untargetable — HitResolve/AIDecide/
ProjectileStep/StatusEffect skip them via isDowned.)

v18: team/hostility model (design/15, ROADMAP 4.2a — PvP prerequisite #1). Every
`Actor`/`Projectile` gains a `teamId: number`, independent of `faction` — a NEW axis,
since `faction` only ever answered "player-controlled or AI" and combat code used it
as a stand-in for "who's on my side" by hardcoding a 2-array split. A shared
`isHostile(a,b) = a.teamId !== b.teamId` predicate (state/entities.ts) plus
`hostileTargets`/`nearestHostile` (new systems/targeting.ts) replace every
`faction === 'player' ? state.enemies : state.players`-shaped ternary in
HitResolveSystem, DeflectSystem, ProjectileStepSystem, and combat.ts. Enemies get the
reserved `ENEMY_TEAM_ID` (-1); every player seat defaults to a SHARED team 0
(`PlayerConfig.teamId ?? 0`, `GameState.buildSeat`) unless a config assigns each seat
its own — so every existing single-player and co-op config keeps allies non-hostile,
byte-identical in the SET of (bullet, target) pairs tested. Why this still bumps
despite that: (1) bullets can now hit ANY hostile actor rather than "the other array" —
a rival player's bullet/melee/deflect now reaches another player once a config assigns
distinct teamIds (PvP, not yet built, but the capability itself is new code on the hot
path); (2) two INCIDENTAL corrections ride along, closing latent gaps the old
2-faction ternaries had: `resolveBulletClash` used to skip same-`faction` bullets
(so two hypothetically-hostile players' bullets, both 'player'-faction, would never have
clashed) — now gated on `isHostile`, matching intent; and the lightning chain's
candidate pool (and the lob/beam blast pool) now flow through the shared
`hostileTargets`, which excludes downed players — previously chain's `group` was a raw
`state.players` array that `chain()` only filtered by `alive`, so a downed teammate
could technically still be chained to, inconsistent with 3.2's "downed = invulnerable."
Both are correctness fixes, not intentional design changes, but either could move an
old replay's bytes at the exact tick it would have mattered. Single-player and existing
co-op are unaffected in every practical scenario; the guard is there because "provably
safe for the default case" is not the same promise as "provably safe for every old
recorded replay," and design/08's rule is to fail loud rather than risk the latter.

v19: anti-cheat `integrityPrng` (design/15, ROADMAP 4.4) + closing a hash-coverage
gap left by v18's zone/placement work (4.2d/4.2e). `GameState` gains a new seeded
stream drawn once per tick, unconditionally, in `GameEngine.step` — NEVER read by
any gameplay system (see its doc comment), so no outcome for any config/mode
changes. `serializeState` (replay.ts) now also hashes `ringPrng`/`integrityPrng`'s
cursors and `state.zone`/`state.placements` directly (previously a zone-state
divergence would only surface indirectly, once it produced different damage) —
both null/empty and stable for every non-arena config. Bumps because
`hashState()`'s output value moves for every tick of every replay — the "state
shape gained a field, so replay bytes move" precedent v17 (downed/revive) already
established as sufficient on its own, even with zero gameplay effect for existing
modes.

v20: `buildArenaSpecs` wired into `GameState.buildSeat` (design/15, ROADMAP 4.2c —
the last unwired PvP-prerequisite piece). When `config.arena` is set, a seat's
weapons/`maxHp`/`maxShield` now come from `buildArenaSpecs(config.arenaPreset ??
'landing_basic', seat.skinId)` — the landing-kit loadout + `PVP_SCALE_FACTOR`-scaled
body stats — instead of the PvE run-builder path (`seat.loadout` via
`WEAPON_SIM_BY_ID` + the character's plain `SkinDef` numbers). `seat.loadout` is now
structurally never read for an arena seat (the fairness wall enforced at
construction, not just by convention). Bumps because this is a REAL, intentional
gameplay-affecting change to every arena-mode config's player numbers (HP/damage,
not just hash bookkeeping) — every config that omits `arena` (every PvE/co-op config)
is completely untouched, byte-identical.

v21: `PickupSystem`'s weapon-kind branch now matches design/03:121-126 ("weapons
are NOT auto-picked-up... button-driven") instead of auto-swapping on mere overlap
like every other pickup kind — it now requires a freshly-pressed INTERACT (rising
edge) while overlapping, and drops the outgoing weapon back onto the floor as a
new pickup. `PlayerActor` gained `wasInteracting` (PickupSystem's own cross-tick
edge memory — `prevButtons` can't serve this: ApplyInputSystem already overwrites
it with the CURRENT tick's bitfield before PickupSystem's step runs). Bumps because
a replay recorded under v20 that picked up a weapon via overlap alone, with no
INTERACT held, replays differently under this rule — a real outcome change for
identical commands, not additive.

v22: actor–actor collision (design/07 step 4.3 — the one "still deferred" half of
movement/collision; every actor↔solid case had already shipped). `MovementSystem`
gains `resolveActorPairs`: every overlapping pair among ALL alive actors (players
AND enemies, not gated by faction — "same-plane pair" in the design doc), resolved
in a fixed ascending-id-ordered sequence, gets pushed apart along their centre
line by half the penetration each (footprint circles, same radius convention as
the existing solid-push code). Actors that used to freely overlap (two players
standing on each other, an enemy walking into another enemy, a player pushing
through a mob) now physically separate every tick they're close enough to
overlap — any replay where any two actors ever got that close diverges the first
tick it happens, even though no new PRNG draw or state field is involved.

v23: enemy-enemy collision exception (design/07 "Open questions" — enemies lean
overlap rather than block, per the doc's own recommendation). `resolveActorPairs`
now skips a pair where BOTH actors are `faction === 'enemy'` before the push-apart
math runs; player-vs-player and player-vs-enemy pairs are unchanged, still pushed
apart unconditionally. Any replay where two enemies got close enough to overlap
under v22 diverges under v23 (they no longer separate) — a real outcome change,
even though no new PRNG draw or state field is involved.

v24: drop/pickup spawn points are clamped into walkable space (`geom.ts`
`clampToWalkable`, no new PRNG draw — pure geometry against the existing
`state.walls`/`obstacles`/world bounds). A dead enemy's own position could be
on/behind a wall (a knockback shove, or a big footprint dying flush against
geometry), and arena loot markers / a swapped-out weapon's drop-back point were
never checked at all — any of those could previously spawn a pickup somewhere
the player couldn't reach. `DeathDropsSystem`, `PickupSystem.applyWeapon`, and
`SpawnSystem.spawnArenaLoot` now all push the computed point out of any
overlapping wall/obstacle and clamp it inside the world bounds before creating
the `PickupItem`. Any replay where a drop's pre-clamp point was already outside
that margin diverges (the pickup now sits at a different, walkable position).

v25: knockback is real (design/07 "persistent-knockback friction", the one
remaining gap the doc's own "to design" list named). Two independent gaps closed
together since both live in the same knockVx/knockVy channel: (1) melee
`knockback` (grid/s, authored on every `MeleeSpec` since Stage C) was authored but
never converted by `toSimSpec` NOR applied by `HitResolveSystem` — a swing's shove
was pure flavour text until now; (2) the shield-break `knock` passive wrote its
impulse directly into `vx`/`vy`, which is broken for BOTH factions: a player's
vx/vy is fully overwritten every tick by `ApplyInputSystem` from input (the impulse
would be erased before `MovementSystem` ever integrated it), and an enemy's vx/vy
is never touched by AI at all (so once knocked it would drift at that exact velocity
forever, with no decay — the literal missing "friction" design/07 flagged). Actor
gained `knockVx`/`knockVy`, a channel independent of vx/vy: `MovementSystem.integrate`
adds it into this tick's displacement alongside vx/vy (unaffected by chill slow — a
shove is an external force, not the actor's own movement speed), then decays it by
`KNOCKBACK_FRICTION_PERMILLE` every tick, snapping to exactly 0 below
`KNOCKBACK_SNAP_FP` so it doesn't drift as a sub-pixel residual forever. Any replay
that ever triggers a `knock` shield-break passive or connects a melee swing with
nonzero `knockback` (saber/hammer/emberblade/frostbrand/stormglaive/spear all carry
one) diverges from its old (no-op) outcome — a real gameplay change, not additive.

v26: the `crit` run-buff family is real (`balance/runbuffs.ts` — the roadmap's own
"needs a hit-time PRNG draw" deferral for this one family, now built). `RunBuffKind`
gains `crit_chance` (Σ-clamp, same shape as the other three) + a new `crit_up`
pickup; the multiplier itself (`CRIT_DAMAGE_MULT_PERMILLE`) is a fixed constant, not
stacked. `rollCrit` draws `combatPrng` once per fire (`WeaponFireSystem.spawnBullet`,
per pellet) or once per swing (`HitResolveSystem.meleeArc`, ONE roll covers every
target in that swing's arc) — but ONLY when `crit_chance > 0`, so a build/enemy that
can never crit never advances the stream (design/07's hard wall). Two independent
outcome changes: (1) `BUFF_DROP_POOL` grew from 3 to 4 entries, so `nextInt(4)`
instead of `nextInt(3)` at every buff-drop roll — any replay that ever rolled a buff
pickup diverges from that roll onward, even before any crit ever triggers; (2) any
build that actually holds `crit_up` now draws `combatPrng` on every fire/swing and
may deal bonus damage, diverging from the old (crit-less) outcome.

v27: boss AI depth — `onDeathSpawn` and `enrage` (design/09's own aspirational
`EnemyBlueprint` fields, never built until now). `EnemyActor` gains `enrage?`/
`enraged`/`onDeathSpawn?`; `content/enemies.ts` gained the shared `buildEnemyActor`
factory (SpawnSystem and DeathDropsSystem now both call it, instead of each
hand-duplicating the full Actor field list — the exact bug class that dropped
`knockVx`/`knockVy` from a few test fixtures earlier in v25). The Blightlord boss
is the first (and so far only) blueprint to carry either trait: below 30% HP it
enrages (+50% damage, +50% fire rate, latched one-way, fx-only `enrage` event);
on death it spawns 2 `basic` adds ringed around its body, clamped into walkable
space. Both are strict no-ops for every OTHER enemy (neither field set) and for
any replay that never brings the Blightlord below that threshold — but any replay
that DOES diverges the instant enrage first latches or the boss dies, a real
gameplay change.

v28: the first concrete batch of `k_*` on-hit procs (design/03/09 — "never
specified beyond a placeholder id prefix" until now) plus a real, adjacent bug
found while wiring them: `RangedSpec.piercing` had been authored since Stage C but
`toSimSpec` never converted it and `HitResolveSystem` never read it — a "piercing"
bullet behaved identically to a non-piercing one the whole time. All three (k_
lifesteal, k_ricochet, and piercing) now land, sharing one "what happens to a
bullet after it connects" decision point in `HitResolveSystem`'s main hit loop:
ricochet retargets first if it has bounces left (`retarget`, nearest OTHER hostile
within `RICOCHET_RANGE_FP`, preserving speed), else piercing keeps it flying
(remembering the hit id in the new `Projectile.hitIds` so a still-overlapping body
isn't hit twice), else it expires — the original default. `WeaponFireSystem` now
sets `ownerId` on EVERY bullet (previously orbit-only) so k_lifesteal can find who
to heal. Two new showcase weapons, `carom` (ricochet) and `leech` (lifesteal),
added to `WEAPON_DROP_POOL` (3rd outcome change: the pool's length changed, so
`nextInt(N)` at every weapon-drop roll shifts, independent of whether either new
weapon or proc ever actually triggers). Any replay that ever rolls a weapon drop,
or fires a `piercing`/`ricochetCount`/`lifestealPermille` weapon, diverges from its
old outcome.

v29: a gameplay-design audit's fix batch (design/15 fairness wall + design/05's
open floor-scaling item). Three independent outcome changes:
(1) PvP arena floor pickups/drops now scale by `PVP_SCALE_FACTOR` on equip
(`PickupSystem.applyWeapon`), same as the landing kit (`balance/build.ts`) — before
this, picking up almost any arena floor weapon REPLACED a scaled kit weapon with an
unscaled one, inverting design/15's "the map's own loot is the real power curve."
Any zoneEnabled match where a player ever equips a floor weapon diverges from its
old (weaker) outcome.
(2) Arena `lootMarker`s no longer roll their contents at room-activation time —
`SpawnSystem.spawnArenaLoot` now spawns an unresolved `'crate'` pickup kind instead,
and `PickupSystem` rolls it (still off the same `dropPrng` stream) the first tick any
player comes within the new `SIM.lootRevealRadius`, instead of the tick its room
activates. Closes design/15's own "honest anti-cheat-limit" note: eager resolution
put every floor's exact loot identity in shared GameState (readable by a map-wide
state/free-camera cheat) long before a legitimate player could be near it. Any PvP
replay that ever activates a room with a `lootMarker` diverges — the roll still
happens, but on a different (later, player-gated) tick, and never at all if no
player ever comes within range.
(3) `WEAPON_DROP_POOL` gained two elemental frame-library siblings (`cinderscatter`,
`frostseeker`) — the pool's length changed, so `nextInt(N)` shifts at every
weapon-drop roll, same divergence shape as v28's own pool growth.
(4) `buildEnemyActor` now scales a dungeon enemy's `maxHp` by
`DungeonConfig.difficultyCurve` (`curveAt`, `world/dungeon.ts`) — authored on
`EMBER_DUNGEON` since ROADMAP 1.3 but never actually read until now (design/05's
"how enemy tier... escalate with depth" was still open). floorIndex 0 always
resolves to `curve.base` and every non-dungeon config has no `dungeonConfig` at all,
so this is byte-identical for floor 0 and every PvE/PvP config without floors — but
any dungeon replay that ever reaches floor 1+ diverges (tougher enemies, weapon
damage untouched). `BLUEPRINT_CATALOG` also grew substantially (design/14 follow-up)
but that catalog is meta-layer-only (client/src/meta, not the deterministic sim), so
it carries no replay/outcome divergence on its own.

v30: PvP squads + gated revive (design/05/15's long-deferred squad follow-up,
finally scheduled). Four independent outcome changes:
(1) `buildPvpEngineConfig`/`Matchmaker` now assign `teamId` in squad-sized chunks
(`teamIdForOwner`, `@dd/game/pvpConfig`) instead of one distinct team per seat —
any zoneEnabled match whose `playerCount` divides evenly by `SQUAD_SIZE` (4) now
groups seats into shared-team squads; anything else (any seat count that doesn't
divide evenly, and all of PvE/co-op) is byte-identical to before.
(2) `WinConditionSystem.tickPlacement` computes elimination/placement per SQUAD
(every member `!alive`) instead of per player — diverges from v29 only where (1)
above actually changes teamId assignment.
(3) `ReviveSystem.hasReviver` now requires `reviver.teamId === downed.teamId` AND
`reviver.bandages > 0`, consuming one bandage on a successfully COMPLETED revive
(not on channel start). PvE co-op has no distinct teamIds (all players share the
implicit single team) so the teamId check is a no-op there — but the bandage check
is NOT: a PvE revive with `bandages` still at its default 0 would now be rejected
outright. Guarded off by `state.zoneEnabled` (see (4)) so PvE stays exactly the
free channel it always was; only a zoneEnabled (PvP) match enforces bandages.
(4) Downed players are no longer excluded from `hostileTargets` when
`state.zoneEnabled` (PvP) — they can be shot/meleed/AoE'd while down, unlike PvE's
standing invulnerability. Any PvP replay with a downed player now diverges the
instant an attack would have passed through them.
A new `{kind:'bandage'}` arena-only drop (`content/drops.ts`) also shifts
`ARENA_DROP_TABLE`'s roll weights — same divergence shape as any past drop-pool
growth (v28/v29's own weapon-pool entries).

v31: in-run legibility pass (design/10, 2026-08-02). Three independent outcome
changes:
(1) `ExtractionSystem` no longer resolves the checkpoint from a hold-to-extract/
tap-to-descend INTERACT timer (`EXTRACT_HOLD_TICKS`, removed along with
`state.extractHoldTicks`) — it now resolves from explicit one-shot
`Button.CONFIRM_EXTRACT`/`CONFIRM_DESCEND` presses (a render-side portal + popup
replaces the old text prompt). Any replay that held/tapped INTERACT at a
checkpoint now does nothing instead — diverges the instant it would have resolved.
(2) `SpawnSystem.loadRoom` now clears `state.pickups` on every room-to-room
transition within a floor (previously only on floor-to-floor DESCEND) — an
uncollected drop from the room just left no longer persists into the next room.
(3) `EMBER_ROOMS` (content/world/rooms/ember.ts) gained perimeter walls with door
gaps on every piece (previously bare/near-empty `solids`) — existing dungeon
replays now collide with geometry that wasn't there before.

v32: ground-weapon pickup is click-driven now, not INTERACT-driven (design/03,
reversing the v21 "tap INTERACT while overlapping" gesture — a render-side panel
listing every nearby weapon pickup replaces the single nearest-only ground compare
card). `PlayerCommand`/`PlayerActor` gain `pickupTargetId` (0 = none, else the
`PickupItem.id` the player clicked this tick — a one-shot value, same latch
convention as `CONFIRM_EXTRACT`/`CONFIRM_DESCEND`). `PickupSystem`'s weapon-kind
branch now collects when `pickupTargetId` matches an alive weapon item's id AND the
player is within `SIM.lootRevealRadius` (the wider "can see it" ring, not the tight
`SIM.pickupRadius` every other kind still uses) — INTERACT held/tapped next to a
weapon now does nothing. `PlayerActor.wasInteracting` (v21's rising-edge memory,
`PickupSystem`'s only reader) is removed as dead state. Any replay that collected a
ground weapon via INTERACT now leaves it uncollected — diverges the instant that
pickup would have resolved.

v33: manual aim is removed entirely (design/10, reversed-then-reversed-again
2026-08-03) — `PlayerCommand.aimBrad` and `state/input.ts`'s `quantizeAim` are
gone. `ApplyInputSystem` now sets `PlayerActor.facing` itself every tick: the
nearest hostile actor (unlimited range, same contract `nearestHostile` already
gives homing/deflect) if one exists, else the current movement direction, else
(idle, no target) last tick's facing is held, same as before. This also drives
melee's hit-arc (`HitResolveSystem.meleeArc` gates on `facing`), so melee swings
auto-face their target too. Any replay recorded before v33 has `aimBrad` values
that are now simply ignored — a manually-aimed shot that used to hit a target
off the auto-face line now diverges from the direction it fires.

v34: PvE dungeon floors become co-resident (design/05 "Room & door model",
2026-08-04) — every room of a floor is placed and stitched into `GameState` at
once (matching PvP's `ArenaMap` shape), replacing the old one-room-at-a-time swap.
A `dungeonEnabled` config has no way to opt into "old" vs "new" behavior, so this
bundles five independent, atomic outcome changes:
(1) Co-residency itself: `state.roomIndex`/`roomTick`/`roomSchedule`/
`roomSpawnCursor`/`floorStages`/`floorLayout` are gone, replaced by
`dungeonRooms`/`dungeonDoors`/`dungeonRoomRuntime`/`dungeonRoomRects`/
`dungeonRoomIndexById`/`dungeonBaseWalls`. A room no longer auto-teleports the
player on clear — every room is live from floor-generation, connected by real,
freely-positioned (never wall-centered) doors a player must actually walk
through; backtracking within a floor is free. Any replay that relied on the old
auto-advance diverges the instant the first room would have swapped.
(2) `world/dungeon.ts generateFloor` drops its `stages`/candidate-list shape
(`FloorLayout.rooms` is now the only, already-resolved sequence); a
`layout:'branching'` config resolves its extra candidate via ONE MORE
`roomgenPrng.nextInt` draw at generation time, not player facing at "the moment
of arrival" (that moment no longer exists once every room pre-exists) — a
branching replay now draws one extra value per normal stage and diverges from
that draw onward. A `layout:'linear'` config's draw sequence is unaffected
(branchFactor stays 1, the extra draw never happens) — byte-identical.
(3) `world/rooms/ember.ts perimeterWalls()` no longer carves a centered door gap
on the edges a piece names in `exits` — it always emits one full, uncut wall per
edge. All door gaps are now cut generically at placement time
(`world/dungeon.ts carveDoorGaps`), at a drawn, non-centered anchor. Every
existing Ember dungeon replay's wall geometry differs the instant a room with a
previously-centered gap is stitched in.
(4) `AIDecideSystem` gains a room-activation gate (`state.dungeonEnabled` only):
an enemy whose room hasn't activated (no player has ever reached it) runs no
face/fire decision at all, leaving `firing` inert. Previously every enemy decided
unconditionally regardless of any player's location. `EnvironmentSystem`'s
`roomId`-tracking half is generalized to run for dungeon mode too (previously
PvP-only), which is what makes this gate possible.
(5) New `DoorSystem` (step 11.5, PvE dungeon only): a room's doors lock as a unit
— added back into `state.walls` as a real blocking rect — for as long as it has
any live enemy, and unlock permanently once cleared (nothing ever respawns into
an already-cleared room). The instant a room's live-enemy count rises from zero,
every OTHER online, non-downed player is teleported instantly onto its entrance
(not walked) — a new, unconditional interrupt source for anything a hard-
interrupted player was mid-doing (e.g. resets an in-progress `ReviveSystem`
channel via that system's own unmodified per-tick distance check — no bespoke
code needed there). `ExtractionSystem`'s dungeon-mode branch no longer reads
`state.wavesExhausted` (never set in dungeon mode anymore) — the checkpoint is a
direct check against the floor's capstone room: `activated && !hasLiveEnemy`.

v35: fully-realized branching (design/05, 2026-08-05 — the "Room & door model"
follow-up v34 itself named as deferred). `layout:'branching'` no longer resolves
a stage's room via a second `roomgenPrng.nextInt(branchFactor)` draw per stage
that just perturbed the linear pick by a wraparound offset into the same pool —
a floor now gets at most ONE real fork-and-reconverge diamond: real, distinct,
same-width sibling `PlacedRoom`s placed side-by-side, each with its own door, a
real walk-through-the-door choice, reconverging into the next stage's room.
`world/dungeon.ts generateFloor`'s draw sequence for `'branching'` changes
shape accordingly — ONE `nextInt` to pick which interior normal-stage
transition forks (never stage 0), then per stage the SAME single
`nextInt(pool.length)` a `'linear'` config already draws, plus, only at the
chosen fork stage, up to `branchFactor - 1` further draws for the extra
siblings. `FloorLayout.rooms` (flattened, one piece per stage) stays for
back-compat callers; the new `stages: readonly FloorStage[]` field (`RoomPiece
| readonly RoomPiece[]`) is what `placeFloor` now consumes. No shipped content
uses `'branching'` yet (`EMBER_DUNGEON` is `'linear'`, untouched, byte-
identical), so no real replay breaks — this bumps purely because the module's
own documented draw-sequence contract for `'branching'` changed again, same
precedent v34's own point (2) already established for this exact layout.

v36: two Room & door model bug fixes (design/05), both found from a live
player report — "cleared the room, door is unlocked, still can't walk
through it" — rather than by inspection. Both are real replay-affecting
changes for `EMBER_DUNGEON` (shipped `'graph2d'` since v35's same-day
follow-up), so this is a genuine simulation-output bump, not a docs-only one.
(1) `DeathDropsSystem`'s `onDeathSpawn` boss-adds never inherited the dying
boss's own `roomId` — unlike `SpawnSystem.dispatchDungeonSpawns`'s existing
"set roomId DIRECTLY, same tick" fix for the identical class of bug. `DoorSystem`'s
`hasLiveEnemy` scan (step 11.5, same tick) skips any enemy with `roomId===undefined`,
so a boss room's door would briefly unlock the instant the boss died, then
re-lock (and force-regroup the player straight back) the very next tick once
`EnvironmentSystem` caught up and tagged the new minions — a real, if narrow,
"door opens, then slams shut and yanks you back" window. Fixed: the minion
now inherits `e.roomId` at the moment it's spawned, same tick, same as the
wave-spawn path. (2) `placeFloorGraph2d`'s 'north'/'west' hops off the spawn
room (pinned at the origin) could place the next room at a NEGATIVE offset.
`buildFloorGeometry`'s `worldW`/`worldH` is a running max seeded at 0 (blind
to negative extents) and `MovementSystem.clampToWorld` hard-clamps to
`[margin, worldW - margin]` with no bound below 0 — so a player could never
physically reach (or fully cross into) a negative-offset room, even though
its door had correctly unlocked. Fixed: `placeFloorGraph2d` now shifts the
WHOLE floor by the same delta so the minimum offset on each axis lands at
exactly 0 — a pure translation, so every relative adjacency it already
computed is unaffected, only the shared origin moves. `'linear'`/`'branching'`
(`placeFloor`) only ever walk west→east (+ south-only hub forks) and so never
produce a negative offset — a deliberate no-op for them, never even reached.

v37: enemies actually move (design/09), fixing a live player report — "the AI
doesn't move, it just stands there and shoots". `AIDecideSystem` was true to its
own doc comment ("Enemies are stationary in the slice, so no move intent is
produced") since Stage B: every enemy/boss turned to face the nearest player and
fired, but no system ever wrote a non-zero `vx`/`vy` into an enemy, so
`MovementSystem`'s per-enemy `integrate()` was a correct no-op the whole time —
not a `MovementSystem` bug, an `AIDecideSystem` gap. Fixed: `AIDecideSystem.chase()`
now closes the distance toward the target in a straight line (facing computation
unchanged) until within `EnemyActor.engageRangeFp`, then stops so the mob actually
uses its gun instead of camping wherever it spawned. `moveSpeedPerTick`/
`engageRangeFp` are new optional `EnemyBlueprint`/`EnemyActor` fields (`content/
enemies.ts`'s `buildEnemyActor`, same "copied from the blueprint at spawn"
convention as `tint`/`resist`) with first-pass shared defaults
(`DEFAULT_ENEMY_MOVE_SPEED_PER_TICK` about 63% of `PLAYER_BASE.speedPerTick`,
`DEFAULT_ENEMY_ENGAGE_RANGE_FP` about 5.6 grid — deliberately much shorter than
the gun's own max bullet travel, since deriving the stop-distance from that would
put it beyond most rooms' diagonal and the mob would rarely be seen moving at
all) — undefined on any hand-built `EnemyActor` that bypasses the factory (most
unit tests) falls back to those same constants, so no existing test needed
updating. A real simulation-output change for every existing enemy/boss (they
now occupy different positions tick-over-tick than before), hence the bump — no
steering/pathfinding/kiting yet, straight-line pursuit only (a mob can stall
against a concave wall, same caveat `resolveWalls`'s push-out already carries);
tune the two constants and add kiting/hysteresis as a later, non-bumping content
change if the numbers alone need adjusting.

v38: level 1 becomes a hand-authored 5-floor descent (design/05 "Hand-authored
PvE floors"). `EMBER_DUNGEON` — the one `EngineConfig.dungeon` config every PvE
run is built from — goes from 3 procedurally-drawn floors of 2-3 rooms to 5
authored floors of 5 / 6 / 7 / 6 / 5 rooms, every one of them present in
`floorMaps`, so `SpawnSystem.generateAndPlaceFloor` takes the
`placeAuthoredFloor` branch for the whole run and `generateFloor`/
`placeFloorGraph2d` are never reached. A real simulation-output change on three
independent axes, hence the bump: (1) the floor geometry itself is different
content (14 new `RoomPiece`s, 15x15..20x20 each, loaded from
`world/dungeons/ember/`'s JSON by `world/rooms/emberLevel1.ts`); (2) the
`roomgenPrng` draw count for a run drops to ZERO on layout — an authored floor
costs no draws at all, where a generated one cost one per stage plus one per
door — so any v37 stream's PRNG stream position diverges the instant a floor
places; (3) enemy counts per room now ramp with the room's cell count (15 at
15x15 up to 30 at 20x20, `enemyCountForArea`), against the 1-2 spawn points every
old `EMBER_ROOMS` piece authored, so `aiPrng`'s fire-phase-jitter draw count per
room changes too.

`difficultyCurve` also drops from `perFloor: 1` to `perFloor: 0.5` in the same
change: `curveAt` is a plain `base + perFloor * floorIndex` multiplier on enemy
maxHp (`content/enemies.ts`), so leaving it alone would have taken the deepest
floor from x3 to x5 purely as a side effect of going 3 floors to 5. x0.5 keeps
the same x3 ceiling, now reached over five floors instead of three.

The old procedural pair is NOT deleted — `EMBER_ROOMS` plus the new
`EMBER_PROCEDURAL_DUNGEON` export (`world/rooms/ember.ts`, the exact descriptor
`EMBER_DUNGEON` was before this change) is what `world/dungeon.test.ts`'s
graph2d seed sweeps and exhaustive pool enumeration still drive, and that
coverage is the reason those seven pieces' exit topology is what it is (see that
module's own doc). Nothing in a shipped run reads the procedural pair now.

v39: a DESCEND no longer carries the floor's stranded enemies (and their bullets)
into the next floor — `ExtractionSystem.resolveDescend`'s `dungeonEnabled` branch
now clears `state.enemies` and `state.projectiles` alongside the room/door/rect
arrays it already wiped. Under the co-resident room model (v34) the checkpoint
only requires the CAPSTONE room to be cleared (`capstoneCleared`), and never asks
where the player is standing — so every other room on the floor may still be fully
populated the tick DESCEND resolves. A room whose `WaveScript` carries a late
`atTick` entry re-populates itself long after the player cleared it and walked on,
and `DoorSystem`'s force-regroup drags the player back into it without ever taking
the checkpoint away. Those enemies survived into the next floor holding a `roomId`
for a room that no longer existed and a grid position measured against geometry
that had just been torn down, i.e. embedded in the newly stitched floor's walls.
This was narrow while `EMBER_DUNGEON` was 3 procedural floors of 2-3 rooms holding
1-2 enemies each. v38 (directly above) is what makes it matter: level 1 is now 5
authored floors of 5 / 6 / 7 / 6 / 5 rooms at 15-30 enemies per room
(`enemyCountForArea`), so a player who beelines the capstone can strand on the
order of a hundred enemies per floor and drag every one of them into the next. The
count scales directly with rooms-per-floor and per-room density, which is exactly
the axis v38 moved. Same "the geometry it stood on is gone" reasoning that already
cleared `pickups`.

The discard is SILENT — no `death` events, no `DeathDropsSystem` pass —
deliberately: rolling the drop table once per stranded enemy would shift every
subsequent `dropPrng` draw in the run, pay the player a floor's worth of materials
for kills they never made, and let a stranded boss's `onDeathSpawn` litter the
fresh floor with minions. Removal itself draws no PRNG, so the only observable
change is the enemies'/projectiles' absence (render already reconciles actors from
`state.enemies` per frame, so a vanished id simply plays its death-dissolve; the
`death` event only ever drove score and FX). Both clears sit inside the dungeon
branch: a flat `floors` descend keeps the same arena geometry (only the wave list
swaps) and already requires every enemy dead, so that path is byte-identical to
v38. Any v38 dungeon stream that descended with a non-capstone room still
populated diverges immediately.

v40: enemies only open fire once actually within their own `engageRangeFp`,
fixing a live player report — "the instant I walk into a room, dozens of
enemies gun me down before I can react" — that surfaced right after v38 gave
level 1's rooms 15-30 enemies each. `AIDecideSystem.tick()` used to set
`firing = true` for every enemy in an activated room unconditionally, the same
tick the room activated, regardless of the enemy's actual distance from the
player; `engageRangeFp` (v37) only ever gated `chase()`'s decision to stop
closing distance, never whether the mob was allowed to shoot at all. Since
`ENEMY_GUN_SIM`'s bullet travel (~30 grid) comfortably outranges a 20x20 room's
diagonal, every enemy in the room could and did land shots from wherever it
happened to spawn, the same tick the player first stepped in — a whole-room
alpha strike with no reaction time, regardless of how many of those 15-30
enemies were actually anywhere near the player. Fixed:
`AIDecideSystem.chaseAndEngage()` (renamed from `chase()`) now sets
`e.firing = true` only on the same branch that already stops the enemy's
movement (`distSq <= engageRangeFp²`), and explicitly to `false` while still
closing distance. This is the room-vs-individual aggro split most twin-stick
roguelites (Soul Knight, Enter the Gungeon) use: a room's whole enemy roster
still wakes up and starts closing in the instant the room activates (unchanged
— that's the existing room-activation gate, design/05), but only the ones
already within gun range actually shoot; the rest have to visibly cross the
room first, which is exactly the reaction window the report was missing. A real
simulation-output change (fewer/later bullets, and every downstream
`combatPrng` draw — spread jitter, crit rolls — a fired shot triggers shifts in
time relative to before), hence the bump. No content numbers changed —
`DEFAULT_ENEMY_ENGAGE_RANGE_FP`/per-blueprint overrides are untouched, only
which tick each one first qualifies to fire.

v41: a room's garrison gets a per-ROOM concurrent-fire budget and a staggered
wake-up, because v40's fire-range gate turned out to buy only about half a
second against the same recurring report ("一进游戏就被集火秒杀" — I get
focus-fired down the moment I enter). What finally settled it was measurement
rather than another round of reasoning: `client/sim/pveLevelSim.sim.ts`, a
bot-driven headless level simulator added in the same pass, plays the shipped
level 1 and records per-room reaction window, peak simultaneous shooters, and
worst one-second damage window. On v40 it reported 14 of the entrance room's 15
mobs firing on the same tick, first hit 0.6s after the room activated, worst 1s
window 10 damage against a starter character's 9.2 effective HP, and death in
the entrance room in 100% of runs at BOTH bot skill profiles — the range gate
does nothing about a garrison that simply closes to engage range as one blob and
opens up together.

Two changes in `AIDecideSystem`, both keyed to the room rather than the mob,
since design/05 already makes the room the aggro unit:
  - `grantFireSlots` — at most `ROOM_FIRE_BUDGET` (balance/encounter.ts, 3) mobs
    per room may have `firing` set on any one tick, awarded to the NEAREST
    contenders (stable sort on exact integer Fp squared distances, so equal
    distances keep `state.enemies` order — the same array-order tie-break
    convention used elsewhere). The rest hold position inside engage range with
    `firing` false and take a slot the moment a shooter dies or the player moves
    and reorders the queue. `chaseAndEngage` no longer writes `firing` at all
    (it returns "in range, holding still" instead); `grantFireSlots` is the
    single writer of `firing = true`.
  - `hasNoticed` — a freshly-activated room's mobs may move immediately but hold
    fire for `noticeDelayTicks(id)` ticks after activation (18 + id % 30, i.e.
    0.6-1.6s), measured against the room runtime's existing `roomTick`. Derived
    from the enemy id rather than an `aiPrng` draw deliberately: ids are assigned
    in deterministic spawn order, so the stagger is reproducible without adding a
    PRNG draw site or a new per-enemy field to serialize. Per-enemy rather than
    flat, or the whole simultaneous volley would just arrive later.

Replay impact: a real simulation-output change — fewer and later bullets, and
every downstream `combatPrng` draw a fired shot triggers (spread jitter, crit
rolls) shifts in time relative to v40. Any v40 stream with two or more mobs in
one room diverges. The fire budget applies in every mode (a flat `waves`/tutorial
config buckets its roomId-less mobs under one shared budget); the notice delay is
dungeon-mode only, since a flat config's enemies stream in mid-fight and have no
"walked into an ambush" moment to soften. PvP arenas are unaffected in practice —
they have no `EnemyActor`s at all.

Shipped alongside the content half of the same rebalance (no version bump of its
own — spawn-point data, not engine logic): `world/dungeons/ember/` room garrisons
15-30 -> 8-14, and the authored player-spawn clearance widened 3 -> 6 grid so the
entrance room can't place a mob inside engage range of the spawn point.

v42: a game-feel pass on how a room full of mobs behaves, from a live play
report (2026-08-17): "怪物之间要有碰撞。怪物的感知范围弄小一些，移动速度调低."
Three changes to the deterministic core, all in the PvE enemy path:

  - **Enemy↔enemy push-out re-enabled** (`MovementSystem.resolveActorPairs`).
    That pair was the one documented faction exception, skipped on design/07's
    own "Open questions" recommendation that packed rooms read better with mobs
    leaning overlap. In practice a garrison converging on the player stacked
    into a single blob of overlapping sprites — several mobs sharing one
    silhouette, so the player could neither count the threat nor tell what they
    were shooting. Every alive pair now pushes apart through the same
    half-penetration-each resolver players already used; there is no longer any
    faction branch in that loop.

  - **Perception radius** (`AIDecideSystem.hasAggro`, `EnemyActor.aggroRangeFp`
    / `aggroed`, `DEFAULT_ENEMY_AGGRO_RANGE_FP` = 320 px = 10 grid). Room
    activation (design/05's room-as-the-aggro-unit) is unchanged and remains the
    OUTER gate; this is a new inner one. A woken room's mobs are now fully inert
    — no movement, no fire, and no turning to face — until the player comes
    within their own radius. Before this, opening a door set the room's entire
    garrison walking at the player from wherever it was authored, so a room read
    as one converging blob instead of a space with pockets of threat in it. The
    radius is wider than `DEFAULT_ENEMY_ENGAGE_RANGE_FP` (180 px), so a mob that
    notices the player still has ~4 grid to close before it may fire and v40's
    reaction window survives intact. `aggroed` is a one-way latch, like
    `enraged`: a mob sitting exactly on the boundary would otherwise flip
    between chasing and idling every tick, and the radius is meant as a wake-up
    trigger, never a leash.

  - **Enemy move speed 4 → 2.6 px/tick** (`DEFAULT_ENEMY_MOVE_SPEED_PER_TICK`),
    i.e. ~63% → ~41% of `PLAYER_BASE.speedPerTick`. v37's claim that a slower
    mob means "committing to running away always opens the gap" did not survive
    contact: the player also has to aim and dodge, so the effective gap-opening
    rate is far below the raw speed ratio, and a garrison that had noticed the
    player stayed glued to them.

Replay impact: a real simulation-output change on all three counts — enemy
positions differ from the first tick two mobs touch, from the first tick a
distant mob would have started walking, and from every tick any mob moves at
all. Downstream `combatPrng` draws shift in time with the shots they gate. Any
v41 PvE stream with more than one enemy diverges. PvP arenas are unaffected in
practice: they carry no `EnemyActor`s, and the push-out change only removes an
enemy-only exception.

v43: the player stops at its own body radius against a wall or a pillar, from a
live play report with two screenshots attached (2026-08-19): "目前角色走到墙角的
时候，太靠墙了，感觉陷进去了" — walk into a corner and the character reads as
embedded in the stone rather than standing beside it.

  - **`Actor.solidRadius`** (new field), used by `MovementSystem.resolveWalls`
    and `resolveObstacles` in place of `footprintRadius`. `footprintRadius`
    keeps its old job — actor↔ACTOR push-out — and its old value everywhere.
    `PLAYER_BASE.solidRadius` is 16 px (the body radius, `PLAYER_BASE.radius`);
    every enemy's is its own `footprintRadius`, i.e. mobs are byte-identical to
    v42 in isolation.

    Why the split rather than one radius: the feet circle exists so a tall
    sprite may overlap what it stands against, which is a real depth cue between
    two BODIES and reads as a crowd. Against a standing wall it reads as the
    opposite — the rendered body is exactly 32 px wide (`radius` x 2; the rig is
    normalized to that, design/12), so a 7 px feet circle let 9 px of the
    silhouette sit inside the wall's own art. Matching the body radius puts the
    silhouette tangent to the wall: still "against it", never inside it. The
    depth cue survives on the north/south sides regardless, because the body
    floats 4-36 px above its ground point (the rig's own hover) and still
    overlaps most of a standing wall face at this clearance.

    Level-1 geometry has room for it: every door passage is 2 grid (64 px) wide
    and every authored interior block stands clear of its neighbours, against a
    player diameter that goes 14 -> 32 px.

Coverage: 33 tests across four layers (`engine/systems/rooms.test.ts` for the
resolvers' behaviour on every wall face + the corner/door/knockback cases,
`engine/content/players.test.ts` + `enemies.test.ts` for the content invariants
and the enemy opt-out over every blueprint, `engine/state/GameState.test.ts` for
both seat-construction paths, and `client/src/render/rigComposition.test.ts` for
the cross-layer invariant the bug lived in — the drawn body's half-width, from
the real shipped bundle, against `PLAYER_BASE.solidRadius`). Mutation counts:
reverting the resolvers fails 13, reverting the 16 px value fails 12 engine + 3
client, letting enemies opt in fails 3.

Replay impact: any v42 stream where a player touched a wall or a pillar
diverges from that tick — the resting position against a solid moves out by 9 px
— and every downstream `combatPrng` draw shifts with the shots it gates. A
stream where no player ever touched a solid is unaffected in principle, but
`ReplayInputSource` refuses the version outright either way. Enemy-only
behaviour is unchanged, as is actor-vs-actor push-out for every faction.

v44: a door's passage rect lands on a whole grid cell, from a geometry audit of
the shipped level-1 content (2026-08-20): four wall runs on floors 2 and 5 came
out 16 px deep where every other wall on all five floors is a full 32.

  - **`doorAnchor.ts pickPassageStartGrid`** (new module), replacing the anchor
    draw that `placeFloor.pickDoorAnchor` and `placeFloorGraph2d
    .pickDoorAnchor2d` each had its own verbatim copy of. Same band, same
    `DOOR_ANCHOR_COUNT` candidates, same single `roomgenPrng` draw, same
    fail-loud threshold — the one change is `Math.round` on the drawn anchor.

    Why it was ever fractional: `DOOR_EDGE_MARGIN_GRID` is 1.5, so `bandLo` is a
    half-integer, and `span / (DOOR_ANCHOR_COUNT - 1)` is a quarter-integer. An
    unsnapped anchor could therefore land on a half OR a quarter cell, and
    `carveDoorGaps` — which is doing exactly the right rect-difference — cuts a
    correspondingly misaligned hole. What is left of the wall run past the hole
    inherits the offset: a north-south run whose tail ran 0.5 cells past the gap
    became a 32x16 AABB. Not a clamp anywhere, and not a `mergeWallRuns`
    artifact; it is born in `buildFloorGeometry`.

    Why it matters past tidiness: a 16 px-deep footprint under a 104 px-tall
    perimeter run is the worst case for the standing-wall art — a cap band a
    third of the depth every wall tone was measured on (`design/01-rendering.md`
    "A north-south run is not an east-west wall") — and it is the geometry that
    made the occlusion x-ray need its second, face-fading pass at all.

    Why `DOOR_EDGE_MARGIN_GRID` itself stays 1.5: it is the fit threshold, and
    no integer value satisfies both halves of what the existing tests already
    pin — a 6-cell shared band must still fail to fit a door (so the margin must
    exceed 1) and an 8-cell one must still offer more than one distinct anchor
    (so it must not reach 2). Snapping the OUTPUT needs no such trade: rounding
    outward spends at most half the margin, which still leaves a full cell — the
    perimeter wall's own thickness — between the gap and the corner block.

    Determinism: every input to the `Math.round` is a sum of integers, halves and
    quarters, all exact in binary, so there is no platform-dependent tie-break
    (design/06). The draw count per door is unchanged at exactly one.

    Shipped content was fixed in the same pass, as data: the nine authored
    `passageGrid` values in `world/dungeons/ember/ember_l1_floor_{2,3,4,5}.json`
    that carried a `.5` are floored to whole cells. Those came from the seed
    generator's own clamp (`genEmberLevel1.mjs doorRect` pulled a rounded centre
    back to `bandHi - 2`, itself a half-integer), which is fixed to use the same
    snap. Authored floors cost zero `roomgenPrng` draws, so that half is inert
    for replay on its own.

Coverage: `engine/world/dungeon.test.ts` sweeps both placement paths across ten
spread-out seeds and asserts every drawn `passageGrid` field is an integer;
`engine/world/rooms/emberLevel1.test.ts` asserts the same of every authored door
AND — the class-level gate rather than these four instances — that no wall in any
floor's stitched geometry is thinner than one grid cell or lands off-grid, which
is what actually failed before this pass. `tools/map-editor/src/validate.ts`
rejects a non-integer `passageGrid` typed into the editor's own Inspector.

Replay impact: any v43 PvE stream on a PROCEDURALLY generated floor diverges from
placement onward — a door can move up to half a cell, which moves the carved gap,
the wall geometry, and every enemy path around it. A real level-1 run is driven by
`EMBER_L1_FLOORS` through `placeAuthoredFloor`, which draws nothing, so its
placement is unchanged by the engine half of this bump; its GEOMETRY still changes
where the nine content values moved. PvP arenas are unaffected — they never call
either placement function.

v45: a run always spawns carrying a gun AND a melee weapon, from a live report
(*"角色可以同时持有一把近战武器和一把枪，并且在ui上我标注的位置可以进行切换。我记得之前
实现过一次"* — with a screenshot showing one weapon and an empty swap slot).

    Every layer of weapon swapping had shipped and was still wired: `Button.SWAP_WEAPON`
    → `ApplyInputSystem.swap()`, the keyboard 1/2 keys, the touch corner buttons, and
    `HudView.weaponSlotChip` (the tile the report circled). What had gone missing was
    the SECOND WEAPON. The loadout resolution read

        if (seat.loadout) { ...resolve; empty → [blaster] }
        else               { PLAYER_BASE.startWeapons }

    and `[]` is truthy in JS, so a staged-but-empty loadout took the "player chose
    this" branch and fell back to a lone auto pistol (design/05's old "none → auto
    pistol" rule), discarding the starter gun+saber pair entirely. That branch was not
    an edge case: a fresh save stages `[]`, and `Game.beginRun` consumes the staged
    loadout the moment a run starts (design/05, "one run each"), so every run from the
    second onward hit it. With `weapons.length === 1` the HUD chip hides itself by
    design ("no empty *nothing to swap to* tile"), and the swap verb disappeared with
    no error anywhere.

    `resolveLoadout` (content/players.ts) now owns the whole rule: unknown ids dropped
    (design/09 forward-compat), the survivors capped at `weaponSlots` and kept
    active-first (you crafted it, you spawn holding it), then every free slot filled
    from `PLAYER_BASE.startWeapons` with a kind (`ranged`/`melee`) the staged list does
    not already cover. Nothing staged → gun + saber; one crafted gun → that gun + the
    saber; one crafted blade → that blade + the gun. Two weapons of the SAME kind are
    still honoured verbatim — that is an explicit choice, and no crafted weapon is ever
    evicted to make room for a default, so it stays the one input that legitimately
    carries no melee weapon.

Coverage: `engine/content/players.test.ts` asserts the invariant (two slots, one per
kind) across staged/empty/unknown/over-long inputs rather than restating literals, and
pins the fixture ids' kinds as a premise so a content change cannot quietly make the
kind-filling assertions vacuous. `client/src/meta/forge.test.ts` re-asserts it at the
seam a real run actually goes through (`EngineConfig.loadout` → spawned `weapons`),
including the half-crafted case.

    PvP got the same invariant in the same bump, by a different route. `buildArenaSpecs`
    still never reads `seat.loadout` (the fairness wall is untouched — there is no third
    parameter), but its landing-kit PRESET was `[BLASTER_SIM]`: a single gun, so every
    arena seat spawned with one weapon, no second slot for the swap control, and no
    access to a parry at all until it looted a melee weapon off the map. `landing_basic`
    is now `[BLASTER_SIM, SABER_SIM]`, both scaled by `PVP_SCALE_FACTOR` like any kit
    weapon. Kept as authored per-preset data rather than routed through `resolveLoadout`,
    which reads `PLAYER_BASE.startWeapons` — PvE meta content an arena kit must not
    touch; the both-kinds invariant is gated by a sweep over `ARENA_PRESET_IDS` instead.

    Balance consequence, named rather than buried: parry (`MeleeSimSpec.deflect`) is now
    available to every arena seat from the drop. That is the intent — design/03's
    ranged-vs-melee trade-off should be a choice a player makes during a fight — but it
    moves PvP's bullet-vs-body math, and design/15's zone/TTK numbers are still first-pass.

Replay impact: any stream recorded against a config whose `loadout` was `[]` or
all-unknown diverges — the player now carries a second weapon, which the swap button
can reach and which changes every damage number after it. Configs with an ABSENT
`loadout` (the starter pair) or two resolvable ids are byte-identical on the PvE side.
EVERY PvP arena stream diverges: the landing kit is a different array, so both seats
spawn with a second (scaled) weapon and a reachable parry.

v46: a weapon pickup replaces the slot holding the SAME KIND of weapon, not
whichever slot happened to be active, from a live report — *"拾起武器时，只替换角色
身上对应的武器。不能拾取一把刀，却把枪换掉了，导致玩家拿着两把刀"*.

`PickupSystem.applyWeapon` overwrote `p.activeSlot` unconditionally. That is not a
preference call, it silently destroyed the invariant v45 had just been bumped to
establish. design/03's ranged-vs-melee trade-off is *"both halves are always OWNED;
neither is ever both-at-once"*, and both spawn paths go out of their way to
guarantee it — `resolveLoadout` fills every free slot from `PLAYER_BASE.startWeapons`
with a kind the staged list does not cover, and `landing_basic` is an authored
gun+melee pair. The starter loadout is `[BLASTER_SIM (ranged), SABER_SIM (melee)]`
with slot 0 active, so the FIRST floor weapon of a run, if it was melee, left the
player carrying two melee weapons: no gun, no route back to one, and the swap button
toggling between two of the same thing. The reported case is the default case.

`slotFor(p, kind)` now picks the slot by `w.spec.kind === kind` — deliberately the
same test `resolveLoadout` fills slots with, so the two cannot drift apart. Two
fallbacks, in order: a FREE slot when the player carries fewer than
`PLAYER_BASE.weaponSlots` (a seat built from a config that skipped `resolveLoadout`
holds one weapon, and filling the gap beats overwriting the only weapon it has),
then `p.activeSlot` when both slots are somehow the other kind — unreachable through
any shipped spawn path, but a total function is one less thing to reason about.

The picked-up weapon still becomes the ACTIVE one (`p.activeSlot = slot`), which is
the half of the old behaviour that was never broken: the player clicked this item, so
the weapon they chose belongs in their hands. The change is only WHICH slot is
overwritten.

Coverage: `engine/systems/pickups.test.ts` asserts both directions (a melee pickup
while the gun is active, a ranged pickup while the saber is active), that the weapon
which drops back to the floor is the displaced one and not the active one, the free-
slot fallback, and the invariant itself as a property — a run of six mixed pickups
must hold one of each kind after every single one. Three of the four fail against the
old `p.activeSlot`, checked by mutation rather than assumed.

Replay impact: any stream that picks a weapon up whose kind differs from the active
slot's diverges from the pickup onward — a different slot is overwritten, a different
weapon drops to the floor (a new PickupItem with a different `weaponId` at the same
position), and every damage number after it differs. Streams that only ever pick up
the active slot's own kind, or never pick a weapon up at all, are byte-identical.

---

## `bullet_fired.ownerId` — additive, NO bump (2026-08-30)

`GameEvent`'s `bullet_fired` gained `ownerId: number`, stamped from the firing actor's own
`id` in `WeaponFireSystem.spawnBullet` — the same `a.id` already frozen onto the projectile.

**No `ENGINE_VERSION` bump, on the same grounds as the other entries above that shipped
without one.** The event queue is the engine→render channel and nothing else (design/08): it
is cleared and rebuilt every step, never read back by a later system in the same tick, and
`serializeState`/`hashState` do not touch it. A recorded input stream replays byte-identically
across this change — every position, every PRNG draw and every damage number is untouched.

**Why the field exists.** Render needs to know WHO fired, not just where. `bullet_fired`'s
`gx/gy` is the SIM's muzzle — `muzzleOffset` along the aim ray on the GROUND plane — which is
12–14 world px from the barrel tip the rig actually draws (measured on live shots), so the
muzzle fx anchored to it read as absent, and the firing recoil has to play on one specific
rig. `Scene` already resolved `Projectile.ownerId` this exact way for the bullet view's
barrel-tip spawn correction; this puts the same fact on the event, so the fx and the shot
leave the same point.

Coverage: `engine/systems/ballistics.test.ts` — the player path, the enemy path, every pellet
of a multi-pellet shot, and two simultaneous shooters told apart in one frame.

---

## v47: a free-standing block's NORTH face reserves an extra body radius (2026-08-30)

`MovementSystem.resolveWalls` now treats a wall whose rect carries `AABB.freeStanding` as if
its north edge were `config.WALL_NORTH_BRIM` (500 fp = 16 px = one player body radius) further
north than it is. The three other faces, every perimeter wall, every door passage folded into
`state.walls` by `DoorSystem`, and every flat `EngineConfig.walls` entry are untouched.

**Replay impact: any stream that walks an actor up to the north side of an interior cover block
diverges from that contact onward** — the actor stops 32 px out instead of 16, so its position,
every subsequent shot's origin, and every AI decision keyed off a distance differ. Streams on a
floor with no free-standing solids at all, or that never touch one from the north, are
byte-identical. Enemies use the same resolver and get the same brim: a chase path that hugged
the north side of a block now hugs it a body-radius further out.

**Why.** Live report, with two screenshots: *"角色整个跑到墙里面了"* — the character walked north
of a mid-room wall and was drawn wholly inside it — held against the pillar three metres away,
*"角色大概只有半个身子被柱子覆盖"*. Both shapes are drawn upward from a grounded origin
(`screen.y = gy - z`), so each paints a band of walkable floor north of its own footprint, and
how deep a character sinks into that band is `drawn height - reserved floor`. The two shapes had
never agreed on the second term:

| | reserves | paints north of it | sink |
|---|---|---|---|
| pillar (`radius: 1` grid) | `32 + 16` = 48 px | 88 px (`pillarArtExtent`, shipped art) | 40 px |
| interior block (pre-v47) | `16` px | 70 px (`WALL_H_INTERIOR`) | **54 px** |

40 px of sink is a body covered to about the waist; 54 px is more than the whole silhouette
(drawn 20-48 px tall), which is why one read as cover and the other as the character falling
into the geometry. The brim makes the block's sink 38 px, within 2 px of the pillar's.

**Why a per-solid flag and not a rule for every wall.** A perimeter ring is what door passages
are carved through (`carveDoorGaps`), and brimming it would narrow every east-west passage from
the south side; a room's south boundary is drawn as a 22 px kerb (`WALL_H_KERB`) whose entire
purpose is that an actor CAN stand tangent to it, so brimming that would re-open v43's
*"太靠墙了，感觉陷进去了"* from the opposite direction — a character floating off a lip that was
never covering them. The flag is set where the distinction still exists (`launchArena.furnish`
splits `perimeterSolids` from `kit.solids`; `world/rooms/ember.ts` marks its two stub walls),
carried through the one grid→fp conversion in `roomGeometry` and through `subtractRect`'s
residual pieces, and read in exactly one place.

The rect itself never moves: `blockedCells`, spawn placement, the geometry metrics, the drawn
footprint and the projectile/LOS queries all still see the authored numbers. Only the actor
push-out reads the flag, and the broadphase query in that one function widens by the brim to
match (the shared index is still built over the real footprints).

Coverage: `engine/systems/rooms.test.ts` (the north face moves, the other three do not, the
engulfed-actor axis separation uses the inflated edge, and the widened broadphase finds a block
an actor overlaps only through its brim) and `client/src/game/scene/occlusion.test.ts`, which
owns the constant's VALUE as a parity assertion against `pillarArtExtent` rather than a literal.

## v48: the north brim widens, enemies join it, and dropped loot respects it (2026-08-30)

Three changes shipped together because they are the same report answered from three angles —
live feedback on v47 itself, with a circled screenshot: *"角色被挡住的部分再上移一些，大概当前角色
的一半可以进入墙。也就是现在感觉在1/2的位置，改为1/4的位置。怪物也要遵守同样的规则，截图中，角色根本
无法拾取掉落的物品。"*

**1. `config.WALL_NORTH_BRIM`: 16 → 23 px.** v47 made a wall's sink (38 px) match a pillar's
(40 px) — both still read as "sunk in," not "standing behind." The naive fix is to double the
brim to 32 px (one full body width); that was tried first and rejected by
`launchArena.test.ts`'s "what the north brim costs the launch map" suite, which rasterizes the
shipped arena's standable floor with and without the brim and asserts the same rooms stay
connected into the same regions: at 24 px one of the map's single-grid-cell gaps stops fitting a
player and a route seals (45 regions become 61 — a real disconnect, not a raster artifact). 23 px
is the largest value that measures zero lost routes on the shipped content, and drops a wall's
sink from 38 to 31 px — real, but a ceiling set by room geometry, not the quarter the report
asked for. Getting further needs the room/kit authoring itself loosened (more clearance around a
free-standing block), which is out of scope here. `solidRadius` itself was left alone — widening
it would float a character off a wall's east/west face, which v43 tuned to land exactly tangent.
The wall/pillar sink parity `occlusion.test.ts` used to assert is deliberately NOT preserved:
nothing here touched the pillar's own reservation, so a wall now covers noticeably less of a
character than a pillar does. Known, and left that way — nobody has filed the pillar version of
this report.

Note what this does NOT fix: the shipped floors' worst measured occlusion sample (43.75% hidden,
`occlusionCoverage.test.ts`) is a position no block's `occludes()` rule fires for at all (just
under `MIN_COVER_FRACTION`), on what measurement showed to be kerb/perimeter geometry — untouched
by a constant that only ever applies to a free-standing block's north face.

**2. `EnemyBlueprint`-built actors: `solidRadius: bp.footprintRadius` → `solidRadius: bp.radius`.**
v43 gave the player a wall clearance equal to its own body radius; mobs were deliberately left on
the old feet-circle answer, on the grounds that widening a mob's clearance moves every chase path
that hugs a wall — a balance change to garrisons measured against `client/sim/pveLevelSim.sim.ts`.
The live report is explicit that this asymmetry is itself the bug now (*"怪物也要遵守同样的规
则"*): a monster reads as buried in a wall or pillar exactly where its own tiny clearance let it
stand, which was supposed to have ended with v43. Reversed for every blueprint uniformly (no
per-type opt-out) — `content/enemies.test.ts`'s three pinned tests were rewritten for the new
premise rather than deleted, so a future mob can't quietly regress to the feet circle either.
`footprintRadius` (actor-vs-actor push-out) is untouched — only the wall/pillar side moved.

**Replay impact:** any stream with an enemy that approaches a wall or pillar from the outside
diverges from that contact onward, same shape of impact as v47's for players. Re-ran
`npm run test:pve-sim` (the bot-driven 5-floor dungeon sim) against the new clearance: every
balance gate still passes, including "nothing softlocks" — the chase paths shifted, the level did
not stop being clearable.

**3. `geom.clampToWalkable` now respects the same brim `MovementSystem.resolveWalls` does.** Same
live report names an item the player could not pick up at all; this is the mechanism that class of
bug would go through — a dropped pickup's landing spot (`DeathDropsSystem`, the weapon-swap drop
in `PickupSystem`, arena crate placement in `SpawnSystem`) was clamped only against a free-standing
block's bare authored footprint, never the brimmed band no actor is allowed to stand in. `geom.ts`
had zero direct test coverage before this — every caller only ever exercised it as a side effect of
a bigger system test — so the gap was real regardless of whether it is what the screenshot showed.
**One honest caveat, found while writing the regression test** (`systems.test.ts`, "the reachability
margin..."): at TODAY's shipped numbers (`WALL_NORTH_BRIM` 23 px, `PLAYER_BASE.solidRadius` 16 px,
`SIM.pickupRadius` 15 px) a single free-standing block with no neighbour never actually crossed
into truly-unreachable territory even pre-fix — the collect reach (`pickupRadius + PLAYER_BASE.
radius` = 31 px) covers the worst-case gap (24 px) with room to spare. The fix is still correct and
worth having: it is what keeps that margin from silently vanishing the next time `WALL_NORTH_BRIM`
is widened further (flagged as the likely next move once room geometry allows it — see point 1),
and a compounding case this session did not fully chase down — two free-standing blocks' brims
overlapping near a corner, or `clampToWalkable`'s own documented single-pass limitation on a point
"wedged in a deep concave corner" — remains a plausible source of a genuinely unreachable drop that
this specific numbers-check does not rule out. `clampToWalkable` now inflates a free-standing wall's
north edge by the brim exactly like `resolveWalls` does, both for the broadphase query and the
push-out itself, so a drop can never land closer to a free-standing block's north face than any
actor's own `solidRadius` circle could.

## v49: the brim reaches the campaign, and four boundary bugs the test pass found (2026-08-30)

Five changes, all outcome-moving, shipped together because they are one investigation:
`design/18-test-strategy.md`'s Layer 0–3 build-out. Every one of them was found by a new
test rather than by a report, and each is pinned by the test that found it.

**1. PvE level 1 finally gets the v47/v48 north brim.** The two previous versions built the
free-standing brim and tuned it — against the launch arena, which flags every kit solid. The
five shipped ember floors flagged *none*: all 14 `world/dungeons/ember/pieces/*.json` carried
zero `freeStanding`, so 34 rects that the renderer stands at `WALL_H_INTERIOR` (70 px) reserved
no extra floor at all and a character north of one was buried by the full pre-v47 amount. Two
versions of work were inert over the entire campaign. 18 solids across 7 pieces are now flagged
(they resolve to those 34 placements). Route safety was measured the way `launchArena.test.ts`
measures it for the arena — flood-filled standable floor with and without the brim, per floor:
regions unchanged, every room still reachable, 0.3–1.6% of floor area lost.

**2. `MovementSystem` re-separates from solids after the pair push.** Wall resolution used to
run before `resolveActorPairs`, so a pair shove was the last thing a tick did and could push an
actor back into stone. The comment tradition said this was "corrected on the following tick",
and for a glancing shove it was — but two bodies pinned together against a wall re-apply the
shove every tick, so the wall pass never got the last word and the pair reached a *stable*
standoff inside the wall. `smoke.test.ts` measured 103 consecutive ticks (~3.4 s) at up to
189 fp — 6 px of body in stone — on the launch arena. `reseparateFromSolids` gives solids the
final word. Accepted trade, and the right way round per design/07: two actors may now overlap
each other slightly more than the pair push intended, because overlapping a solid "reads as
sinking into it" while overlapping another actor "reads as a crowd".

**3. `clampToWalkable` iterates, with the world clamp inside the loop.** Two defects at once.
The world clamp ran last and won, parking a point back inside the wall the push had just
cleared — in dungeon mode the world bounds ARE the floor extent, whose edge is the one-cell
perimeter ring, while the clamp parks at exactly `radius` from the edge. 247 of 23,509
standable samples on shipped floor 1 came back unstandable. Reordering alone does not fix it:
clamping first sends a point inside the perimeter ring out by its *nearest* edge, which at the
map boundary is the outer one, so hundreds of samples per floor landed outside the world. The
two constraints genuinely conflict at the edge, so walls, obstacles and the clamp now alternate
inside one bounded loop (`MAX_SEPARATION_PASSES` = 4, an exact-equality early exit, clamp last
within a pass so a degenerate pocket ends in-world rather than off-map). The repeat also closes
this function's own documented "a point wedged in a deep concave corner could want a second
pass" caveat, which shipped content had started producing. Measured after: zero out-of-world
results anywhere, and zero standable inputs turned unstandable on any ember floor (163 of
116,984 remain on the launch arena, in pockets narrower than a player, where no correct answer
exists).

**4. `DeathDropsSystem` clamps a spawned minion by its solid clearance.** It used
`footprintRadius` under a comment that already said "a spawned actor needs its own solid
clearance" — right intent, wrong radius, because solids stopped pushing `footprintRadius` in
v43 (players) and v48 (enemies) and nothing re-checked the comment. Every minion clamped tight
teleported on its first tick, by the gap between the two radii, worst on the biggest bodies —
i.e. worst on exactly the bosses whose deaths spawn minions.

**5. `DoorSystem.inLockingDoorway` tests the passage by the same radius that displaces.** Same
stale premise, same fix. The predicate under-reported: a player whose body was in the restored
passage but whose feet circle was clear was judged "not in the doorway", was not regrouped, and
was then shoved out by the very push-out the doc-comment exists to describe — reopening the v41
permanent-lock softlock from a narrower angle.

Also in this pass, without bumping (behaviour-preserving, and the golden fixture recorded
before the extraction still matched after it — which is what proves it):
`engine/systems/solidBounds.ts` and `engine/state/actorRadius.ts` collapse three independent
copies of the wall-boundary rule into one.

## v50: a monster may not stand where the player cannot, and a drop lands where a body fits (2026-08-31)

Two changes, one sentence each, both taken verbatim from the third round of the same live
report — *"依然有掉落的物品无法拾取。你要判断一下怪物不能跑进阻挡区域，掉落物品也不能掉在阻挡
区域"*.

**1. Every enemy's `solidRadius` is floored at `PLAYER_BASE.solidRadius`.** v48 gave mobs the
player's RULE (stop at your own silhouette, not your feet circle) and left them with their own
NUMBER, which for four of the eight blueprints is smaller than the player's: critter 13 px,
basic/ember/frost/venom 15 px, against the player's 16. Those mobs could therefore stand — and
die, and drop loot — in a band no player could enter. `Math.max(bp.radius, …)`, not a flat
assignment, so brute (20 px) and boss (30 px) keep stopping at their own silhouette; the change
only ever widens a clearance.

Route safety needs no new sweep, and that is the point of the floor's value rather than an
omission: every mob now clears a solid by at least what the player clears it by, so any gap a
player fits through a mob fits through, and the player's own connectivity across all shipped
content is what v48/v49 already measured and pinned.

**Replay impact: any stream with a small mob that touches a wall or pillar diverges from that
contact onward** — same shape as v47's and v48's. Re-ran `npm run test:pve-sim`: every balance
gate still passes.

**2. All three drop-placement sites clamp by `dropClearance()` (= the player's own
`solidRadius`, 500 fp) instead of `SIM.pickupRadius` (469 fp).** `DeathDropsSystem`'s death
drop, `PickupSystem.applyWeapon`'s swap drop, `SpawnSystem.spawnArenaLoot`'s authored crate.
The old radius answered "how close must a player be to collect me"; the question a placement
clamp actually asks is "can a player's BODY be here", and the player's body is wider. The two
differ by 31 fp along a flat face — and by an entire pocket wherever geometry is tight, since
the set of points a 469 fp circle fits in is strictly larger, and differently CONNECTED, than
the set a 500 fp circle fits in.

**Honest scope, because the measurement came before the change.** At today's numbers the old
radius stranded nothing. A sweep of 903 real drops across 16 bot-driven runs of all five shipped
floors found zero unreachable and zero embedded in stone, the nearest standable point never
further than 116 fp against a 969 fp collect reach; a separate static sweep of every death cell
on floor 1 and the launch arena found zero too. The 14.5% of drops that a first pass flagged as
"under wall art" was an artifact of assuming `WALL_H_PERIMETER` for every non-`freeStanding`
rect — re-run against the renderer's own `wallTier`, where a wall with room floor north of it is
a 22 px kerb, the figure is **0 of 903**. So this version does not fix a measured strand; it
replaces a margin with a construction, which is what lets `smoke.test.ts` assert it per tick
(*"every alive pickup sits where a player's body could stand"*) — and an invariant is what
survives the next time `WALL_NORTH_BRIM` or a body radius moves. The report itself is therefore
NOT yet explained by anything in the engine; see the smoke suite's new pickup invariants for
what is now ruled out by construction rather than by sampling.

*(Superseded 2026-09-01 by v51: there WAS a mechanism in the engine, and this version could not
have found it. Every rule and gate above is about the moment of the drop; a locking door moving
a wall under a drop that had already come to rest is a different question. The sweep quoted here
did re-check on every wall-set change — the case simply never arose in those runs, so it
reported the same zero a working check reports.)*

## v51: a locking door re-seats the loot it closes over (2026-09-01)

The fourth round of the same live report — *"依然有掉落的物品无法拾取"* — and this time with a
mechanism, found by asking a question v50 never asked.

v50 made every drop SITE legal: all three placement sites clamp by `dropClearance()`, so the
point an item is created at is a point a player's body could occupy. `smoke.test.ts` asserts
that per tick across the five shipped scenarios. Both statements are about the moment of the
drop, and neither says anything about what happens to a resting place afterwards.

`DoorSystem.rebuildWalls` is the only thing in this engine that changes the wall set mid-run.
When a room activates, every locked door's `passageAabb` is pushed into `state.walls` — and an
item already lying in that passage is now inside stone, with no mitigation anywhere: nothing
re-clamps a pickup after its drop tick, and `PickupSystem` collects on a radius test that does
not consult walls at all. Whether the item was still reachable came down to whether a player's
body could get within `pickupRadius + p.radius` of a point buried in a passage rect.

A doorway is not an exotic place for a drop to be. It is where fights happen: a mob dies on the
threshold (`DeathDropsSystem`), or a player swaps a weapon while standing in it
(`PickupSystem.applyWeapon`), and then their own step across the line activates the room and the
door closes over it. The v50 sweep of 903 drops could not have seen this — it sampled drop sites,
and this bug happens strictly after the drop.

**The fix**: `rebuildWalls` now ends with a re-clamp pass over every alive pickup, at
`dropClearance()`, after `rebuildSpatialIndex()`. Unconditional rather than "only the ones in a
passage", because the predicate for "is this one affected" is the same solid query
`clampToWalkable` already performs, and it is exactly a no-op on a clear point — so testing
first would only compute the answer twice. Idempotent, so a repeated rebuild cannot walk an item
across the floor, and it runs only on the rare tick a lock actually changed.

**Replay impact: any stream in which a door locks over a dropped item diverges from that tick
onward.** Narrow by construction — a run with no item in a closing passage is byte-identical,
which is why `fixtures/golden.json`'s hash did not move and the re-record only restamps the
version. That unchanged hash is also the honest measure of what the golden scenarios cover here:
they never produce the case, which is why the regression lives in `systems/doors.test.ts` as
three named cases (sealed item re-seated, distant item not moved by a single fp, re-seated item
not parked on the far side of the closed door) rather than resting on the fixture.
## v52: a melee swing announces itself (2026-09-02)

From a live question — *"角色现在有攻击动画吗？射击的和拿刀时的"* — whose honest answer was "half".
A ranged shot had one (`bullet_fired` -> the render layer's recoil envelope); a melee swing had
nothing at all, because **the sim never told the render layer a swing happened**. `deflect` fires
only when a swing catches a bullet and `hit` only when it connects; a swing at empty air produced
no event of any kind, so a sword could never animate.

`WeaponFireSystem`'s melee branch now pushes `melee_swing` (`ownerId`/`faction`/`gx`/`gy`/`facing`
— deliberately the identical field list to `bullet_fired`, so the render layer answers both with
one reaction), beside the `justSwung` latch it already set.

**Why an event, when `justSwung` is already hashed sim state the render layer could just read.**
Because it is a ONE-TICK latch, and the online loop does not look at every tick.
`GameLoop.advanceOnline` calls `session.drive()` — which drains every confirmed frame the server
has ready — and then reconciles the scene ONCE, against the last of them. Any swing on an
intermediate frame is simply not in the state the render layer ever sees, and how often that
happens is a function of latency. `drive()` returns the whole drained event batch, so an event
cannot be skipped that way. This is the property design/08 built the channel for.

**Replay impact: no sim outcome moves.** `state.events` is never read back by a later system and
never enters `serializeState`/`hashState` — exactly as `bullet_fired`'s own comment records, which
is why adding its `ownerId` field needed no bump at all.

That was **measured, not assumed**, and the measurement only means anything BEFORE the bump: this
engine serializes `version: ENGINE_VERSION` into the hashed state, so bumping alone moves all five
scenario hashes and a post-bump run cannot tell "the event changed the sim" from "the version
changed". Run against the v51 fixture with the emit in place, **all five hashes still matched**;
the only failures were the five `witness` assertions, each gaining exactly one key:

```
arena-waves           melee_swing: 7      ember-dungeon-floor1  melee_swing: 67
walls-and-pillars     melee_swing: 27     brim-grinder          melee_swing: 36
launch-arena-pvp      melee_swing: 44
```

So the bump buys nothing about divergence; it is what `versionContract.test.ts` demands before the
witness re-record is accepted, and it is still the right answer, because a v51 client and a v52
client disagree about what a stream *emits* — `ReplayInputSource` refusing the mismatch is cheaper
than discovering it as a desync.

Those counts are also the first evidence the melee path is exercised by the golden set at all:
before this, nothing in the fixture distinguished a run that swung 67 times from one whose melee
weapon was never off cooldown.

## v53: melee swings get their authored ACTIVE HIT WINDOW (design/07 step 7)

`MeleeSpec.swingSec` had been authored on all seven melee weapons since Stage C — 0.1 s on the
spear, 0.2 s on the hammer — carrying the doc comment *"ACTIVE hit-window (subset of
cooldownSec), 07 step 7"* and an entry in design/09's conversion table (`swingSec → swingTicks
(active-hit window, 07)`). `toSimSpec` never converted it, `MeleeSimSpec` had no field to convert
it into, and **nothing in the repo read it**. `HitResolveSystem.meleeArc` resolved the entire arc
on the single tick `justSwung` latched, so every blade had an effective one-tick window and the
hammer and the spear were identically timed. design/07 step 7 has said otherwise the whole time
(*"a swing is active for a few ticks (`swingTicks`); during active frames, test the weapon's arc
… each target is hit at most once per swing (track hit ids on the swing)"*), so this is the spec
landing, not a new mechanic.

**What moved.** `MeleeSimSpec.swingTicks` (converted, clamped into `[1, swingCooldownTicks]`) and
three `WeaponState` fields: `swingTicksLeft` (the live window, counted down at step 3 alongside
the cooldown), `swingHitIds` (once-per-target-per-swing across the whole window), `swingDamage`
(the payload frozen on the start tick). `HitResolveSystem` and `DeflectSystem` both gate on
`swingTicksLeft > 0` instead of `justSwung`; `justSwung` survives as the one-tick START latch that
freezes the payload and emits `melee_swing`. `openSwing`/`closeSwing` (`content/weapons.ts`) are
the single definition of the transition, so a caller cannot set half of it.

**Deflect widened too, on purpose.** design/07's locked decision is *"the SAME arc both damages
enemies and deflects bullets — there is no separate `blockArc`"*, and an arc that damages for four
ticks but parries for one is a separate blockArc in all but name. So the parry window is the same
field, which is a real balance move on the pivot mechanic (one tick → 3-6 by weapon), not a free
refactor. design/05's *"deflect is already a commitment"* still holds: the commitment is spending
the swing, and frame-perfect parry timing was not readable at 30 Hz anyway. Watch it in playtest.

**Why the bump.** Outcomes move. Measured against the v52 fixture BEFORE bumping (the only point
at which the measurement means anything — `version` is serialized into the hashed state, so the
bump alone moves all five hashes):

```
                       deflect        hit        melee_swing   prngCursors
ember-dungeon-floor1     5 → 7      62 → 61          67 → 67      unchanged
launch-arena-pvp         1 → 3      51 → 53          44 → 44      unchanged
arena-waves / walls-and-pillars / brim-grinder: hash moved, witness unchanged
```

Read that table as three separate claims, because each is a thing that could have gone wrong:

  - **`deflect` up** — the wider parry catches bullets the one-tick window missed. The feature
    working, in shipped content, not in a fixture.
  - **`melee_swing` unchanged** — the swing COUNT did not move, so the window did not accidentally
    become a second trigger. The cooldown still gates how often a blade swings.
  - **`prngCursors` unchanged** — the single most load-bearing number here. The crit is still
    exactly ONE `combatPrng` draw per swing (design/07: *"a melee swing rolls ONCE for the whole
    arc"*), not one per active tick. Had `meleeArc` re-rolled per tick, a 6-tick hammer would have
    drawn six times and this column would have moved in every scenario. `swingDamage` is what
    holds it still.

`hit` moves in both directions and that is expected: a bullet parried by the wider window no
longer lands on its target (dungeon, 62 → 61) while a body that walks into a still-open arc now
does get caught (PvP, 51 → 53).

**Coverage.** `systems/meleeWindow.test.ts` (33 tests, plus 10 across the render chain) is new and exists because the pre-existing
melee tests could not have caught this: every one of them staged a swing by hand-latching
`justSwung` and asserted the hits on that same tick, which is exactly what a one-tick window
produces. Each test there either counts the active ticks it observed or proves the target was
unreachable on the swing tick before asserting it was reached later — a test that would pass
against `swingTicks: 1` is not testing this. A 31-mutant battery (21 engine, 10 render) measured
the result rather than assuming it: 31/31 killed, tables in the two test files' headers. Notably
all four "drop a swing field from `serializeState`" mutants survived the entire repo until the
hash block in that file existed — a golden-replay comparison of two identical runs cannot see a
missing field, as `replay.ts`'s own comment says.

**Render.** The window is what the swing envelope and the sector fx are now paced from.
`rigAttackMotion.swingSchedule` (landed hours earlier by the melee-sector pass, `c25edea`) already
derived per-weapon timing — but from `swingCooldownTicks`, the RECOVERY, because that was the only
number available while `swingSec` was unconverted. `SwingShape.recoveryMs` becomes
`SwingShape.windowMs`, sourced from `swingTicks`, and the envelope is anchored so `strikeEndMs`
lands on the window's close: the visible stroke covers exactly the ticks that can connect. The
saber moves 260 ms → ~242 ms, the hammer to ~364, the spear to ~182, and `slashArc` inherits all
of it since it schedules off `strikeStartMs`/`strikeEndMs`. The two are not proportional across
the roster (the spear spends 33% of its recovery active, the frostbrand 36%), so no constant could
have stood in.

`melee_swing` deliberately carries NO weapon data. An earlier draft of this bump added
`swingTicks` to the event; it was removed the same day, because `EventReactor.meleeSwinger`
already resolves the spec out of the `GameState` every client holds, so the field had no reader —
a second source of truth for a number the only consumer already has, which is the very shape
`swingSec` spent two months in.
