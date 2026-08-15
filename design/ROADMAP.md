# Implementation roadmap

The ordered task list that took DayDayUp from a combat-sandbox vertical slice to the full
closed loop the design docs describe, and the running record of how each phase actually
landed. Phases are written top-to-bottom in dependency order; each one keeps its dated
shipped-notes underneath it, so a phase section is both the plan and the history.

**Current built state (2026-08-14).** `ENGINE_VERSION` **37** (32: ground-weapon pickup is
click-driven; 33: manual aim removed entirely; 34: co-resident PvE room/door model, engine +
client rendering; 35: fully-realized branching — see the Room & door model section below;
same-day map-editor door placement, the `layout: 'graph2d'` real-2D-layout follow-up, AND the
"graph2d content" pass that switches `EMBER_DUNGEON` to it are all additive, no version bump;
36: two Room & door model bug fixes, `onDeathSpawn` roomId + negative-offset floor bounds —
see the Room & door model section below; 37: enemies/bosses actually move now — a live player
report ("怪物的AI不会移动的吗？目前的怪物和boss只会原地开枪") found that `AIDecideSystem` had
always been true to its own doc comment ("Enemies are stationary in the slice"): every mob
turned to face the nearest player and fired, but no system ever wrote a non-zero `vx`/`vy`
into one, so `MovementSystem`'s per-enemy integration was a correct no-op the whole time — an
`AIDecideSystem` gap, not a `MovementSystem` bug. Fixed with a first-pass `chase()`: close the
distance in a straight line until within `EnemyActor.engageRangeFp` (new, defaults to ~5.6
grid — deliberately much shorter than a gun's own max bullet travel, or the mob would rarely
be seen moving in a normal-size room), then stop and shoot; `moveSpeedPerTick`/`engageRangeFp`
are new optional per-blueprint knobs (`content/enemies.ts`) for a future kiting/rush/sniper
variant, unused by any blueprint yet. No steering/pathfinding/kiting — see
`ENGINE_VERSION_HISTORY.md`'s v37 entry for the full account); 2740 tests green across all 7
workspace packages (engine 568 / client 1167 / server 186 / animator 444 / map-editor 260 /
png-pipeline 20 / desktop-shell 81 / root build-script 14, `npm run check`, verified
2026-08-14) after fixing two real bugs found from a live player report ("cleared
the room, door's unlocked, still can't walk through it") — see the Room & door model
section below for the full account. Before that, closing a real gap the test-coverage audit
pass had flagged and left open: `onRequestSave` (tools/desktop-shell/src/preload.ts) now
catches a *synchronously*-thrown save callback too, not just a rejecting one, so
`nw:save-ack` always fires. That audit pass itself (see the Test coverage audit pass section
below) closed ~50
previously-untested files and found zero dead/obsolete tests to remove; before that, a full
client code-review pass
(2026-08-04, see the Phase 3/4 updates and the Client hardening pass section below) that found
and closed a real Phase-3 gap (mid-match reconnect was server-ready but never actually wired
from the client) plus a real Phase-4 squad-scoring bug, alongside a dozen smaller correctness/
robustness fixes across net, render, and UI. **Phases 0–4, 6 and 7 are closed with no deferred items**: the deterministic
engine and the locked content model (0), the full in-run loop — frame library, room pieces,
seeded dungeon generation, extraction checkpoints, materials (1), the meta/forge loop and the
3-character roster (2), online co-op — frame-broadcast lockstep, downed/revive, matchmaking
with signed tickets, render-layer local prediction (3), 8-player solo-or-squad PvP on a real
60-room arena map with a shrinking zone, placement scoring, anti-cheat checkpoints and an Elo
ladder (4), username/password accounts bound to ladder rating and forge progress (6), and an
English-canonical i18n system with a 中文 translation (7). **Phase 5 (presentation) is the only
partially-open phase** — the widget kit/HUD/screens (now including a menu-driven Mode Select,
a real Matchmaking connecting/error screen, a standalone tutorial level, a local-player downed/
revive HUD, a PvP match-preview screen, and a left-handed control-layout toggle, all 2026-08-03 —
see that entry under Phase 5 below), the `.tao` art pipeline with a fully bound roster,
post-processing, particles, all four fidelity-roadmap custom shaders (5.4), and (2026-08-03,
see that entry below) 5.4's dynamic-lighting milestone all ship; the project's art direction is
now GPT-Image-2-generated art treated as final production art (an explicit scope decision, not a
tooling change — see the 5.3 update below), so what remains in Phase 5 is real authored SFX/
music, and 5.5 WeChat device verification (blocked on hardware). A repo structure pass (bottom
of this doc) made the engine its own DOM-free package and the repo an npm workspace. Per-item
detail, including what each phase deliberately did *not* build, is in the sections below; the
`## Dependency summary` at the end is the one-screen version.

**Historical snapshot (2026-07-24), kept for context:** floors → checkpoint → extract-or-descend → bank, on a single-arena/wave geometry — menu/victory/defeat shell, waves, pickups, damage + elemental status + resist, deflect, one boss, plus the placeholder audio seam. Deterministic engine (fp/brad/PRNG/InputSource/replay) is in place. **Phase 0 (design↔code sync) is done through 0.7** — the engine matches the locked design: no affixes, intrinsic weapon rarity, run-buffs, two-pool shield health + regen + shield-break, characters = SkinDef (side-grade roster), and the design/09 pickup vocabulary (`heal`/`material`/`weapon`/`buff`). **Phase 1 (1.1–1.5) is done**: `spread`/`homing`/`lob`/`beam`/`boomerang` ballistics + melee `hammer`/`spear`; AABB tile/wall solids + the `RoomPiece` schema + seeded `generateFloor` (neither yet wired into a live floor transition — see the Phase 1 status note below); and a live, tested `EngineConfig.floors` → `ExtractionSystem` → materials-banking loop using the existing single-arena infrastructure. **`ENGINE_VERSION` is 17** (bumped for the orbit/radial frame finish, then for co-op downed/revive; every other Phase 1–2 item shipped additively — see `config.ts`'s version-history comment). **Phase 2 (meta loop) is done through 2.4** — forge, tier-gated crafting, the 3-character roster + balance suite, and monetization grant-scaffolding all ship. **Phase 3 (co-op & netcode) is done**: 3.2 (revive/downed + team-wipe) engine-side; **3.1 (the net layer) now spawns the 2nd player** (`EngineConfig.players`) + ships the frame-broadcast netcode (`@dd/engine/net` + the `server/` package + the client `CoopSession`), proven byte-for-byte by loopback tests; and **3.3 (the matchmaking/deployment control plane)** — a `matchsvc` HTTP service that pools players and issues **signed HMAC tickets** the gameserver verifies at `/ws`, plus a client `?online=1` path (matchmaking → ticket → `CoopSession`) browser-verified two-tab (two independent tabs matchmade into one room, byte-identical lockstep to a shared gameover tick). And **local-player prediction/reconcile smoothing shipped too** — a render-layer `LocalPredictor` (movement/aim, snap-vs-lerp) that hides RTT without touching the sim, browser-verified under a `?lag=` harness. All additive (no `ENGINE_VERSION` bump; still 17). **Phase 3 is fully closed** — no deferred co-op items remain (only local *firing* prediction is a documented non-goal, as it would need sim rollback design/06 rejects for casual/WeChat).

**Conventions**
- 🔴 **bumps `ENGINE_VERSION`** — changes sim outcomes / replay bytes. Reset/regenerate golden replays in the same PR.
- 🟢 **render-only** — no sim change, no bump.
- Every engine task ships with unit tests + a green `vitest` run + a golden-replay check (design/06/08).
- Content numbers live only in `@dd/engine` (design/09); docs snapshot with a date.

---

## Phase 0 — Design ↔ code sync (DO FIRST)

Make the shipped engine match the **locked** design. Each item is a self-contained PR.

**Status (2026-07-24): 0.1–0.6 all shipped — `ENGINE_VERSION` now 14.** Only 0.7 (this doc pass) remains. Version history: affix removal v9→10 (0.1); intrinsic rarity additive/no-bump (0.2); run-buffs v10→11 (0.3); two-pool shield v11→12 (0.4); characters=SkinDef v12→13 (0.5); pickup vocabulary v13→14 (0.6).

### 0.1 ✅ 🔴 Remove the affix system (locked cut — 03/09/14) — DONE (v9→10)
The single biggest divergence: design took the Soul-Knight route (Frame × Element, no affixes) but the code still has the full affix layer (~20 files).
- **Delete:** `balance/affixes.ts` (+ `affixes.test.ts`); the `elem_*` set-element weapon; `AFFIX_*` / `EFFECT_CAPS` / `applyAffixes` in `balance/build.ts` (+ `build.test.ts`).
- **Strip:** `PlayerActor.affixes` + `WeaponState.base`/re-resolve (`state/entities.ts`); the `'affix'` `PickupKind` + `PickupItem.affix` + the `pickup` event's `affix?` and `Affix` import (`state/events.ts`); affix branches in `PickupSystem.ts` (+ `pickups.test.ts`), `DeathDropsSystem.ts`, `content/drops.ts` (+ `drops.test.ts`); exports in `content/index.ts` / `balance/index.ts`.
- **Render/audio:** the `'affix'` case + `THEME.colors.pickupAffix` in `game/Game.ts`; the `'pickup.affix'` cue in `platform/types.ts` + `WebAudio.ts` + `Game.consumeEvents`.
- **Done when:** no `affix`/`Affix` symbol remains, tests green, replay regenerated, version bumped.

### 0.2 ✅ 🔴 Intrinsic rarity (03/09/14) — *after 0.1* — DONE (additive, no bump)
Rarity becomes a fixed weapon property, not a roll count.
- Add `balance/rarity.ts`: `RarityTier = 'common'|'fine'|'epic'|'legend'|'legendary'` (白蓝紫橙金) + `RARITY_TIERS` quality multipliers (a *small* edge — design/14).
- Add `rarity: RarityTier` to `WeaponSpec`/`WeaponSimSpec` (`content/weapons.ts`, `state/entities.ts`); apply the quality mult at build/convert time.
- **Done when:** every weapon has a rarity, HUD/compare-card can read the tier colour (🟢 render side).

### 0.3 ✅ 🔴 Run-buffs = the in-run power layer (14/09) — *after 0.1* — DONE (v10→11)
Replaces affixes as the moment-to-moment power fantasy (design/05).
- Add `balance/runbuffs.ts`: `RUN_BUFFS` families (`mult_damage`/`mult_firerate`/`flat_hp`) + `BUFF_CAPS` (Σ-then-clamp, fixed order — deterministic).
- Player-level buff stack (reuses the slot the deleted `affixes: Affix[]` freed); a `'buff'` pickup kind; apply to player/all weapons.
- **Done when:** a buff pickup measurably changes stats, summed-and-clamped, replay-stable.
- **Follow-up, done later (`ENGINE_VERSION` 26):** the fourth family, `crit_chance`, originally deferred here because it needs a hit-time PRNG draw — shipped once `combatPrng`'s "only draw when it matters" hard wall (design/07) was wired through `WeaponFireSystem`/`HitResolveSystem`. See design/07's crit section.

### 0.4 ✅ 🔴 Two-pool health: shield + regen + shield-break (02/05/07/08/09) — DONE (v11→12)
Designed as decided, but `Actor` today has only `hp/maxHp`.
- Add `shield`, `maxShield`, `ticksSinceHit` to `Actor` (`state/entities.ts`).
- `takeDamage`: shield-first absorb (incl. DoT), resets `ticksSinceHit`, emits `shield_break` on depletion (`HitResolveSystem.ts`, `StatusEffectSystem.ts`).
- Idle regen: `SHIELD_REGEN_DELAY` ~3 s / `SHIELD_REGEN_INTERVAL` ~10 s in `config.ts`; +1 in the step-8 regen sub-pass.
- Add `shield_break` (and `shieldRemaining` on `hit`) to `GameEvent` (`state/events.ts`).
- **Done when:** shield absorbs before HP, regen gated by recent hits, break fires an event; version bumped.

### 0.5 ✅ 🔴 Character = SkinDef defensive identity (02/09/13/14) — *after 0.4* — DONE (v12→13)
Turn the single `PLAYER` into the roster model.
- `SkinDef { id, atlasKey, animRef, maxHp, maxShield, shieldBreak? }` + `ShieldBreakPassive` (`{kind:'aoe'|'knock', …}`) as tagged data (`content/skins.ts`).
- `PLAYER_BASE` shared constants (radius, speed, `WEAPON_SLOTS=2`, starter pistol id, regen/revive timings); merge SkinDef + base into `PlayerActor` at match start.
- Interpret `shieldBreak` in combat on the `shield_break` event (spawn AoE / knock impulse); guard against recursive break.
- **Done when:** ≥1 non-default character selectable with distinct (maxHp,maxShield)+passive; side-grade balance test stub exists.

### 0.6 ✅ 🔴 Pickup taxonomy → design/09 names — *after 0.3* — DONE (v13→14)
Code uses `'health'|'coin'|'affix'|'weapon'`; design says `'heal'|'material'|'buff'|'weapon'`.
- `'coin'` → `'material'` with `MaterialDef { id, element, tier }` + qty; `'health'` → `'heal'` (flat +1 HP); `'affix'` → `'buff'` (from 0.3); keep `'weapon'`.
- Update `PickupKind`, `DeathDropsSystem`, `PickupSystem`, drop tables, and the render/audio cue names.
- **Done when:** drops speak the design vocabulary; materials are a distinct (not-yet-banked) currency.

### 0.7 ✅ 🟢 Doc reconciliation pass — DONE
Swept the docs so "shipped" claims match reality (this pass):
- Marked shield/two-pool as actually-shipped (07/08).
- Recorded post-sync `ENGINE_VERSION` (14) and per-feature ship versions across 03/07/08/09/14.
- Noted the affix removal + rarity/run-buffs/characters/pickup-vocab as done (03/09/14).

---

## Phase 1 — Close the in-run loop (build the missing chain)

The core PvE loop (floors → extraction → bank) is fully designed (05/09) and fully built, including generated multi-room floors.

- **1.1 ✅ 🔴 Frame library** beyond `straight` (design/03 landing order) — DONE (`ENGINE_VERSION` 14→15, then 15→16 for the tier-4 finish). Shipped: `spread` emission (WeaponFireSystem, combatPrng jitter), `homing`/`lob`/`beam`/`boomerang` ballistics (`content/ballistics.ts` + `ProjectileStepSystem`/`HitResolveSystem`), melee `hammer`/`spear` frames (pure data — `MeleeSimSpec` was already generic). Then the tier-4 finish (`ENGINE_VERSION` 15→16): `orbit` ballistic (a projectile that circles its owner, tracking the moving owner each tick — new `Projectile.ownerId`/orbit fields + `orbitStep`) and `radial` emission (a PRNG-free even ring; `RangedSimSpec.pattern` = `'spread'`|`'radial'`, `'spread'` the byte-identical default). Nine showcase weapons in the drop pool (scattergun/seeker/mortar/lasercutter/tomahawk/hammer/spear + novaburst/gyre). **`k_*` on-hit procs done too (`ENGINE_VERSION` 28)**: `k_lifesteal`/`k_ricochet`, two more showcase weapons (leech/carom), plus a real adjacent bug found and fixed (`piercing` was authored since Stage C but never wired — see design/03).
- **1.2 ✅ RoomState collision geometry** (07/09) — DONE, additive (no `ENGINE_VERSION` bump). AABB tile/wall solids (`state.walls`, `MovementSystem`/`ProjectileStepSystem`) + the `RoomPiece` schema + `roomGeometry()` converter (`content/rooms.ts`).
- **1.3 ✅ Seeded dungeon assembly** (05/09) — DONE, additive (no `ENGINE_VERSION` bump). `world/dungeon.ts DungeonConfig` + pure `generateFloor()` (floors × rooms via `roomgenPrng`, `layout:'linear'`|`'branching'`) + a first hand-authored `RoomPiece` library (`world/rooms/ember.ts`, 5 normal + 1 extraction + 1 boss
— the 5th normal piece, `ember_atrium`, and the extraction/boss pieces' full 4-exit symmetry were
added 2026-08-05's "graph2d content" pass, Room & door model section below). **Wired into a live, traversable run** (2026-07-24, same day, commits `4d05555`/`aac5829`/`7a611e4`): `EngineConfig.dungeon = {config, library}` opts a run in; `SpawnSystem.tickDungeon` calls `generateFloor` per floor and `loadRoom` per room (swaps `state.walls`/`state.obstacles` via `roomGeometry()`, rebuilds the spatial index, repositions players, loads the room's `WaveScript`), `ExtractionSystem.resolveDescend` resets the room cursor so the next floor regenerates lazily, and `expandEncounter`/`dispatchDueSpawns` interpret `WaveScript`'s `atTick`/`spacingTicks` timing (shared with the PvP arena spawn path). Branching layout picks the next room by aim direction. Covered end-to-end by `dungeonrun.test.ts` (room load/advance/descend/branching/determinism/a full Ember-biome run) driven through `createGameEngine`, not just `dungeon.test.ts`'s pure-function unit tests. The real client (`Game.ts`) already builds every single-player/co-op/online run with `EngineConfig.dungeon: {config: EMBER_DUNGEON, library: EMBER_ROOMS}` — this is the live path, not a demo fallback.
- **1.4 ✅ Extraction rooms** (05) — DONE. `EngineConfig.floors?` (the flat, non-dungeon mode — same single arena reused every floor, still supported for configs that opt into it) OR `EngineConfig.dungeon` (the room-generated mode, see 1.3) opts a run into the checkpoint loop; `ExtractionSystem` (step 12) resolves the per-floor checkpoint (`wavesExhausted && enemies.length===0`) into `EXTRACT` or `DESCEND` (in dungeon mode, regenerates the next floor's rooms; in flat mode, reloads the next floor's flat wave list). Death forfeits the floor buffer for free (a run-ending death simply never reaches the bank step). The last floor has no `DESCEND` option, but otherwise resolves the same explicit-gesture way as any other floor (design/05 "the boss room IS its extraction room" — see the Live-play bug-fix pass entries below for why the original no-gesture auto-resolve was dropped 2026-08-12). **The gesture itself was rewritten 2026-08-02** (see that entry below): originally a sustained-INTERACT hold=EXTRACT/tap=DESCEND (mirroring the revive channel), now two explicit one-shot `Button.CONFIRM_EXTRACT`/`CONFIRM_DESCEND` presses driven by a world-space portal + popup, `ENGINE_VERSION` 31.
- **1.5 ✅ Materials carry-out** (05/09) — DONE, additive. `state.floorMaterials` (this floor's un-banked buffer, filled by `PickupSystem`) merges into `state.bankedMaterials` (the run's only carry-out) on every `EXTRACT`/`DESCEND`. `rollDrop` gained an optional depth `tier` param (`DeathDropsSystem` passes `state.floorIndex`) so a material pickup/event carries a rolled instance tier — first-pass "material quality shift per floor" (a straight `tier = floorIndex` identity curve; `DungeonConfig.materialTierByDepth` remains an unused schema field for a future non-identity curve).

**Phase 1 status: fully closed, including live multi-room floors.** A run goes floors → checkpoint → EXTRACT-or-DESCEND → bank, with materials as the only carry-out. Both modes are real and tested: `EngineConfig.floors` (flat, single-arena-reused-per-floor, still available for configs that want it) and `EngineConfig.dungeon` (generated multi-room floors via `generateFloor`/`RoomPiece`/`placeFloor`, `'branching'` layout, `WaveScript` timing) — the latter is what the real client actually uses for every live run. Nothing from 1.2/1.3 is unwired or demo-only. **2026-08-04 update:** "room-to-room traversal" here no longer means the original sequential swap-on-clear — see the "Room & door model" section below (design/05, `ENGINE_VERSION` 34): a floor's rooms are now co-resident and door-connected, freely walkable/backtrackable, with combat-derived door locking and force-regroup. **2026-08-05 update:** `'branching'` layout now places a real fork-and-reconverge diamond of sibling rooms instead of resolving at generation time (`ENGINE_VERSION` 35, same section). **2026-08-05 update (same day): the west→east-spine scope cut is closed too** — a new `layout: 'graph2d'` (`world/dungeon.ts placeFloorGraph2d`, additive, no `ENGINE_VERSION` bump) places a *generated* floor in real 2D instead of forcing it onto a single axis; see design/05's "Room & door model" section for the full account. **2026-08-05 update (same day, "graph2d content" pass): `EMBER_DUNGEON` now uses `'graph2d'`** (was `'linear'`) — a new `ember_atrium` piece and wider exit authoring on `ember_pillars`/`ember_extraction`/`ember_boss` make the shipped biome actually bend, and a new `placeFloorGraph2d` direction-retry (found necessary by testing, not inspection — full account in `world/rooms/ember.ts`'s module doc) makes that safe against fold-back overlaps. `'branching'` still stays unused by any shipped config.

## Phase 2 — Close the meta loop ✅ (2026-07-24)

- **2.1 ✅ Forge outpost** (14/09): blueprint unlock (permanent) + per-run craft from materials. Recipes are `element × qty × min-tier` — and **`minTier` is now enforced**: the material bank keys by (element, rolled tier) via `bankKey` (additive, no bump — tier 0 keeps the flat key), so a premium recipe (e.g. emberblade: fire×2 minTier 1) genuinely demands materials from deeper floors; spending is lowest-qualifying-tier-first.
- **2.2 ✅ Loadout screen** (10): up to 2 crafted weapons carried into a run via `EngineConfig.loadout`; none → auto pistol. Lives in the demo forge outpost (`game/Forge.ts`).
- **2.3 ✅ Character roster + select** (14/09/13): the **3 launch characters** ship — vanguard (6/4), skirmisher (3/8), juggernaut (9/0, the flat-HP tank). Full side-grade balance suite (`skins.test.ts`): Pareto-non-domination, per-axis spread, equal-worth budget band, no inert passive on a zero-shield body. All free for now (paid split is the store's job).
- **2.4 ✅ Monetization scaffolding** (14): direct-purchase blueprint/character grant APIs (`acquireBlueprint`/`grantCharacter`/`purchasableBlueprints`), no gacha. Real billing is deliberately out of scope (a platform adapter would call these after its own payment flow).

**Deferred out of Phase 2 (not blocking the loop):** touch/WeChat forge input (web-keyboard only today); the outpost's real art (design/13 → Phase 5 art pipeline) — **shipped 2026-08-01, NPC included as of 2026-08-02, see 5.3's update below**; a real billing adapter.

## Phase 3 — Co-op & netcode

- **3.1 ✅ Net layer** (06) — DONE (additive, no `ENGINE_VERSION` bump). The engine now **spawns the SECOND player**: `EngineConfig.players?: PlayerConfig[]` builds one seat per entry (owner index = array index), so 3.2's revive/downed/team-wipe machinery finally runs against a REAL two-seat match through `GameEngine.step()` (`state/coop.test.ts`), not a hand-synthesised player. Single-player is byte-identical (an absent `players` list → the same one-seat construction; golden replay unchanged — additive). The netcode (design/06 migration step 6): `@dd/engine/net` holds the shared wire protocol, `NetInputSource` (confirmed frame-stream + jitter cushion + catch-up), and `FrameBroadcast` (the pure server relay core); the new **`server/`** package is the thin WebSocket shell around it (`MatchRoom`/`RoomManager`, injected clock+sockets, unit-tested with fakes); the client **`CoopSession`** drives the engine off the confirmed stream. Proven end-to-end by loopback tests — `FrameBroadcast → NetInputSource → engine` and the full client↔server `CoopSession` loop both reproduce a plain replay **byte-for-byte**. **Live N-player render is wired + browser-verified**: the render layer follows the LOCAL seat (Scene `localPlayerId`, Game `localOwner` — no more hardcoded `players[0]`), and a `?coop=1` dev toggle brings a bot ally (`AllyController`) as a real second seat via `EngineConfig.players`, driven through the same submit path a networked teammate uses — confirmed in-app (2 player views, distinct characters, camera on the local seat, co-op HUD row, single-player unchanged). *Deferred (design/06 open Q, needs real-RTT tuning): local-player prediction/reconcile smoothing — co-op PvE is latency-tolerant and playable on the confirmed-stream + catch-up path alone, so prediction is a render-loop latency-hiding layer that slots on top without changing the confirmed path.*
- **3.2 ✅ 🔴 Co-op revive/downed + team-wipe end** (05/07) — DONE (`ENGINE_VERSION` 16→17). Design decisions resolved + recorded in design/05: **unlimited revives** gated by a per-downed **bleedout timer** (no hard count); **downed players are invulnerable** (only bleedout or a team wipe ends them; the revive channel pauses bleedout so a committed rescue always completes); a **team wipe** (no player "up") ends the run and forfeits the whole un-extracted carry-out. A lethal hit → `downed` (DeathDropsSystem); new `ReviveSystem` (step 13) runs bleedout + the sustained-INTERACT channel; `WinConditionSystem` reads `alive && !downed`. Downed players are skipped by every targeting system (`isDowned`). Single-player is unchanged in outcome (down = instant run-end).
- **3.3 ✅ Matchmaking / deployment control plane** (06) — DONE (additive, no `ENGINE_VERSION` bump). The front door 3.1 deferred: two real players are now **matchmade** into a room instead of hand-sharing a `roomId`, and the gameserver trusts a **signed ticket** instead of raw query params (closing the seat/seed spoof hole `server/src/index.ts` named). Mirrors the repo's pure-core + injected-deps pattern: **`server/src/ticket.ts`** (stateless HMAC-SHA256 sign/verify over `{roomId,owner,seed,playerCount,exp}`) + **`Matchmaker.ts`** (pure queue: `enqueue`→group-when-full→signed tickets, `poll`; injected clock/seed/roomId/signer) + **`matchsvc.ts`** (the HTTP shell, own port 8788: `POST /find` → `GET /find/:id`). The **`/ws` handshake** now verifies `?ticket=` and derives the trusted params from it; a real `DDU_TICKET_SECRET` makes the ticket mandatory (invalid/absent → `4401`), unset keeps the legacy raw-param handshake for local dev. Client: **`net/matchmaking.ts`** (headless poll client, injected fetch/sleep) + a `?online=1` toggle that runs matchmaking → `WebSocketTransport(?ticket=)` → `CoopSession` live in `Game.ts` (the online counterpart to `advanceSim`; `buildConfig` derives an identical N-seat config from seed+playerCount, seats skinned by index for cross-client determinism). **Browser-verified two-tab end-to-end**: two independent tabs (`?online=1`, no shared roomId) matchmade into one room with distinct ticket seats (owner 0/1), built the identical engine (same seed, same 2 characters), and ran **byte-identical lockstep** — both independently reached `gameover` at the *same* tick with identical final state; a tampered/empty ticket is closed `4401`. Unit: `ticket`/`Matchmaker` (server) + `matchmaking` (client).
- **3.3-follow-up ✅ Local-player prediction / reconcile smoothing** (06) — DONE (additive, no `ENGINE_VERSION` bump; render-only). The last deferred co-op item. A **render-layer** predictor (`client/src/game/controllers/LocalPredictor.ts`) draws the local seat's **movement + aim** ahead of the confirmed frame stream (dead-reckon at the sim's own speed) and eases back on each confirmed frame — **snap** above `snapPx` (teleport/room transition), **lerp** by `correctionGain` below (design/06's now-resolved snap-vs-lerp knob). Wired into `Game.advanceOnline` (reconcile only on a new confirmed tick; suspended when downed) via a new `Scene.positionLocal`; the **sim is never touched**, so lockstep stays byte-identical (local **firing** stays sim-confirmed — no GameState rollback, the path design/06 rejects for casual/WeChat). A `?lag=<ms>` `LaggyTransport` harness injects synthetic RTT to feel/tune it. Unit: `localpredictor.test.ts` (zero-lag tracking, leads-under-lag, convergence, snap/lerp). **Browser-verified two-tab @ `?lag=150`**: predicted pose leads the confirmed position by ~83px under lag and converges to 0 when confirmed catches up, while both tabs stay byte-identical to a shared gameover tick.

**Update (2026-08-04): two real bugs in the shipped co-op/prediction path, found by a full client code review rather than by feature work.**
1. **Mid-match reconnect was never actually reachable, even though the wire protocol/server logic for it had existed since 3.1.** `MatchRoom.resume()`/`conn_resync` and `NetInputSource.resumeFrame()`/`onConnResync` were all real and tested — but nothing on the client ever called `resume`, `CoopSession` had no way to swap in a new transport, and the gameserver's own connection handshake unconditionally called `join()` first, which rejects any socket for a room already `IN_MATCH` — so even a client that DID send `resume` would have been closed `4403` before that message could ever be read. A dropped connection (Wi-Fi hiccup, a backgrounded WeChat tab, a server restart) therefore just froze the match forever with no error and no recovery. Now wired end-to-end: `matchsvc` gained `POST /resume` (mints a fresh short-lived ticket for the same seat, verifying the caller's OWN now-expired original ticket's signature rather than trusting a bare roomId/owner — the original ticket's 30s TTL is far shorter than a real match, so it can't be reused directly); the gameserver's `/ws` handshake now detects an existing `IN_MATCH`/settled room and waits for an explicit `resume` message instead of always trying `join()`; `CoopSession.reconnect(transport)` swaps the live transport without touching engine/`NetInputSource` state (`conn_resync` folds into the existing confirmed-stream catch-up path — the same mechanism a merely-backgrounded tab already used); a new bounded retry driver (`net/reconnect.ts`) drives the whole resume-ticket → reconnect → retry-with-backoff sequence, surfaced to the player via HUD toasts (`toast.reconnecting`/`toast.reconnected`) and a real "CONNECTION LOST" result screen if every attempt is exhausted — previously that failure mode was a silent, permanent freeze.
2. **The local player's own walk animation never played while online prediction was active** — `Scene.positionLocal`'s snap-to-predicted-pose (needed so the camera/sprite show the render-ahead position with no lerp) also collapsed the interpolation buffer every render frame, and `Actor.interpolate`'s idle/move clip choice was derived purely from that buffer's delta — so the local seat's rig looked permanently idle (feet never moving) the entire time it was actually running, while every remote seat/enemy animated correctly. Fixed with an explicit `Entity.movingOverride` signal (`LocalPredictor.pose.moving`, true whenever that frame's predicted displacement was nonzero) that survives the snap; reset to "derive from the buffer as before" on the next ordinary `pushState()` so nothing changes for any non-predicted entity.

Both were real user-facing gaps in already-"fully closed" Phase 3 functionality, not new work — see the Client hardening pass section below for the rest of this review's findings. 34 new/extended tests across `CoopSession`/`net/reconnect.ts` (new)/`net/matchmaking.ts`/`onlineConnect.ts` (client) and `ticket.ts`/`matchsvc.ts`/`MatchRoom.ts`/`RoomManager.ts` (server), plus `Scene`/`Actor`/`LocalPredictor` for the animation fix. `tsc --noEmit` clean on client + server throughout.

## Phase 4 — Close PvP (battle royale)

**4.1 ✅ DESIGN — DONE (2026-07-25).** PvP is **8-player solo battle royale**: elimination + room-graph shrinking zone (not a symmetric team arena), AI reused verbatim from PvE as hazard-and-farm hostile to every seat, one ~60-room hand-authored map from a dedicated map editor, arena-scoped loot (same drop *model* as PvE, zero account connection), squads/revive as a reserved-not-built interface. Full spec: `design/15-pvp-arena.md`. This replaced the original "3v3/4v4 + fixed preset loadouts" framing in `05` — see its PvP section and `15` for the current locked shape.

The original draft of this phase had one line — "`ARENA_PRESETS` + `buildArenaSpecs`" — standing in for 4.2. Turning **4.1's actual decisions** into an engine meant finding real prerequisite work the one-liner hid: a team/hostility model PvE never needed (players cannot currently damage each other at all), and a world model that has to hold ~60 rooms **simultaneously co-resident**, not PvE's model of visiting rooms **sequentially** (PvE's 5–10-rooms-per-floor × 5-floors-per-run design, `05`, is not "one room" either — the engine just loads one room *live* at a time, hard-swapping to the next on transition, which is a perfectly sufficient shape for "clear this room, then the next"). Both prerequisites are called out as their own items below, ahead of the arena-specific build.

- **4.2a ✅ 🔴 Team/hostility refactor** (15) — DONE (`ENGINE_VERSION` 17→18). Added `teamId: number` to `Actor`/`Projectile` (`state/entities.ts`, independent of seat `owner`) + `ENEMY_TEAM_ID = -1` + a single `isHostile(a,b) = a.teamId !== b.teamId` predicate, plus a new shared `systems/targeting.ts` (`hostileTargets`/`nearestHostile`, downed-player-excluding, deterministic player-then-enemy order). Replaced every `faction === 'player' ? enemies : players` ternary (`HitResolveSystem` main hit loop/lob-blast/beam/bullet-clash/melee-arc, `DeflectSystem`, `ProjectileStepSystem`'s homing, `combat.ts`'s shield-break foe pool — `nearestAliveEnemy`/`nearestOpposing` deleted as dead code once their callers moved to the shared helpers). **Default is a SHARED team 0 for every seat** (`PlayerConfig.teamId ?? 0`, `GameState.buildSeat`) — existing single-player/co-op stay byte-identical in which (bullet,target) pairs are even tested; a PvP arena build (4.2c) will assign each seat its own teamId instead. Bump reasoning (config.ts's version-history comment has the full account): bullets/melee/deflect can now reach ANY hostile actor including a rival player once a config opts in, and two incidental latent-bug fixes ride along (bullet clash was faction-equality gated, so two hypothetically-hostile players' bullets never used to clash; the lightning-chain/lob/beam target pool now uniformly excludes downed players via the shared helper, closing a gap the old raw `state.players` chain-group had). New test file `systems/teamHostility.test.ts` (isHostile unit test + co-op-default no-friendly-fire regression + cross-team bullet/melee/deflect/clash/homing). 302 client + 26 server tests green, typecheck clean, golden-replay self-consistency tests unaffected (no hardcoded fixture in this repo — they compare two fresh runs).
- **4.2b ✅ DONE — World/broadphase for a co-resident multi-room map** (15). `systems/spatialGrid.ts`'s `UniformGrid` (cell size 4 grid units, 1-grid query padding — both discussed/locked with the user, not guessed) indexes `state.walls`/`state.obstacles`; `MovementSystem`/`ProjectileStepSystem` now query it instead of scanning linearly, candidates always sorted ascending by original array index (preserves the existing "iterate in fixed array order" determinism contract). Applied uniformly to PvE AND PvP — no mode branching (the user: sim always computes full-map for lockstep; only rendering culls to the current room). The stitcher half: `content/arenas.ts`'s `ArenaMap`/`ArenaRoom`/`Door`/`CellTrait`/`EyeCandidate`/`LootMarker` schema + `buildArenaGeometry(map)`, placing every room at its own `rectGrid` offset (reuses `roomGeometry`, widened to `Pick<RoomPiece,'solids'|'pillars'>`) into one co-resident world; `GameState` gained `EngineConfig.arena?: ArenaMap` (additive, no `ENGINE_VERSION` bump). 19 new tests (`spatialGrid.test.ts` + `arenas.test.ts`).
- **4.2c ✅ DONE — Arena build wall** (09/14/15). `balance/build.ts`'s `buildArenaSpecs(presetId, skinId)` — arity 2 now (was 1; `skinId` is the fairness wall's one named exception, design/14/15, needed so the HP scale factor targets the right character) — applies `PVP_SCALE_FACTOR` (first-pass placeholder, design/15 leaves the exact number to real play) to a resolved `SkinDef`'s `(maxHp,maxShield)` and to a copied (never-mutated-shared) weapon spec's `damage`. One minimal `ARENA_PRESETS.landing_basic` entry. `build.test.ts` extended (6 tests); the arity hard-wall test now asserts "2, never a 3rd (meta) param" instead of "exactly 1."
- **4.2d ✅ DONE — Zone + `EnvironmentSystem`** (15). `systems/ZoneSystem.ts`: room-graph BFS shrink (`content/arenas.ts computeRoomDistances`, doors-graph, never inferred from `rectGrid` proximity) from a `ringPrng`-drawn eye; WARN→CLOSE→HOLD stage machine, `R_stage = maxDist - stage*shrinkStep`, final stage (R=0) loops HOLD forever incrementing `escalation` instead of shrinking further (the structural no-stalemate time bound). `systems/EnvironmentSystem.ts`: per-actor-per-tick room-membership cache (`actor.roomId`, O(1) amortized — early-outs if still inside its cached room) + zone damage (`takeDamage(...,'environment','physical')`, new `DamageSrc` type) + `CellTrait` damage (always-on, or phased via a pure `tick % period` cycle — no separate mutable per-trait state needed). Both strict no-ops outside arena mode (ExtractionSystem's existing "doesn't bump ENGINE_VERSION" precedent). `cellTraits`/room-rects pre-converted to Fp ONCE at construction (never `toFpGrid` inside the per-tick path). New `ringPrng` stream, new `zone_warn`/`zone_close`/`zone_damage` events. 18 new tests.
- **4.2e ✅ DONE — Placement/elimination win condition** (15). `WinConditionSystem` branches to a PvP `tickPlacement` path when `state.zoneEnabled`: records each eliminated seat's INDEX into `state.placements` (worst-first, winner never in the array — same "index into state.players" convention `Winner`'s doc comment already established); declares a winner the instant one seat survives; a same-tick zero-survivors tie breaks deterministically by ascending `teamId` (never a coin flip). Net: `MatchOver.reason` gained `'placement'` + optional `placements`; `MatchRoom.reportResult` takes an optional `placements` param whose PRESENCE (not any mode flag MatchRoom doesn't have) selects the reason. 6 new tests.
- **4.3 ✅ DONE — In-arena loot & AI** (15/09). `content/drops.ts`'s `ARENA_DROP_TABLE`/`rollArenaDrop` — weapon/buff/heal only, `material` structurally absent (not just zero-weighted); `DeathDropsSystem` branches on `state.zoneEnabled`. `SpawnSystem` gained a `tickArena` branch: per-room `ArenaRoomRuntime` (parallel array to `arenaMap.rooms`, never a Map) lazily activates a room's `encounter`/`lootMarkers` the tick a player's cached `roomId` first matches it (perf-only — the map ships bundled, so this is NOT information-hiding, per 15's honest anti-cheat-limit note) — a shared `expandEncounter` helper factors the WaveScript-expansion logic out of the existing dungeon path so both reuse it. `ArenaRoom` gained a `spawns?: SpawnPoint[]` field (design/15's shown schema omitted it, but `encounter.entries[].spawnPoint` needs something to index into). 15 new tests.
- **4.4 ✅ DONE — PvP anti-cheat: periodic checkpoints** (06/15, `ENGINE_VERSION` 18→19). New `ClientMsg` `'checkpoint'{tick,stateHash}`, sent by `CoopSession.drive()` every `CHECKPOINT_TICKS`. `MatchRoom.reportCheckpoint`: v1 cross-client majority vote (no new server simulation), quorum gate (`CHECKPOINT_QUORUM` = 3 real seats, below which no check runs), kick only after `INTEGRITY_KICK_STREAK` (2) CONSECUTIVE same-historical-tick mismatches (a clean report resets the streak) — `kickSeat` behaves like a forced disconnect, reconnect reuses the existing `resume` path. New `integrityPrng` stream, drawn once per tick unconditionally in `GameEngine.step`, never read by any gameplay system — `replay.ts`'s `serializeState` now hashes it (plus closes a coverage gap: `state.zone`/`state.placements` are now hashed directly too, previously only surfacing indirectly). Bumps `ENGINE_VERSION` on the "hash output moves, even with zero gameplay effect" precedent v17 already established. 15 new tests.
- **4.5 ✅ DONE — Sparse input sync** (06, net-layer only, no `ENGINE_VERSION` impact). `NetInputSource.submit()` skips resending a command whose `moveBrad`/`moveMag`/`aimBrad`/`buttons` are unchanged from the last one actually sent (aim's "changed" reuses the existing brad quantization — one mechanism, double duty). Receiving side: `heldByOwner`, updated strictly in frame order at ingest time so a snapshot for frame N is deterministic regardless of wall-clock burst timing; a boundary frame (or a whole pure-metronome pulse) with nothing fresh from a seat now HOLDS that seat's last command instead of going idle — the actual behavior change 4.5 needed (a steady joystick no longer needs to be "wiggled" to keep moving). Sets up a future state-sync payload swap for free (same hold-then-reconcile pattern `LocalPredictor` already uses). 5 new/updated tests in `netinput.test.ts` + 1 in `coopsession.test.ts`.
- **4.6 ✅ DONE — PvP ladder rating** (15, matchsvc-side, not `@dd/engine`). `server/src/rating.ts`: a simplified multiplayer Elo (`computeRatingDeltas` — actual = normalized placement, expected = logistic vs. field average) + in-memory `RatingStore`, zero dependency on `@dd/engine` (never touches replay/replicated state, by construction — the doc's explicit requirement). `matchsvc.ts` gained `POST /rating/report` / `GET /rating/:accountId`. `MatchRoom` gained an optional `onSettled` callback (fired with `{roomId,winner,placements,hashOk}` right before `destroy()`) — wired in `index.ts` to POST to matchsvc's endpoint, but ONLY when `hashOk` (4.4's checkpoint-verified gate) and `placements` are both present. `accountId` is an explicitly-labeled SCAFFOLD (`seat:{roomId}:{seatIdx}`) since this project has no account/auth system anywhere yet — the placement→rank math itself (`ladderReport.ts`) is real and fully tested. 11 new tests across `rating.test.ts`/`ladderReport.test.ts`/`MatchRoom.test.ts`.

**Phase 4 is now fully closed (4.1 through 4.6).** Final tally: 359 client tests (from 302 at the start of 4.2a) + 46 server tests (from 26), `tsc --noEmit` clean on both packages throughout. `ENGINE_VERSION` 17→19 (18 for 4.2a's team/hostility model, 19 for 4.4's `integrityPrng`+zone/placement hash coverage). What's explicitly NOT built: a real ~60-room hand-authored `ArenaMap` (needs the map editor, itself unbuilt) and a single "start a PvP match" entry point assembling `config.arena` + `config.players` + `buildArenaSpecs` together end-to-end — every 4.2-4.6 piece exists and is tested in isolation/via synthetic test maps, but nothing has driven a real match with them all wired together yet. `ARENA_PRESETS`/zone tuning numbers/the arena loot-table catalog are all explicitly first-pass placeholders per design/15's own "real play required" / "to design" callouts, not tuned values.

**Phase 4 closeout — end-to-end match assembly (2026-07-26): the "start a PvP match" entry point is now wired.** The gap above was narrower than "everything's stubbed": the sim-side PvP machinery was already real, tested, and even the net layer already generically carried `placements` — what was actually missing was the assembly/routing layer nobody had built yet. Added: a `mode: 'coop' | 'pvp'` (optional, default `'coop'` — every pre-existing call site/test is byte-for-byte unaffected) threaded end-to-end through the matchmaking stack — `Matchmaker` (mode-segregated queues, so a coop and a pvp request for the same seat count never group), `TicketPayload`/`MatchTicket` (signed into the ticket, so it can't be spoofed), `matchsvc.ts`'s `POST /find`, `MatchRoom`/`RoomManager` (mode rides in `match_start`, cross-checked on join same as seed/playerCount), and `client/src/net/matchmaking.ts`. Client: a real `?pvp=1` toggle (`?seats=` overrides the seat count for local two-tab testing, default 2; design/15's 8-seat ceiling still applies via `Matchmaker.MAX_PLAYERS`) that requests a `'pvp'`-mode ticket instead of `?online=1`'s `'coop'`; `Game.buildOnlineConfig` branches on `MatchStart.mode` to build an arena config (`ARENA_CATALOG` + one distinct `teamId` per seat) instead of the dungeon config; gameover handling branches on `state.zoneEnabled` to show a placement-based result (`VICTORY ROYALE` / `ELIMINATED — placed N/M`) instead of the PvE extract/wipe screens. Also fixed a real latent gap in the *existing* (already-closed) 3.3 online co-op path along the way: `CoopSession.reportResult` was fully implemented but never actually called by the client, so the server's checkpoint/hash-verified settlement — and therefore 4.6's matchsvc ladder-rating report — could never fire for a real match, coop or PvP; `Game.advanceOnline` now calls it on gameover.

Still not done, on purpose (scoped out of this pass, not forgotten): (1) the real ~60-room hand-authored map — `client/src/game/match/arenaCatalog.ts`'s `ARENA_CATALOG.landing_basic` is still the same small synthetic 3-room fixture the `?arenaDemo=1` dev harness used, standing in until the map-editor output (`tools/map-editor` / `world/arenas/`, in progress separately) is committed and has a loader; swapping it in is meant to be a one-line catalog addition, not a rewire. (2) `buildArenaSpecs`' HP-scale/loadout preset (4.2c) is still not called from `Game.ts` — its `ArenaBuildResult` (pre-built `WeaponState`s + scaled `maxHp`/`maxShield`) doesn't map onto `PlayerConfig`'s `loadout: readonly string[]` (weapon ids) or a bare `skinId`, so a PvP run today uses each seat's plain unscaled `SkinDef` stats — wiring the `PVP_SCALE_FACTOR` in needs a `PlayerConfig` extension (or an equivalent construction-time seam), a deliberate follow-up rather than a guessed API. Both are scoped, not silently dropped.

**Update (same day): (1) is done too.** `world/arenas/arena_prototype_60.json` landed (a separate concurrent session, commit `ff0831f`) — a real, validated 60-room map whose schema matched `ArenaMap` exactly, so the "one-line catalog addition" prediction above held. `client/tsconfig.json` gained `resolveJsonModule`; `arenaCatalog.ts` imports the JSON directly and adds `ARENA_CATALOG.arena_prototype_60`; `Game.buildOnlineConfig`'s pvp branch now resolves to it (`landing_basic` stays only for `?arenaDemo=1`). Browser-verified two-tab: both clients built an identical 60-room/134×86 config off the real map, zero errors.

**Update (same day): (2) is done too — Phase 4 has no open items left.** `GameState.buildSeat` (`ENGINE_VERSION` 19→20) now branches on `config.arena`: an arena seat's weapons/`maxHp`/`maxShield` come from `buildArenaSpecs(config.arenaPreset ?? 'landing_basic', seat.skinId)` — the scaled landing kit + body stats — and `seat.loadout` (persistent PvE gear) is structurally never read for it, enforcing the fairness wall at construction rather than by caller convention. `EngineConfig` gained an optional `arenaPreset?: ArenaPresetId` (one preset per match, default `'landing_basic'`, today's only entry). Bumped because this is a real gameplay-affecting change to every arena config's player numbers, not just hash bookkeeping — every PvE/co-op config (no `arena`) is byte-identical. New `GameState.test.ts` coverage (arena seat gets scaled stats + ignores loadout, scales the RIGHT skin, non-arena seat unaffected). Browser-verified two-tab: both clients showed identical scaled stats (vanguard 6/4→30/20, skirmisher 3/8→15/40, blaster damage 1→5, matching `PVP_SCALE_FACTOR=5`), zero errors.

**Update (2026-07-28): a repeatable data source for the still-first-pass `PVP_SCALE_FACTOR`/zone numbers now exists — the numbers themselves are still not re-tuned.** `client/sim/pvpBalanceSim.sim.ts` (run via `npm run test:pvp-sim`, deliberately kept OUT of the default `npm test` glob — ~6s for 180 real matches, too slow to tax every default run) drives `createGameEngine`+`PvpBotController` directly, no MatchRoom/socket/CoopSession involved (a gameplay-outcome question, not a net-layer one) — `buildPvpEngineConfig` is the SAME function a real match/`BotClient` uses, so no hand-mirrored second config path. Sweeps seat counts 2/3/4/5/6/8 × 30 seeds each (180 matches), asserts every match converges (no `MAX_TICKS` timeout — a real regression check on the zone's own no-stalemate structural bound) and that `placements.length === playerCount-1` holds (ties tracked, asserted rare), then reports win-rate-by-character + avg-match-duration/max-zone-stage-by-seat-count. First run's actual numbers (deterministic, reproducible): 180/180 converged, 0 ties, win rate vanguard 60/juggernaut 30/skirmisher 90 — a real, sizeable skew worth a human look, **caveated in the file itself**: `buildPvpEngineConfig` skins seats BY SEAT INDEX not by seed, so a seat/spawn-position advantage at any single seat count would confound a naive read of this; sweeping seat count 2→8 only dilutes that confound, doesn't remove it. Treat as a first signal to sanity-check against real playtesting, not a tuning verdict — no `PVP_SCALE_FACTOR`/zone constant was changed off this run.

**Update (2026-07-29): the "squads/revive as a reserved-not-built interface" line in 4.1 is now built — `ENGINE_VERSION` 29→30.** design/05/15's long-deferred squad follow-up, scheduled after the user decided its three open questions (squad size 3-4, landed as `SQUAD_SIZE=4`; pre-formed party via invite code, not auto-grouped or a real friends list; revive gated by a consumable bandage, not PvE's free channel). Discovered along the way that this repo has no account/identity system anywhere (`ladderReport.ts`'s `accountId` was already a documented scaffold) — built a minimal one (client-generated random id, `net/identity.ts`) rather than scale the feature down. Shipped: `server/src/PartyService.ts` (in-memory create/join/leave/start, `/party/*` routes in `matchsvc.ts`) + `Matchmaker.ts`'s seat assignment reworked around a `pullChunk` helper that groups a pre-formed party's waiters into one squad chunk wherever each sits in the queue, backfilling with solo queuers otherwise (byte-identical to the old FIFO when nobody uses a party); `teamIdForOwner(owner, playerCount)` (`client/src/game/match/pvpConfig.ts`) is the single pure-function source of truth for squad assignment, shared by the server (`@dd/game/pvpConfig` alias, the same one `BotClient.ts` already used for `buildPvpEngineConfig`) and the client, so a seat's squad is never in question regardless of who ends up in it; `WinConditionSystem.tickPlacement` now groups elimination by squad; `ReviveSystem` requires same-`teamId` + a spent bandage in PvP; downed is no longer invulnerable in PvP (`targeting.ts`, gated by `state.zoneEnabled`); a new `PartyScreen.ts` lobby (create/join/roster/start) reachable from a new MainMenu SQUAD button, plus a `TextInputOverlay.ts` DOM-input widget for the join code (Pixi has no native text entry). A real bug caught by `npm run test:pvp-sim`'s convergence check, not by unit tests written for the same code: the first cut of the squad-size formula let a `playerCount === SQUAD_SIZE` match (e.g. exactly 4 seats) collapse into ONE squad covering everyone — unable to ever fight itself — fixed by requiring at least 2 squads before squads apply at all. 538 client tests (was 439) + 78 server tests (was 70), both `tsc --noEmit` clean, `pvp-sim` still converges (180 matches, 0 timeouts, 6 ties). Live-verified end-to-end (create → real second identity joins by code → leader's poll picks up the new member → start → real `/find` queue entry) via `window.__game`, not a screenshot (still times out in the sandboxed preview pane) — see design/05/15 for the updated locked shape. Explicitly not built (at the time): real WeChat-account/openid identity, native invite sharing, squad-aware ladder rating, or a rebalance of `PVP_SCALE_FACTOR`/zone numbers for the new squad shape.

**Update (2026-08-04): a real squad-win scoring bug, found by a full client code review (not by feature work).** `RunOutcome.handle`'s PvP-arena branch compared `s.winner === this.host.localOwner` by exact seat equality — but `WinConditionSystem.tickPlacement` (design/15's squad follow-up) sets `state.winner` to a single REPRESENTATIVE seat of the winning squad (its lowest seat index), not to every winning seat, and strips the *entire* winning squad out of `state.placements`. So in any squad match where the winning squad had more than one surviving member, every winner except the one seat literally named in `state.winner` failed the equality check, fell into `loseArena()`, found themselves missing from `placements` (correctly, since their whole squad was never pushed there), and were shown "ELIMINATED — Placed N/N" (last place) despite having just won. Existing tests never caught it because every PvP fixture up to now happened to give each seat its own distinct `teamId` (no real multi-seat squad ever exercised the win path). Fixed by comparing TEAM membership (`s.players[localOwner].teamId === s.players[s.winner].teamId`) instead of seat identity. 1 new test (a shared-`teamId` winning pair, local seat NOT the one named in `state.winner`).

**Update (2026-08-03): squad-aware ladder rating is done too.** The one item above that was pure code (not blocked on hardware/licensing/design-tuning). `server/src/ladderReport.ts`'s `buildRatingReportBody` gained a required `playerCount` param — needed because `state.placements` only ever lists *losing* squads' seats, so a squad win previously reported just the one named `winner` seat and silently dropped its 1-3 teammates from the ladder entirely; every seat sharing the winner's `teamId` is now filled in as tied for 1st. `server/src/rating.ts`'s `computeRatingDeltas` gained an optional `teamIds` param: with it, a squad's ACTUAL score comes from its team rank (not each member's individually-adjacent place) and its EXPECTED score compares the squad's AVERAGE rating (not each member's own) against the field average, so every squadmate gets the identical delta. Omitting `teamIds` (every solo/FFA match, squad size 1) degenerates back to the original per-seat formula byte-for-byte. See design/15's Ladder rating section for the full account. 14 new tests (`rating.test.ts`/`ladderReport.test.ts`/`MatchRoom.test.ts`, plus 5 real-HTTP-wire tests added to `matchsvc.http.test.ts` for the `/rating/report`/`/rating/:accountId` routes, which had zero coverage anywhere before this pass), 158 server tests total, `tsc --noEmit` clean, `PVP_SCALE_FACTOR`/zone rebalancing still not done (needs real playtesting judgment, not a code gap).

## Phase 5 — Presentation & platform

- **5.1 Audio finish** (11): ✅ event→sound seam + a procedural/synthesised voice-table backend ship on BOTH web and WeChat (`wx.createWebAudioContext()`, feature-detected, 2026-07-26) — no asset files, no licensing needed for this half. Still open: real authored SFX/music/ambience (needs sourcing + a licence check — the owner's to do, not a tooling gap) + real-device verification of the WeChat fallback path (5.5).
- **5.2 UI/HUD** (10): ✅ shipped 2026-07-26 — real Pixi widget kit (`Panel`/`Bar`/`ToastQueue`/`Button`/`Slider`), a real in-match HUD, settings screen (SFX/music/master volume + mute), PvP room-graph minimap, forge + ground-pickup compare cards. **2026-07-27: the two remaining items shipped too** — a real in-run pause menu (`game/PauseMenu.ts`, ESC/settings-button entry point) and a real PvE floor-progress minimap (`game/ui/Minimap.ts`/`FloorProgress.ts`, distinct from the PvP room-graph shape — tracks dungeon room-to-room progress, not a synthetic `?arenaDemo=1` stand-in). Nothing open in 5.2.

**2026-08-05: three real touch/WeChat input gaps closed, found by cross-checking the actual
code rather than trusting this doc's own "nothing open in 5.2" claim** (same "don't trust
ROADMAP checkmarks in isolation" instinct earlier passes in this file have already needed).
All three were self-documented in the code itself (a comment admitting the gap) or a silent
missing `Button` where every sibling action already had one — not new design work, no
`ENGINE_VERSION` impact (render/input-only), all additive.
1. **Touch/WeChat players could never revive a downed teammate** — `TouchControls.read()`
   hardcoded `interacting: false` unconditionally, with no on-screen control at all
   (`ReviveSystem` reads it as a sustained hold, exactly like the keyboard's `KeyE`/`Space`).
   The extraction/descend gesture this same field used to ALSO gate was unaffected — it
   already moved to `PortalPrompt`'s own tappable `Button`s (design/10, 2026-08-02), which
   touch could already reach. Fixed: a third corner button, `TouchControls.ts`'s
   `interactBtn` (held, not tapped — same shape as the fire zone), rendered in
   `TouchControlsView.ts` tinted `pickupHeal` green with a `+` label so it reads as a
   distinct "supportive" action, not another weapon-swap tap. `TouchVisual` gained an
   `interact` field; `hasActiveTouch()`/`getVisual()` updated to match.
2. **No way to pause mid-run on touch/WeChat at all** — `Game.pause()` had exactly one
   entry point, a keyboard `Escape`/`P` listener; `HudView`/`TouchControlsView` had zero
   buttons. Fixed: `HudView.pauseBtn` (`‖`, top-right corner, above the minimap) — lives
   inside `HudView.view`, so it inherits every existing phase-transition's show/hide for
   free (the ~11 call sites that already toggle `hudView.visible`), and is gated by the
   same `!this.online` check the keyboard handler already has (`pause()`'s freeze is
   unconditional once entered — `phase === 'paused'` skips both `advanceSim` AND
   `advanceOnline` — so a shared match still can't be locally frozen from one client).
3. **The Forge's "buy a blueprint" action had no tap equivalent** — every other Forge
   action (craft, character-cycle, clear, start) got a real `Button` in the 2026-07-29
   Loadout-screen pass; the buyable-shelf line stayed display-only, reachable only via the
   `KeyB` keyboard shortcut. Fixed: `Forge.acquireBtn`, shown only while
   `purchasableBlueprints(m).length > 0`, wired to a new `Game.forgeAcquireBlueprint()`
   extracted from the `KeyB` handler (one source of truth for both input paths, matching
   every other Forge action's existing convention). New `forge.acquireButton` i18n key
   across all 8 locales (design/17-i18n.md parity).

Browser-verified live (real Chrome, not the sandboxed preview pane — a synthetic
`TouchEvent`/`Touch` dispatch drove the INTERACT button specifically, confirmed via
`window.__game.input.getTouchVisual()`/`.read()` state, not just pixels): the pause button
opens/resumes the real `PauseMenu`, the Forge acquire button decrements the purchasable
count live, and the INTERACT button renders its distinct green tint and flips
`interacting: true` while held, `false` on release — zero console errors throughout. 20 new
client tests (846 total, was 826), `tsc --noEmit` clean across all 7 workspaces.

**"全部加测试" follow-up, same day:** a dedicated audit subagent (told to verify actual
test assertions, not just check a describe block exists) found four real gaps the pass
above left. (1) `TouchControlsView.test.ts`'s "brightens while held" test for the new
INTERACT button asserted only its bounding-box position — identical whether `pressed` is
true or false — so it would stay green even if the brighten-on-hold behavior were deleted
entirely; fixed by reading `Graphics.context.instructions` directly (filtering to the
`'fill'` action, since each button draws a `.fill().stroke()` pair — two instructions per
shape, the same gotcha `DungeonFloorCanvas.test.ts` already found) to assert the actual
fill alpha differs (0.14 unpressed vs. 0.32 pressed) and matches `THEME.colors.pickupHeal`.
(2) `Forge.test.ts`'s acquire-button visibility tests used two separate instances/
`MetaState`s, proving only that the button's own `.visible` flag toggles — never that
`render()`'s `y += 36` (added only while the button is shown) actually reflows the row
list on a SINGLE instance crossing the real buyable→0 boundary; fixed with a same-instance
test draining a shelf to zero mid-test and asserting the row list's own Y position moves
up by at least the button's reserved 36px. (3) The actual production entry point for the
new INTERACT capability — `WebInput.ts`'s delegation from a real `touchstart` event through
to `read().interacting` — was untested; `TouchControls.ts` itself was thorough, but nothing
proved the wrapper the app actually ships wires it through, unlike the pre-existing `move`/
`fire` coverage in the same describe block. (4) `HudView.test.ts`'s new pause-button tests
never asserted the actual glyph it renders (`'‖'`) — the same private-`label`-field cast
`PauseMenu.test.ts`/`Forge.test.ts` already use, just not applied here. Explicitly NOT
closed, flagged rather than silently skipped (a pre-existing, larger-scope gap, not
introduced by this pass): `WeChatInput.ts` has no test file anywhere in this repo — it's a
one-line delegation to the same `TouchControls` this pass tested thoroughly, but a real
suite for it would need mocking the global `wx` object from scratch, a standalone effort
bigger than this follow-up's scope. 3 new client tests (849 total, was 846 — one of the
four fixes rewrote an existing assertion rather than adding a new test), `tsc --noEmit`
clean across all 7 workspaces.

**2026-07-29: the front door design/10 had described but nobody had built.** A player reported the game felt "all placeholder UI" — the HUD/Settings/PauseMenu were genuinely real (5.2 above), but there was no boot/main-menu screen at all (`main.ts` dropped straight into the forge outpost) and the forge/loadout screen was a keyboard-only monospace text board, no clickable tiles. Shipped: a real **Main Menu** (`game/MainMenu.ts` — PLAY/SETTINGS, deliberately minimal; PvP/Arena entry stays a boot-time `?pvp=1` flag for now, not a runtime choice — a separate, scoped follow-up, **closed 2026-08-03 by Mode Select, see that entry below**); the **Loadout screen** upgraded in place (`game/Forge.ts` — clickable blueprint rows paged 8-at-a-time since `BLUEPRINT_CATALOG` has more entries than the old digit-key shortcuts ever reached, character-cycle arrows, Clear/Start buttons; keyboard shortcuts unchanged as a second input path onto the same underlying methods); and a richer **result screen** (`RunOutcome.ts`/`Screens.ts` — floor/materials/`Time M:SS` off the sim's own `s.tick`/`TICK_RATE`/score, plus a secondary Main Menu exit link). Also resolved two design/10 open questions: auto-aim-to-nearest is now the canonical control scheme (not just a toggle default), and the clutter question favors few/large/clear elements over dense text or many small controls. All render-only, no `ENGINE_VERSION` impact. Along the way, found and fixed a real font-metrics clipping bug (Pixi under-measuring bold/monospace text vs. the browser's actual glyph width in this environment, cropping the last character(s) of titles/labels/hint text) via Pixi's own documented `padding` mitigation, applied to every Text style touched plus the shared `Button` widget and the pre-existing `compareCard.ts` (confirming the bug predated this session, just never visually verified before). Browser-verified live (real Chrome, not the sandboxed preview pane): Main Menu → Loadout (row craft, pagination, character cycle) → Start Run → forced result screen → Main Menu link, plus Settings open/close from both entry points and keyboard-shortcut parity on the Loadout screen. 450 client tests + `tsc --noEmit` + `vite build` all green throughout. Not built (explicitly out of scope, flagged separately): visible on-screen touch stick/button graphics (`platform/TouchControls.ts` renders zero visuals today — invisible hit-zones only, a real gap affecting WeChat/mobile).
- **5.3 Art pipeline** (12/13): ✅ `.tao` editor ported (`tools/animator`, 2026-07-26) — instantiable multi-rig `Rig` class (was funny's static 11-bone humanoid), the orb-core's own 6-bone `RigDef` (root/shell/eye/belly/2 weapon sockets, no arms/legs/walk-cycle), and orb-core preset clips (hover-bob/lean/squash-stretch) replacing the humanoid idle/walk/attack/hurt/death/spawn. **2026-07-27: tooling+render gaps fully closed too** — real (AI-placeholder) art bound for the full 3-character launch roster + a boss-core rig + a critter-core enemy rig, the client's own `.tao` runtime renderer shipped (bone FK, animation playback, aim-tracking weapon-socket rotation, front/back eye hemisphere swap, runtime elemental re-tinting), and the element colour palette locked.

**2026-08-04: authoring tools gained a desktop shell.** `tools/desktop-shell` — an Electron app (following funny's own desktop-shell pattern) hosting `tools/animator` and `tools/map-editor` as switchable pages in one window, with a native file I/O bridge (`window.nwDesktop.fs`) so Save/Load/Import go through real OS dialogs instead of the browser File System Access API — falls back to the pre-existing browser-API behavior when either tool is still run standalone (`npm run dev:animator`/`dev:map-editor` without the shell). Also ships a content hot-update poller (backed by a new Vite `version.json` manifest plugin, `build/versionManifestPlugin.mjs`) and a shell-level auto-updater, both wired but currently inert in practice: `wrangler/animator.jsonc`/`wrangler/map-editor.jsonc` + gated GitHub Actions deploy both tools to Cloudflare (`dd-animator.gamestao.com`/`dd-map.gamestao.com`), staying off by default (`ANIMATOR_DEPLOY_ENABLED`/`MAP_EDITOR_DEPLOY_ENABLED` repo variables unset) until turned on. A git-sync IPC interface is stubbed `not_implemented`, the same placeholder-first pattern funny used before it had a real outsourced-collaborator workflow. Full test coverage added for the shell and both tools' new bridge wiring.

**2026-08-03: two gaps that survived the above, found by cross-checking the actual code rather than trusting this doc's own "fully closed" claim, both closed same day.** (1) The **boss had no dedicated art or rig at all** — `BLIGHTLORD` carried no `bodyRig`, so it silently rendered as a `critter-core` body scaled 2x and re-tinted purple, not "a giant failed core with orbiting shard rings" (`13`). The `BOSS_CORE_RIG` referenced above only ever existed as a rig-format proof in `tools/animator` — never ported to the client, never bound to real art. Closed: real `core`/`ring` art generated and background-cleaned, `BOSS_CORE_RIG` ported to `client/src/render/bossCoreRig.ts`, a new `client/public/skins/boss-core/` bundle authored, wired into `skinRegistry.ts`/`main.ts`'s preload list, and `bodyRig: 'boss-core'` added to the `BLIGHTLORD` blueprint — browser-verified live (a spawned `blightlord` now renders its own huge cracked-crystal silhouette with a boss-sized health bar, not the old critter fallback). (2) **6 of the player-facing elemental weapon ids had no distinct business-end art** — `flamer`/`cryobolt`/`teslagun`/`venomspit`/`cinderscatter`/`frostseeker` all fell back to the plain neutral `gun_default.png` housing (just re-tinted by element), unlike their melee counterparts (`emberblade`/`frostbrand`/`stormglaive`), which had each already gotten dedicated art despite being the same kind of same-frame elemental variant. Closed: all 6 now have real art in `WEAPON_DEFS` (`client/src/render/weaponSkins.ts`), `client/public/weapons/gun_*.png`, anchors + measured `rotationOffsetRad` each — `cryobolt`/`frostseeker` needed a second generation round after the first came back as a hand-gun with a trigger guard, a fiction-breaking mistake in a game where nothing has hands (every weapon plugs into a floating socket). Browser-verified live for all 6 (correct orientation, mounted sprite points at the aim cursor, zero console errors). Prompts for both fixes archived (`art/units/prompts.md`, `art/weapon/prompts.md`) alongside the rejected generations (`art/units/`, `art/weapon/leftover/`). 593 client tests + `tsc --noEmit` clean throughout.

**Update (2026-08-03): closed — GPT-Image-2 art is now treated as final production art, not a placeholder awaiting replacement.** An explicit scope decision, not a tooling or pipeline change: every atlas already generated through this pipeline (characters, enemies, boss, all weapons, UI, biome tiles) counts as shipped art going forward — there is no more "waiting for a human artist/licensed pack" gate anywhere in this project. This directly unblocked 5.4's normal-map lighting item too (see that update below), since `01-rendering.md`'s milestone 2 named exactly this condition as its own blocker. **Update (2026-08-04): the one item this decision didn't resolve on its own is now closed too.** The transparent-background regen this line used to flag (some assets might carry an opaque matte-colour background baked in, a real bug distinct from the art-source question) was audited: a new `tools/png-pipeline/alpha-audit.mjs` decoded and histogrammed the alpha channel of all 76 shipped PNGs under `client/public/` (skins/weapons/ui/biome). Result: no opaque-background bug and no translucent-haze bug anywhere — every sprite (character/weapon/icon/NPC) has clean bimodal alpha, and the only fully-opaque files are the ones meant to be (`ui/hub_bg.png`, the 8 `biome/floor_*`/`wall_*` tiles — full-bleed backgrounds/tileables, no transparency by design). Art asset coverage and cleanliness are both fully closed; see `art/README.md`'s Status block.

**2026-07-28: per-biome background palette done too — no art needed.** `game/theme.ts`'s `biomePalette(biomeId)`: the room-floor renderer (`Game.ts buildRoom`/`buildPillars`, previously one hardcoded `THEME.colors.ground/wall/...` set) now derives a per-biome ground/grid/pillar/wall palette from the ALREADY-locked element hex table (`statusBurn`/`statusChill`/`statusShock`/`statusPoison`), via a small `mixHex` blend (10–22% depending on the surface) so the room stays close to today's dark neutral look with just a hint of the biome's hue — the raw saturated hex stays reserved for bullets/status FX/loot (design/13 "environment desaturated, hazards saturated"), not painted across the walls. `BIOME_ID_TO_ELEMENT` maps a `DungeonConfig.biomeId` (today only `'ember'`→`'fire'`) to that vocabulary, so a future biome is one new map entry, not a parallel colour table; an unknown/absent biomeId (flat `EngineConfig.floors`, PvP arena) falls back to `'neutral'`, which is byte-identical to the pre-existing palette (verified, not just assumed — a real regression risk, since a naive version of this mixed even the neutral case toward its own placeholder hex and visibly lightened it; caught and fixed before shipping). Browser-verified live: the Ember dungeon room floor/walls/pillar now read a warm dark plum-grey instead of the old cold navy-grey, zero console errors.

**Same day: enemy body variety done too** — `brute` (a heavy armoured bruiser, `resist:{physical:700}`, bigger radius/HP) and `floater` (a fragile lower-HP form) ship as two new `EnemyBlueprint`s (`content/enemies.ts`), each pointing at its own new render-only `bodyRig` (a new `EnemyBlueprint`/`EnemyActor` field, copied through like `tint`/`boss`) instead of the shared `critter-core` body. Both reuse `critterCoreRig`'s one-bone `Rig`/reference-radius — the same "one Rig, many skins" pattern the 3 orb-core characters already established — so no new rig-definition code was needed, only two new `client/public/skins/{brute-core,floater-core}/` bundles (art alpha-trimmed/downscaled/re-encoded with the same pure-Node codec the weapon art used) and a `tint:0xe2e8f0` (design/13's locked neutral hex) so the enemy body's default red tint doesn't discolor them. Wired into real play: `world/rooms/ember.ts` gives `ember_hall`/`ember_cross` one `floater`/`brute` spawn each (previously untyped `basic` slots) so they're reachable in a normal run, not just a dev harness. Both AI-behaviorally identical to every other mob (shared chase-and-shoot, no melee/kiting AI exists) — the differentiation is silhouette + stats only, matching how the elemental re-tints already work. Verified headless (dynamic-import `content/enemies.ts`/`skinRegistry.ts`/`Enemy.ts` in the live dev page): blueprints resolve with the right stats, `getRigSkin` loads a real non-placeholder texture for both, and the applied tint hex is exactly `e2e8f0` (vs. a `basic` enemy's default `f56565`) — confirming the new art isn't discoloured. Zero console errors across boot + a live run. The biome-background PNGs generated alongside these (in `art/map/`) were a wrong style/asset-shape match (painterly isometric RPG room scenes vs. this game's flat-cel look and its flat-colour-fill floor renderer) and were NOT wired in — a corrected tileable-floor-swatch prompt was handed back, and per-biome palette-only colours (no art needed) was recommended as the pragmatic near-term alternative, not yet done.

**2026-07-28: weapon-frame art done for 9 of the 11 ranged/melee weapon ids** (`scattergun`/`seeker`/`mortar`/`lasercutter`/`tomahawk`/`novaburst`/`gyre`/`hammer`/`spear` — the ones with a mechanically distinct silhouette worth drawing; `blaster`/`repeater`/`cannon`/`enemygun`/`saber`/`emberblade`/`frostbrand`/`stormglaive`/`carom`/`leech` still share the generic `gun_default`/`sword_default` housing, no shape difference to justify unique art). AI-placeholder art (GPT Image 2, transparent background from the start — no chroma-key fringe this time) alpha-trimmed, box-downsampled 1024–1536px→320px-long-axis, and re-encoded with a hand-rolled pure-Node PNG codec (no image lib on the Node side, same constraint `taoBundle.ts`'s loader comment already documented) — ~20–30× smaller files, round-trip-verified byte-identical after encode. `render/weaponSkins.ts` now keys art by `WeaponSimSpec.name` (falling back to the `ranged`/`melee` kind default) and carries a per-weapon `rotationOffsetRad`, since most of the new art was composed "socket on the right" instead of `gun_default`/`sword_default`'s own "socket upper-left" convention — the offset (measured per-texture from real alpha-pixel data, not eyeballed) cancels each texture's own baked pointing direction so `RigSkin`'s aim-tracking rotation still points the mounted sprite at the reticle. Verified by instantiating a real `RigSkin` in the running dev page (dynamic import, no screenshot needed — this repo's sandboxed Browser pane still can't composite frames) and asserting the resolved world-angle equals the aim angle across a full 8-direction sweep for all 9 weapons; a live two-tab visual check (`?wpn=<id>`, a new dev toggle alongside `?skin=`/`?coop=`) additionally confirmed no console errors and a sane on-screen silhouette. True texture-atlas packing (one shared page + JSON frame map) was deliberately NOT built — same "no image-manipulation lib" constraint, and 9 small icon-sized sprites don't justify a hand-rolled packer; loose per-weapon PNGs match the existing `gun_default.png`/`sword_default.png`/skinRegistry convention.
**2026-08-01: the menu/loadout screens got real art — design/13's "Outpost / hub" gap closed.** A player asked why the game "still looked like a text list" after the 2026-07-29 Main Menu/Loadout work — the screens were real, clickable Pixi UI (5.2 above), but visually just flat-colour panels + monospace text, no icons or background art anywhere outside actual gameplay. Shipped in two passes: **(1) Forge/Loadout row icons, no new art needed** — `game/Forge.ts`'s blueprint rows now show the weapon's own real sprite (already-shipped `render/weaponSkins.ts` art, the same texture mounted in-run) plus a rarity-coloured backing chip, via a new `Button.setIcon()` on the shared `ui/widgets.ts` widget kit — directly fixed the literal "text list" complaint with zero art-generation turnaround. **(2) A shared hub background + button/result icons, real new art** — one `client/public/ui/hub_bg.png` (a floating repair-dock outpost platform) now shows behind every menu-shaped screen (`MainMenu`/`LoginScreen`/`PauseMenu`/`Settings`/`Screens`/`Forge`/`PartyScreen`, all built on the common `Panel` widget, opt-in via a `background` key so the small `CompareCard` isn't affected), plus icon glyphs for the Main Menu's PLAY/SQUAD/LOGIN/SETTINGS buttons and the run-outcome win/loss badges, preloaded best-effort (`render/uiSkins.ts`, same non-blocking pattern as `skinRegistry`/`weaponSkins` — a missing file just falls back to the pre-existing flat colour, verified live by leaving `icon_squad`/`hub_bg` unshipped for one round and confirming zero errors). Two of the seven generated images were rejected on first pass and regenerated once: the hub background came back painterly-isometric (exactly the wrong style `13`'s own biome-art attempt hit before) with a dominant ice-blue palette that collided with the reserved element hue; the squad icon read as three disconnected googly eyes instead of a robot trio. Both regenerations landed on-style. Originals kept in `art/ui/*_raw.png` (accepted) / `*_alt.png` (rejected), matching `art/weapon`'s existing naming. Also extended `tools/png-pipeline/pngCodec.mjs`'s `decodePNG` to accept plain-RGB (colorType 2) PNGs, not just RGBA — the hub background exported without an alpha channel (it's fully opaque), so the existing trim/downsample tool needed to widen, not a new one-off script — then ran all 7 new assets through it (alpha-bbox-trimmed + downsampled, 1024px icons → ~40–70KB each vs. ~1.2–1.9MB raw). Render-only throughout, no `ENGINE_VERSION` impact. Browser-verified live (Main Menu, Loadout, and the EXTRACTED result screen all screenshotted via `renderer.extract`, since this repo's sandboxed Browser pane still can't composite live frames). 568 client tests + `tsc --noEmit` clean throughout.
**2026-08-01, later same day: window-resize relayout bug fixed.** A player report ("display fullscreen per viewport, referencing sibling project funny's behavior") traced to a real gap: the canvas itself already tracked the browser viewport (`WebPlatform.ts`'s `resizeTo: window`), but no screen's own layout math ever re-ran after boot — `MainMenu`/`Forge`/`PartyScreen`/`LoginScreen`/`PauseMenu`/`Settings`/`Screens` (the win/loss result overlay) each computed their Panel/button positions once, at whatever size was current the moment `show()` first ran, and never again. Resizing the browser window afterward left the UI boxed into the old (smaller) rectangle with black canvas filling the rest of the actual window — reproduced live via claude-in-chrome (this repo's sandboxed Browser pane can resize its viewport but doesn't reliably fire/composite the resulting `resize` event, so the bug only showed up under a real browser). Fixed in `Game.ts`: a new `relayoutViewport()` re-dispatches the current phase's own `show()`/`render()` against a fresh `screenSize()`, wired to `window`'s `resize` event (deferred one `requestAnimationFrame` tick so it runs after Pixi's own `renderer.resize()` — guaranteed to fire first since `WebPlatform`'s own resize listener registers earlier in boot, and browsers dispatch same-event listeners in registration order). `Screens.ts` needed a new public `resize()`; every other screen already had a reusable `show()`/`render()` to call again (`Forge.ts` already cached its last args for exactly this reason). `HudView.reposition()` — already written for this, but never wired to anything — is now called too. Verified live in real Chrome: shrinking then growing the window keeps the main menu and forge screens filling it edge-to-edge with no letterboxing. 572 client tests (4 new, `game/Screens.test.ts`) + `tsc --noEmit` clean throughout.

**2026-08-01, still later: Forge Outpost overlap/overflow bug fixed.** A player screenshot showed `START RUN ▸`/the compare card floating on top of the weapon row list, plus a debug-looking line of text running off both edges of the screen. Two real, independent layout bugs in `game/Forge.ts`, not the art work above: (1) the unlocked-blueprint shelf line (`Store (demo: free): ...`) joined every purchasable id with no length bound — on a fresh account (17 unlockable blueprints) it became one unbroken line wider than the viewport; and (2) `START RUN`/`CLEAR LOADOUT`/the keyboard hint were positioned by flowing down from the row list + compare card and only *clamped* (`Math.min(y, h - 70)`) once that overflowed the screen — the clamp shrank the button's own position but never moved the still-there rows/compare-card out of the way, so on any viewport short enough to overflow (every size tested), the clamped button landed on top of rows 6-8 instead of below them. Fixed by making `clearBtn`/`startBtn`/`hint` a genuinely fixed bottom bar anchored to `h` (not flowed from content at all), and by having the compare card hide itself when there's no longer room above that bar rather than overlapping it. The blueprint-shelf line now collapses to a bare count (`"17 more available"`) past 3 names instead of trying to fit a variable-length list — a length cap alone wasn't trustworthy here either: this environment has a documented Pixi word-wrap measurement quirk (5.2/2026-07-29's font-metrics bug note above) where Pixi's own reported text width under-reports what the glyphs actually render at, so `wordWrap` couldn't be trusted to actually clip a long line to its declared width. Verified live via claude-in-chrome (the sandboxed Browser pane still can't composite live frames) at several viewport sizes. New `game/Forge.test.ts` (8 tests) is the first test in this repo to exercise `Text.height`/`.bounds`, which needs a real canvas 2D context that plain-node vitest doesn't have — stubbed via Pixi's own `DOMAdapter.createCanvas` seam (a minimal fake `measureText`) rather than adding a jsdom/canvas dependency. 580 client tests (8 new, `game/Forge.test.ts`) + `tsc --noEmit` clean.

**2026-08-01, still later (concurrent session): the post-floor-clear checkpoint HUD was unreadable — fixed.** A player reported the screen after clearing the first floor was "completely incomprehensible": a screenshot showed HP/weapon/floor-info `Text` floating directly over the game world with nothing behind it, a one-line `▶ CHECKPOINT — hold [E] EXTRACT (bank & leave) · tap [E] DESCEND` prompt easy to miss entirely, and floor-progress dots (green circle / amber diamond) with no key anywhere. Fixed in `HudView.ts`/`ui/FloorProgress.ts`: (1) a translucent backing `Panel` behind the stat cluster, width re-measured against the widest live line every frame instead of a fixed guess; (2) the tiny prompt replaced by a prominent centered banner in plain language — `FLOOR CLEARED — CHECKPOINT` / `HOLD [E] to EXTRACT: bank N materials now & end the run safely` / `TAP [E] to DESCEND to Floor N+1: riskier, but keeps you playing` — with the real pending-material count and next-floor number, not the bare word "bank"; (3) a one-line legend under the floor-progress dots (`green=done amber=now diamond=checkpoint`). Along the way, found and fixed a real (pre-existing) case of the already-known Pixi font-metrics clipping bug (5.2/2026-07-29's note, independent of the same-day Forge fix above) on `HudView`'s own `weaponText`/`infoText`, which had never gotten the `padding` mitigation the other screens already carry. Also caught and fixed a self-inflicted regression mid-session: the new banner's fixed screen-top position overlapped the stat cluster's own info line on a wide viewport, painting over "Score N" — moved the banner to anchor below the cluster instead. New `HudView.test.ts`/`ui/FloorProgress.test.ts` (10 tests) exercise the checkpoint banner's visibility/copy and the panel's dynamic width; writing them required moving the panel-sizing math off `Text.width`/`Container.getBounds()` (both need a live canvas — unavailable in this repo's plain-node vitest env, same constraint the Forge fix above hit) onto a canvas-free monospace-width estimate (`ui/textWidth.ts`), which is also cheaper to run every frame in the browser than the canvas measurement it replaced. Verified live via claude-in-chrome. 590 client tests (10 new) + `tsc --noEmit` clean throughout.

**2026-08-02: design/13's remaining UI-art gap closed — the rest of the button icons, real biome floor/wall art, and the Forger NPC.** Three items design/13 still listed open going into this session: `LoginScreen`/`PauseMenu`/`PartyScreen`/`Forge`'s remaining buttons had no icons (only the 2026-08-01 Main Menu/Forge pass got them), the other biomes still rendered as a code-only palette tint (no real floor/wall art), and the outpost had no NPC. All three closed. **(1) Icons** — 9 new glyphs (`icon_register`/`icon_password`/`icon_logout`/`icon_back`/`icon_quit`/`icon_party_create`/`icon_party_join`/`icon_party_leave`/`icon_clear`) wired via the existing `Button.setIcon()`/`getUiTexture()` mechanism, no widget changes needed; `icon_play`/`icon_account`/`icon_settings` reused where the action semantically matched (RESUME/START MATCHING/START RUN all "go", LOGIN both places, SETTINGS both places). **(2) Biome floor/wall art** — real tileable swatches for fire/ice/lightning/neutral (`client/public/biome/`), the first attempt at this exact asset shape to actually succeed after two prior fails (both came back as painterly-isometric illustrated rooms, not flat orthographic tiles) — the fix was spelling out in the prompt, repeatedly, that this is a texture-atlas swatch and explicitly NOT a scene/room/camera-view (`art/biome/prompts.md`). New `render/biomeTiles.ts` preloads them (same non-blocking pattern as `uiSkins.ts`); `RoomBuilder.ts` renders via `TilingSprite` when a swatch exists for the room's element, falling back to the pre-existing flat palette fill otherwise. **(3) Forger NPC** — a stationary, blocky/industrial orb-core variant (hammer + tongs on the hero's own weapon-mount tethers, warm stone/beige/gold palette) bound into `Forge.ts` as a corner sprite, hidden until its texture exists AND the viewport has room. The NPC's first accepted-on-style generation had to be regenerated once more for a reason invisible to the eye: it came back on an opaque grey background instead of a transparent one (GPT Image 2 followed "plain neutral grey background" literally instead of producing alpha, unlike the icon prompts which explicitly asked for "transparent background" and got it) — caught by decoding the PNG's alpha channel directly (`alphaRange = 255 255`, i.e. zero transparency anywhere) rather than by looking at it, since a render preview composites transparency against a similar grey by default. All new asset-registry/render logic got real tests for the first time (previously only verified live): `RoomBuilder.test.ts` (6, texture-vs-fallback branching for both floor and wall), `Forge.npc.test.ts` (4, the NPC's hidden/shown/no-room-hide/scale logic), `uiSkins.test.ts`/`biomeTiles.test.ts` (4 each, asset-key registration + the "missing art never blocks boot" preload contract) — required exporting a small `UI_ASSET_KEYS`/`BIOME_TILE_ASSET_KEYS` list from each registry, since the getters return `undefined` identically for "key not registered" and "registered but not loaded" and can't otherwise distinguish a dropped key from a missing file. Verified live via claude-in-chrome across every touched screen (LoginScreen/Account, PartyScreen/Squad, PauseMenu, Forge) plus an actual in-run fire-biome floor tiling seamlessly. 608 client tests (18 new) + `tsc --noEmit` clean throughout.

**2026-08-02, later same day: auto-aim-to-nearest removed (reverses the 2026-07-29/design/10 decision); player body now faces movement, gun faces aim.** A player reported the locked-on bullet felt wrong — reversing the canonical-control-scheme call made 2026-07-29 (10, "Open questions" above). `CommandBuilder.ts`'s `nearestEnemyAim` lock-on and the `Settings.ts`/`SettingsState` auto-aim toggle it was gated behind are gone outright (not just defaulted off): the player's own manual aim (mouse point / stick dir) is now the only aim input, and a fired bullet simply travels along it — exactly like an enemy's shot travels along the `facing` `AIDecideSystem` computes for it, no lock-on, no homing. Alongside that, shipped the upper/lower body split raised in the same conversation ("character should face movement, gun should face where it's shooting"): `Entity`/`Actor`/`Skin`/`RigSkin` now carry TWO independent angles instead of one — `bodyFacingRad` (movement direction, held at its last value while idle — `Scene.ts` derives it from the player's own `vx`/`vy`, same "no snap-to-zero" convention `CommandBuilder.lastAim` already used for the stick) drives the whole-rig L/R flip + front/back hemisphere (`RigSkin.setBodyFacing`, `facing.ts`'s `facingFromAngle`, renamed from `facingFromAim` since it's no longer aim-driven), while `facingRad` (the engine's existing aim-derived `PlayerActor.facing`) still drives ONLY the weapon — both the cosmetic Graphics barrel/blade rotation and the rig's aim-tracking weapon-socket rotation (`RigSkin.setAim`), unchanged from before. Enemies/bullets/pickups are unaffected (`Entity.pushState`'s new `bodyFacingRad` param defaults to `facingRad` when omitted) since only a moving player actor needs the two angles to diverge. The online-prediction path (`LocalPredictor`) got the same split — `Pose.bodyFacing` dead-reckons from the live `moveBrad` alongside the existing instant-from-aim `facing`. Render-only, no `ENGINE_VERSION` impact. Follow-up pass added real coverage at every layer the split touches: `CommandBuilder.test.ts` (new, manual-aim-only + no-lock-on), `Entity.test.ts` (new, `bodyFacingRad` default/override), `Scene.test.ts` (new, the actual velocity→body-facing computation + idle-hold), `RigSkin.test.ts` (new, `setBodyFacing`/`setAim` independence incl. the mirror-compensation math), plus additions to the already-existing `Actor.test.ts` (body vs. weapon rotation wiring) and `localpredictor.test.ts` (the online-prediction path's own body-facing dead-reckoning) — 26 new tests, `facing.test.ts` renamed (`facingFromAim` → `facingFromAngle`, same coverage). `tsc --noEmit` clean throughout.

**2026-08-02, later still: a 5-item in-run legibility pass, prompted by a player screenshot of a dungeon room.** The screenshot showed the actual room sitting as a small island in a huge black canvas void, the corner stat panel invisible against that same black backdrop, the floor-progress legend reading as a bare debug sentence, non-boss enemies with no visible HP state, and flat single-colour pillars/pickups easy to lose against the tile art. All five fixed, render-only, no `ENGINE_VERSION` impact: (1) **camera zoom-to-fit** (`FxController.updateCamera`) — a room smaller than the viewport now scales up (contain-fit against the tighter axis, capped at 1.8x so a tiny room doesn't blow sprites into blocks) instead of sitting centred in black; a room/arena that already covers the viewport at 1x is untouched. `CommandBuilder`'s screen→world mouse-aim conversion divides by this same zoom (`cam.zoom`), or a zoomed room would aim wrong. (2) **HUD panel border** — `ui/widgets.ts`'s `Panel` gained an opt-in `borderColor`/`borderAlpha` stroke, applied to the HUD's corner stat panel and the checkpoint banner, so the panel reads as a real box over a plain black backdrop instead of blending into it. (3) **floor-progress legend replaced with icons** — the `green=done amber=now diamond=checkpoint` text line (shipped 2026-08-01, above) is gone; the meaning is now baked into the dots themselves (a checkmark stroke on a done node, a bright ring on the current node, the diamond shape alone marking the checkpoint), no separate legend text at all. (4) **per-enemy health bars** — `Actor.ts`'s floating health bar, previously boss-only, now shows for every enemy (a boss's stays bigger/further out); a player actor still has none (the HUD's own HP bar already covers it). (5) **pillar faux-shading + pickup glow** — `RoomBuilder.ts`'s pillar `Graphics` gained a lit-from-upper-left highlight band, an opposite shadow band, and rim strokes (cheap directional shading, no new art); `Pickup.ts` gained a soft same-colour additive glow behind each pickup's crisp shape (a separate `Graphics` so the glow doesn't wash out the shape itself), across every `PickupKind` including `bandage`. Verified live via claude-in-chrome in a real dungeon room (zoomed room fill, bordered panel, icon-only legend, a full green health bar over a regular mob, banded pillar shading, a glowing crystal pickup all visually confirmed in one screenshot) — this repo's sandboxed Browser pane still can't drive an in-progress run reliably (phase resets mid-session whenever a concurrent HMR reload lands), so claude-in-chrome + `window.__game.beginRun()` was used instead, same workaround this doc's other 2026-08-01/08-02 entries already used. Followed by a dedicated test pass: `FxController.test.ts`/`Actor.test.ts`/`Pickup.test.ts`/`ui/widgets.test.ts` (new) + `RoomBuilder.test.ts` (extended) — 50 new tests covering the zoom math (capped/uncapped/floor-at-1 cases), boss-vs-mob bar sizing, glow blend mode across every pickup kind, pillar Entity creation/rebuild/clear, and the panel's border option plus its pre-existing same-size skip-redraw guard. 739 client tests + `tsc --noEmit` clean throughout.

**2026-08-02, later still: a second 5-item pass from another annotated screenshot of the post-floor-clear checkpoint screen, `ENGINE_VERSION` 30→31.** User circled: player HP only in the corner HUD (not on the map), the black void the zoom-cap above still leaves around a small room, a green "+" pickup floating outside the room, the "HOLD/TAP [E]" text prompt reading as unclear, and rooms having no walls/background. All five fixed: (1) **player HP on the map** — `Actor.ts`'s per-enemy floating health bar (previous entry, item 4) extended to `faction==='player'` too; `Scene.ts reconcile()` now calls `v.setHealth(p.hp, p.maxHp)` for the player loop, which had never been wired. (2) **backdrop layer** — a new `Layers.backdrop` container (sibling of `world`, NOT scaled/panned by the camera) + `Backdrop.ts` (a screen-space `Graphics` rect filling the viewport, tinted via a new `BiomePalette.void` field); `RoomBuilder` sets its palette on every `build()`. (3) **real bug**: `SpawnSystem.loadRoom()` never cleared `state.pickups` on a normal room-to-room transition (only `ExtractionSystem`'s floor-descend did) — an uncollected drop from a wider earlier room kept its stale coordinates forever, landing outside the next (smaller) room's bounds; one-line fix (confirmed via grep that room-to-room movement is an automatic teleport, never "walk through a door", so a stale pickup could never have been reachable anyway). (4) **portal + popup replaces "HOLD/TAP [E]"** — see the 1.4 update above for the engine-side rewrite (`EXTRACT_HOLD_TICKS`/`state.extractHoldTicks` removed, two new one-shot `Button.CONFIRM_EXTRACT`/`CONFIRM_DESCEND` bits, same one-tick-pulse latch pattern `SWAP_WEAPON` already used); render-side, a new `Portal.ts` (Graphics gate reusing the existing `THEME.colors.extractGlow`, no new art) is built by `RoomBuilder` at the room's center and shown only once `wavesExhausted`, and a new `PortalPrompt.ts` (Panel + two `Button`s, mirrors `PauseMenu.ts`) shows only within a proximity radius of the portal — replacing `HudView`'s old `checkpointPanel`/`checkpointText` entirely. A real integration snag caught before shipping: `WebInput.ts`'s `canvas.addEventListener('mousedown',...)` sets `leftDown` independent of Pixi's own event system, so clicking a popup button would ALSO fire a shot — fixed with `CommandBuilder.suppressFire()`, toggled by `PortalPrompt.isOpen` (harmless since the room is already clear whenever the popup can show). `Button.INTERACT`/`p.interacting` itself was untouched — still shared by `PickupSystem` (weapon swap) and `ReviveSystem` (revive channel). (5) **walls on every room** — all 6 `EMBER_ROOMS` (`ember.ts`) had empty/near-empty `solids`; a new `perimeterWalls()` content helper adds a 1-grid-unit border on all 4 edges with a 4-unit door gap on whichever edges the piece's own (previously flavor-only) `exits` array names — confirmed via repo-wide grep that `exits` drives nothing in the sim today, so gameplay-safe to add, though it DOES change collision geometry (hence the version bump, shared with item 4's engine rewrite and item 3's pickup-clear fix). 742 client tests + `tsc --noEmit` clean. Verified live via claude-in-chrome: portal appears only after clearing, proximity-gated popup shows the correct pending-material count and next-floor number, Descend advances floors, Extract banks materials and ends the run cleanly, neither button click also fires a shot. Hit a NEW claude-in-chrome verification gotcha along the way (a backgrounded browser tab freezes the sim tick via rAF throttling — fixed by driving `window.__game.stepSim()`/`.update(dt)` manually instead of waiting on rAF; different root cause than the concurrent-session HMR-reset gotcha documented in earlier entries) — see the daydayup-engine-conventions memory.
**2026-08-02, later still: every main-menu and forge button was dead — a raw mouse-down "confirm" poll was hijacking all of them.** A player reported that PLAY/SQUAD/LOGIN/SETTINGS all landed on the Forge Outpost, and that Forge's own `← MENU` button started a run instead of going back. Root cause in `Game.ts`'s `pollConfirm()`: it sampled `input.read().firing` — the raw left-mouse-down *level*, set by `WebInput`'s own `mousedown` listener independent of Pixi's event system — and treated a rising edge as "confirm" on EVERY non-playing phase (`menu`→`showForge()`, `forge`→`beginRun()`). Since `firing` goes true on mouse-**down** and a human click holds for ~100ms (several frames at 60fps), the poll always won the race against the button's own `pointertap`, which Pixi only synthesizes on the way back **up** — and by then the confirm had already hidden the screen the press started on, so Pixi swallowed the intended tap outright. Every button on those two screens therefore collapsed into one behavior; the button wiring itself was correct the whole time and simply never got to run. The path predates design/10's real button UI (it was the original "tap anywhere to start/restart") and was never re-scoped when the clickable screens landed 2026-07-29. Fixed by extracting `game/confirmEdge.ts` — it owns the `Phase` union (moved out of `Game.ts`, which needs a live Pixi `Application` and so can't be unit-tested) plus `acceptsFireConfirm()`/`shouldConfirmOnFireEdge()`, gating the fire-edge confirm to `victory`/`defeat` ONLY, where it remains the fire-button fallback for `Screens.ts`'s own tap-anywhere `pointerdown` handler. `prevFire` is still tracked on every phase so arriving on a result screen with fire already held doesn't insta-confirm. **The real lesson is a verification one, now recorded in design/10's decisions and the engine-conventions memory:** this bug survived TWO prior "cannot reproduce, routing is correct end-to-end" investigations (including a static trace plus scripted clicks in both the sandboxed pane and real Chrome) because *every* scripted click — `computer left_click` included — presses and releases inside a single frame, so the poll never observes a rising edge at all. Dispatching a `PointerEvent('pointerdown')` also does not fire a `'mousedown'` listener, so pointer-only synthetic clicks skip the raw-input path entirely. What actually found it: instrumenting the user's own live tab with `Object.defineProperty(game,'phase',{set})` logging `new Error().stack`, then having the *user* click once — which returned the exact chain `update → pollConfirm → confirm → showForge`. Render-only, no `ENGINE_VERSION` impact. Verified against the real running game with a faithful ~130ms held click (mouse-down held across 8 `update(16)` frames, then released): all four menu buttons and Forge's `← MENU` now stay put while held and route correctly on release, while a result-screen fire edge still confirms. 761 client tests (11 new: `game/confirmEdge.test.ts`, whose phase table is a `Record<Phase, boolean>` so adding a phase fails type-check until someone decides its confirm behavior, plus a `ui/widgets.test.ts` case pinning "pointerdown alone must not activate a Button") + `tsc --noEmit` clean.

**2026-08-03: ground-weapon pickup is click-driven now, `ENGINE_VERSION` 31→32.** A player asked what the double-chevron floor icon near their feet was and why it couldn't be picked up — it was a weapon drop, but design/03's original "hold-INTERACT-while-standing-on-it" gesture (line 186's entry above) had no on-screen affordance explaining that, and required lining up on top of the exact item. Two changes: **(1) real ground icon** — `scene/Pickup.ts`'s weapon-kind branch now draws the same business-end sprite `WeaponCard`/Forge rows already mount (`render/weaponSkins.ts#getWeaponTexture`, resolved via the pickup's own `weaponId` + `WEAPON_SIM_BY_ID`), falling back to the old chevron only when no texture resolves (unknown id). **(2) click-to-collect panel replaces tap-`INTERACT`** — `ui/WeaponPickupPrompt.ts` (new, same non-blocking-overlay shape as `PortalPrompt.ts`) lists every weapon pickup within `SIM.lootRevealRadius` (icon + name, one `Button` row each, `ui/pickupProximity.ts#nearbyWeaponPickups`); tapping a row IS the pickup, closing (a small "×") just leaves them all on the floor until the nearby set changes (a weapon enters/leaves range, or the player leaves and comes back). Replaces `HudView`'s old single-nearest `groundCard`/`groundHint` (the `CompareCard` widget itself stays alive — Forge's loadout screen still uses it). Engine-side: `PlayerCommand`/`PlayerActor` gain `pickupTargetId` (0 = none, else the clicked `PickupItem.id` — a one-shot latch, `CommandBuilder.requestPickup()`, same shape as `CONFIRM_EXTRACT`/`CONFIRM_DESCEND`); `PickupSystem`'s weapon-kind branch now gates on that id matching (server-authoritative, same file) instead of `INTERACT`'s rising edge, and does so at the wider `lootRevealRadius` rather than the tight `pickupRadius` every other kind still uses — "if the panel shows it, you can click it." `PlayerActor.wasInteracting` (the v21 rising-edge memory, `PickupSystem`'s only reader) is dead code now and removed. `Button.INTERACT`/`p.interacting` itself is otherwise untouched — still read by `ReviveSystem`'s revive channel, correcting line 186's now-stale "shared by PickupSystem and ReviveSystem" note. Game.ts suppresses fire while the new panel is open, same reasoning/mechanism as the existing `PortalPrompt.isOpen` case (a click on a row must not also fire a shot). `design/03`/`05` updated to describe the new gesture as shipped, not the old locked spec. Engine suite green (382 tests) and every client test file this change touches (`Pickup`/`Scene`/`HudView`/`WeaponPickupPrompt`/`pickupProximity`, 89 tests) passes clean. This landed alongside a separate, larger in-flight change removing manual aim entirely (`ApplyInputSystem`/`CommandBuilder`/`Game.ts` etc.) — those shared files are intentionally left uncommitted here rather than folded into this commit, so this entry covers only the pickup-panel slice; the aim-removal work gets its own entry once it lands.

**2026-08-04: manual aim is gone entirely — reversed-then-reversed-again, `ENGINE_VERSION` 32→33.** A player asked why shooting near an enemy didn't auto-lock. It wasn't a bug: design/10 already documents that auto-aim-to-nearest shipped once (2026-08-02) and was pulled the same day because a bullet locking onto a target while the player was still trying to manually aim elsewhere read wrong. Rather than re-adding that toggle, the player asked to remove aim as a concept altogether — movement is now the only control; a fire button/left-click just fires. `ApplyInputSystem` decides `PlayerActor.facing` itself every tick: the nearest hostile (unlimited range, the same contract `nearestHostile` already gives homing/deflect) if one exists, else the current movement direction, else last tick's facing is held — this sidesteps the original failure mode outright, since there's no manual input left for an auto-lock to fight. `PlayerCommand.aimBrad` and `state/input.ts`'s `quantizeAim` are deleted (not deprecated); `CommandBuilder`/`WebInput`/`TouchControls` lost their entire aim-input path (mouse-move tracking, the right-side aim stick — now a fixed hold-to-fire zone); `AllyController`/`PvpBotController`/`ai/engage.ts` stopped computing their own aim, since the engine now does it for every actor uniformly; `LocalPredictor` stopped predicting facing altogether (it's not player input anymore, so predicting it client-side would just re-derive the same target-lock and risk disagreeing with the confirmed engine) — it reads confirmed `facing` straight off state each frame instead. One real side effect found along the way: `SpawnSystem.chooseBranch`'s branching-room picker keyed off player-aim direction at a fork (design/05 reward-choice) — with aim gone, it now reads as "walk toward the exit you want," since a branch point has no live enemies to auto-lock onto and facing falls back to movement direction; behaviorally sensible, but a real design/08 doc update either way. `design/01/04/05/06/08/10/15` all updated to drop stale aim-input language rather than leaving it to rot. Landed rockier than most entries in this doc: a concurrent session's cleanup of its own (this pickup-panel) commit ran a working-tree `checkout`/`restore` across every shared file, which silently wiped this change's first pass from disk with no git-recoverable trace (no dangling blob, no stash) — caught by an unexpectedly-clean `git status` plus a failing final typecheck, recovered by fully replaying every edit from the session's own tool-call history rather than any git trick (see the daydayup-worktree-editing-gotcha memory for the forensic account). Also added direct unit coverage for two production files that had none before (`ai/engage.ts`, `platform/web/WebInput.ts`), on top of updating every test this change itself touched. Final state, verified after the replay: 382 engine / 722 client / 158 server tests (1413 across all 7 workspace packages including the tools), `npm run check` clean, and a live browser check confirming both a PvE enemy and an opposing PvP seat get auto-faced and hit by a plain click with zero aim input.

**2026-08-04, later still: the ground-weapon pickup click actually reaches the engine now.** The aim-removal pass above touched `ApplyInputSystem`/`CommandBuilder`/`commands.ts` anyway and, as a side effect, already carried `pickupTargetId` through those three (the field, the copy-to-actor, and `CommandBuilder.requestPickup()` all existed post-merge) — but two pieces were still missing, so a real player click still could never collect anything: (1) `Game.ts` never actually called `hud.weaponPickupPrompt.onPick`, so nothing ever invoked `requestPickup()` in the first place, and the panel wasn't in the `suppressFire` check either (a row click would also fire a shot); (2) `NetInputSource.changed()` — the sparse-sync dedup filter (design/15, ROADMAP 4.5) — still didn't compare `pickupTargetId`, so even a correctly-produced click landing on an otherwise-idle tick (no move, no buttons) would have been silently deduped as "unchanged" and never sent to the server. Both fixed; new coverage: a `netinput.test.ts` case for the idle-tick click, and a `pickups.test.ts` case driving a real `PlayerCommand` through `createGameEngine().step()` end-to-end (every existing case in that file sets `PlayerActor.pickupTargetId` directly, which would keep passing unchanged even with the wiring completely absent). `Game.ts`'s own two-line wiring stays untested, matching this repo's existing (deliberate) exemption — no test file for `Game.ts` exists anywhere, since it needs a live Pixi `Application`. 384 engine / 722 client tests, `tsc --noEmit` clean across engine/client/server.
A player reported both that the menu buttons were hard to read and that clicks "landed on the
wrong page". The first was real: the buttons were semi-transparent fills sitting directly on
`hub_bg.png`, whose brightness varies enough across the image that no single fill reads
everywhere. Fixed by giving the shared `Button` widget an opt-in border and a fully opaque
fill, and by putting a dedicated dark backing card behind the Main Menu's button cluster, so
legibility stops depending on which part of the art a button happens to cover. The second
complaint had **no routing bug behind it** — routing was verified correct end-to-end, before
and after (the genuine routing bug was the separate `pollConfirm` one above, already fixed by
then). The real cause was presentational: LOGIN and SETTINGS were stacked vertically with
near-identical icon chips, which invites a misclick and then reads as the app going somewhere
it wasn't asked to. Fixed by making the hierarchy explicit — PLAY is now the clear primary
(bigger, green, the same "go" colour convention `PartyScreen`/`LoginScreen` already used),
SQUAD secondary, and LOGIN/SETTINGS moved into a side-by-side row with distinct icon-chip
colours. Render-only, no `ENGINE_VERSION` impact. 9 new tests (`Button` border/text/onTap/
`setIcon` behaviour, plus MainMenu's size/ordering hierarchy), `tsc --noEmit` clean. The
standing rule this produced is recorded in design/10: a screen drawn over background art owns
its own contrast, and two adjacent buttons must differ by more than their label.

**2026-08-02, after that: the in-run HUD rebuilt from formatted text into real widgets, plus a
"which one is me" marker.** Prompted by a third annotated screenshot in the same lineage as the
two passes above — this time the user circled their own character next to a floor drop and asked
what the two things were, then asked for everything in the top-left corner to be turned into UI.
Both halves were fair. The corner was two monospace strings (`blaster [common] (ranged) dmg 1`
and `juggernaut  Floor 1/3  Room 1/2  Enemies 1  Banked 0  Score 0`) — complete, and unreadable
as anything but debug output. And the earlier pass's own decision to give *every* actor a
floating health bar had made the player's bar identical to a mob's, which is exactly why the
character needed circling to ask about. Shipped, all render-only, no `ENGINE_VERSION` impact:
(1) **`PlayerCard`** (`ui/PlayerCard.ts`) — the character's own portrait (reusing the rig
bundle's `shell` texture, so a new character needs no extra art), name, HP bar, and a shield bar
that appears only for a character that has a pool; (2) **`WeaponCard`** (`ui/WeaponCard.ts`) —
the same business-end texture the rig mounts in-world and the Forge rows already use, on a
rarity-bordered chip, with a `rarity · kind · element` subtitle and a damage badge tinted by
`damageType` off design/13's locked element palette; (3) **`StatChip`** (`ui/StatChip.ts` +
`ui/hudIcons.ts`) — the info line replaced by icon-led pills, PvE `FLOOR/ROOM/FOES/BANKED/SCORE`
vs PvP `ZONE/ALIVE/SCORE`, `BUFFS` present only while the run has one, each icon tinted to match
what it refers to in the world; (4) **`AllyRow`** — the co-op teammate's one-sentence status line
became a name + bar + bleedout countdown; (5) **`Actor.setLocal()`** — a teal ground ring plus a
teal health-bar outline on the local seat only (driven by `Scene.reconcile`'s already-resolved
local player id), in `THEME.colors.player`, the one hue no enemy tint ever takes; a teammate
deliberately does *not* get it. Three real bugs fell out along the way: `ui/textWidth.ts`'s
`estimateMonoWidth` measured every CJK string at 60% of its true width (`length × 0.6`), so every
panel sized from a translated string came up short in Chinese and looked correct in English —
now East-Asian-width aware; the ground compare card sat at a hardcoded `x=220` chosen when the
panel was a fixed 220 wide, and now tracks the panel's live width; and two widgets cached their
redraw against a `''` key that collided with their own uninitialized state, so an unarmed weapon
card and an empty stat chip could never draw at all. New i18n keys under `hud.chips`/`hud.weapon`/
`hud.rarity`/`hud.kind`/`hud.element`/`hud.ally`, mapped through `satisfies Record<…,
TranslationKey>` tables rather than template-literal casts so a new engine-side rarity tier or
damage type is a build error here, not a raw key at runtime. Verified live via claude-in-chrome
in both locales and in `?coop=1` (the ally correctly gets no ring). 518 client tests (113 new,
covering the width estimator's wide-character and code-point behaviour, every HUD icon's
stay-inside-its-box layout contract, chip width derivation, the weapon card's cache-invalidation
boundaries incl. locale, the shield bar's presence rule, and the compare-card regression) +
`tsc --noEmit` clean; 1061 across the repo. The standing rules this produced are recorded in
design/10: every value on screen is a widget rather than a formatted line, the widget shows the
same art the world shows, the local player is identifiable in the world and not only in the HUD,
and HUD layout math never touches canvas text measurement.

**2026-08-03: the screen-flow gaps a full walkthrough surfaced — Mode Select, a real
Matchmaking screen, and a standalone tutorial level.** Walking the new-user journey
(onboarding → register/login → first PvE match → matchmaking) end to end found five real
gaps: no boot loading feedback; no menu-driven path into co-op/PvP (only the `?online=1`/
`?pvp=1` boot flags reached them — the 2026-07-29 entry above's own deferred item); no
visible feedback while `connectOnlineSession` ran (the game sat in a blank `playing` phase,
and a post-ticket failure hung forever with zero feedback — a real bug, not just missing
UI); and no tutorial for a first-time player. All five closed, render-only except two
necessary bug fixes (no `ENGINE_VERSION` impact):
- **Boot splash** — plain HTML/CSS spinner in `client/index.html` (paints before Pixi/WebGL
  even initializes), removed by `main.ts` right after `game.start()`.
- **Mode Select** (`game/screens/ModeSelect.ts`) — PLAY's new destination: SOLO PvE (routes
  to Forge, byte-identical to before), CO-OP / PVP SOLO QUEUE (open Matchmaking below), and
  TUTORIAL (below), with a "NEW HERE?" badge on Tutorial until `MetaState.hasSeenTutorial` —
  never forced. SQUAD stays MainMenu's own separate button, unchanged.
- **Matchmaking** (`game/screens/Matchmaking.ts`) — owns the `connectOnlineSession` attempt
  with a connecting state (elapsed time + Cancel) and an error state (message + Retry +
  Back); PartyScreen's pre-formed-squad path now routes through it too, instead of jumping
  straight to `playing`. Building it surfaced two real, previously-invisible bugs, both
  fixed: `net/transport.ts`'s `WebSocketTransport` had no `error`/`close` listener at all
  (a bad ticket or a dropped connection was completely unobservable), and
  `connectOnlineSession` had no bound waiting for `match_start` (a stalled connect just
  hung the caller's promise forever). Both are now real rejections the screen surfaces.
- **Tutorial level** (`game/match/tutorialConfig.ts` + `game/controllers/
  TutorialHintController.ts`) — a fixed, flat (non-dungeon) 2-floor `EngineConfig`, one
  small hand-built arena reused across both floors, fixed seed. Floor 0 teaches move/aim/
  fire (a render-side elapsed-tick hint) → weapon-swap (persists until `activeSlot`
  changes) → melee-deflect (persists until a `'deflect'` event fires), via one weak `basic`
  enemy (already fires the shared enemy gun — deflectable with zero special-cased
  content). Floor 0 is deliberately not the last floor, so its checkpoint shows the REAL
  interactive `Portal`/`PortalPrompt` (Bank-and-Extract vs Descend) instead of
  auto-resolving; floor 1 (the last floor) is one trivial enemy, so either checkpoint
  choice ends the run normally through the real result screen. Always skippable via the
  pause menu (relabeled "SKIP TUTORIAL" for this run only, `PauseMenu.show`'s new optional
  label param) — completing OR skipping alike sets `hasSeenTutorial` (new `MetaState`
  field, migrated/backfilled like every other field `meta/store.ts` already handles).
  Exposed and fixed a real, generic bug along the way: `Game.ts`'s checkpoint-eligibility
  gate, `HudView.ts`'s floor chip, and `RunOutcome.ts`'s result-screen floor line all
  hardcoded `EMBER_DUNGEON.floorCount` instead of reading the run's actual config —
  harmless while the ember dungeon was the only floored content in the game, wrong for any
  flat `EngineConfig.floors` run. Fixed via one shared `totalFloorCount()` helper
  (`game/match/floorCount.ts`, mirrors `ExtractionSystem.ts`'s own already-correct
  mode-generic check) used at all three sites instead of the hardcoded import.

Browser-verified live (two real tabs against a running `matchsvc` + gameserver): Solo PvE
regression, a full tutorial playthrough on BOTH checkpoint branches (Extract and Descend,
both ending correctly with the right floor count), Skip-via-pause, a real 2-player co-op
match completing end-to-end, PvP solo-queue Cancel, a simulated matchmaking failure showing
the new error UI, Retry succeeding afterward, and the Squad flow's create→join→start→cancel
all routing correctly — zero console errors throughout. A follow-up pass added full test
coverage for everything that had none, including two files (`net/transport.ts`,
`game/match/onlineConnect.ts`) that had never been unit-tested at all before this — the
latter needed a small DI addition (`fetch`/`sleep`/`createTransport` injection options,
same convention `net/matchmaking.ts` already documents for itself; defaults unchanged, so
every existing caller is byte-identical) to become testable at all. New/extended:
`ModeSelect.test.ts` (9), `Matchmaking.test.ts` (10), `tutorialConfig.test.ts` (3),
`TutorialHintController.test.ts` (6), `floorCount.test.ts` (4), `transport.test.ts` (14),
`onlineConnect.test.ts` (9), plus new cases in `HudView.test.ts`/`RunOutcome.test.ts`/
`PauseMenu.test.ts`/`forge.test.ts`/`confirmEdge.test.ts`. 582 client tests (was 546 at the
start of this pass, 518 before that) + `tsc --noEmit` clean; 1125 across the repo.

**Update (2026-08-03, later still): three more design/10 "Open questions" closed — a local
downed/revive HUD, a PvP match-preview screen, and a left-handed control-layout toggle.** All
render-only / net-layer-optional, no `ENGINE_VERSION` impact.
- **Downed/revive HUD** (`ui/DownedBanner.ts`) — the local seat's own downed state had NO
  feedback at all before this: `AllyRow` (`ui/PlayerCard.ts`) already showed a co-op
  teammate's bleedout countdown, but a downed local player just saw the world go quiet with
  nothing explaining why, for how long, or whether a rescue was even underway. `DownedBanner`
  reads the same `ReviveSystem` fields (`downed`/`bleedoutTicks`/`reviveProgressTicks`) and
  shows a centered "YOU ARE DOWN — bleeding out Xs" banner that switches to a "BEING
  REVIVED…" progress bar the instant a teammate's channel actually starts (bleedout is
  PAUSED, not just slow, during a channel — showing its own frozen number would have read as
  a stall). `AllyRow` got the matching upgrade: a `reviveProgressTicks` param swaps its
  "DOWNED Xs" text for "REVIVING {pct}%" under the same condition. Wired into `HudView`
  (`downedBanner` field, `reposition`/`update`). Browser-verified live in a real `?coop=1`
  run (bot ally in range, local seat forced downed via `window.__game`).
- **PvP match preview** (`game/screens/PvpPreview.ts`, new `'pvpPreview'` `Phase`) — design/10
  had flagged "PvP preset-pick has no UI yet" as an open question; the actual gap turned out
  to be narrower than a picker (`design/15`'s `ARENA_PRESETS` schema supports multiple
  presets, but only one, `landing_basic`, exists today, and there is only one real map,
  `arena_prototype_60`) — so this is a confirm/preview step, not a picker, inserted between
  ModeSelect's PVP SOLO QUEUE button and Matchmaking. It shows the real map name/room count,
  and the player's own PvP-scaled character + landing-kit weapon via `buildArenaSpecs` — the
  SAME function `GameState.buildSeat` calls for a real arena seat, so the preview can never
  drift from what a match actually seats them with. Deliberately does **NOT** run for the
  squad path (`beginSquadMatch`): every party member's poll auto-advances there, so a manual
  confirm gate would desync followers who never see it — `PartyScreen`'s own lobby already
  serves as squad's pre-match review step (see `phase.ts`'s doc comment on `'pvpPreview'`).
  Browser-verified live end-to-end: ModeSelect → PVP MATCH preview (real scaled stats/map) →
  QUEUE → Matchmaking's real connecting/error states.
- **Left-handed control layout** (design/10 "control layout" open question) —
  `SettingsState.controlLayout: 'standard' | 'mirrored'`, migrated/defaulted like every other
  setting. `platform/TouchControls.ts`'s `setMirrored()` swaps which half of the screen
  drives movement vs. aim/fire and re-anchors the weapon-swap buttons to the opposite corner,
  re-laying out immediately against the last known screen size rather than waiting for a
  resize. Threaded through a new optional `InputSource.setControlMirror` (implemented by
  `WebInput`/`WeChatInput`, both proxying to the shared `TouchControls`) so `Game.ts` can
  apply it on boot and on every settings change. `Settings.ts` gained a tap-to-cycle
  `CONTROLS: STANDARD/LEFT-HANDED` button next to the language toggle. Browser-verified live
  (Settings screen, toggles and relabels immediately).

All copy translated across all 8 locales (new `hud.downed.*`/`hud.ally.reviving`/
`pvpPreview.*`/`settings.controlLayout*` keys). 667 client tests (was 582) + `tsc --noEmit`
clean; 1234 across the repo. `npm run check` green on all five packages throughout.

- **5.4 Fidelity roadmap** (01): ✅ post-processing (bloom-lite, vignette, chromatic aberration, hit-stop, screen-shake) + particles shipped 2026-07-26; ✅ ALL FOUR custom shaders (energy shield, outline/hit-flash, dissolve-on-death, heat-haze) shipped 2026-08-03 — `game/fx/filters.ts`'s `EnergyShieldFilter`/`OutlineFilter`/`DissolveFilter`/`HeatHazeFilter`, wired into `Actor`'s live shield/hit/death/burn signals (see 01's milestone 5 for the per-shader detail, including the `Scene.reconcile` architecture change dissolve needed and a Pixi-uniform-precision gotcha worth knowing before writing another filter). Shipped clean against today's placeholder art — the "shaders read best after real art lands" sequencing note from earlier turned out not to matter.

  **Update (2026-08-03): ✅ dynamic lighting (milestone 2) shipped too — Phase 5.4 has no open items left.** Unblocked the same day 5.3 (above) closed the "AI art is placeholder" question milestone 2 named as its own blocker. Ships as a scoped equivalent of design/01's literal "normal maps + point lights + lightmap (multiply composite)" text, not that architecture verbatim: no `RenderTexture`/deferred-lighting layer exists anywhere in this codebase (confirmed by search) and building one would be disproportionate infrastructure for a fixed-camera 2D sim — so this is a fifth custom `Filter` instead, following the exact template the four milestone-5 shaders above already established. New `NormalLitFilter` (`game/fx/filters.ts`) derives a fake per-pixel normal straight from a sprite's OWN rendered luminance/alpha via 4 neighbour-texel taps — the same technique `OutlineFilter` already uses for alpha-edge detection, just reading brightness into a Sobel-style gradient instead of alpha into an edge test — so **no normal-map texture asset exists or is needed anywhere**, matching the "own the code, own the cost" discipline `VignetteFilter`/`HeatHazeFilter` already established. Shaded against a fixed key light (direction reused from `RoomBuilder.ts`'s existing "lit from upper-left" pillar-shading convention, design/10 2026-08-02) plus a small dynamic point-light registry, `game/fx/lighting.ts`'s `LightRegistry` — the local player's own persistent glow (re-registered each frame, `Game.ts`'s `updateFx` wrapper) and transient muzzle-flash/impact bursts (`FxController.flash` now registers a matching light, no new call site). Deliberately NOT a full lightmap: a handful of lights, linear-scanned, nearest/brightest wins — this project never needs more than that at once. `Actor.ts`'s `litFilter` is built eagerly (unlike the four conditionally-active shaders) and always first in `applySkinFilters()`'s list, since every actor is always lit; `Scene.applyLighting()` shades every live Actor (not bullets/pickups) once per render frame. No `ENGINE_VERSION` impact (render-only, design/08). 18 new tests (`lighting.test.ts`'s full `LightRegistry` coverage, plus extensions to `Actor.test.ts`/`Scene.test.ts`/`FxController.test.ts`), `tsc --noEmit` clean, browser-verified live (visible directional shading on both the player and enemy sprites, a `flash()` call live-confirmed to brighten a nearby enemy's `uPointIntensity` and decay back to 0, zero console errors).
- **5.5 WeChat device verification** (04): lowest base library, low-end frame rate, real-device touch, WebGL2 fallback — none of this can be done without a physical device or WeChat DevTools install, neither found on this machine as of 2026-07-27.

---

## Phase 6 — Accounts ✅ (2026-07-29)

Real username/password login (`design/16-accounts.md`), closing every "no account system exists anywhere" scaffold note left by 4.6/the 2026-07-29 squad update (`rating.ts`, `ladderReport.ts`, `PartyService.ts`, `net/identity.ts`). Server: SQLite via Node's built-in `node:sqlite` (no `better-sqlite3` — this dev box has no C++ build toolchain, and the built-in module needs nothing extra), `AuthService` (scrypt password hashing, opaque bearer sessions, no JWT/bcrypt dependency), new `/auth/*`+`/account/*` routes on `matchsvc.ts`. Client: `net/session.ts`+`net/auth.ts`, a `LoginScreen.ts` reachable from a new MainMenu button — logging in is never required to play. `net/identity.ts`'s `getPlayerId()` now prefers the real `accountId`, which is the one seam every downstream caller (party/matchmaking/rating) already read through. Two systems are now actually bound to an account: **PvP ladder rating** (`accountId` threaded through the signed ticket → `MatchRoom.SettledMatch.seatAccounts` → `ladderReport.buildRatingReportBody`'s new optional param, falling back to the old `seat:{roomId}:{seatIdx}` scaffold for guests/bots — fully backward compatible) and **Forge blueprints/materials/loadout** (`meta/accountSync.ts` best-effort mirrors `MetaState` to `/account/meta` once logged in, pulls it back on login). 100 server tests (was 93) + 564 client tests (was 555), both `tsc --noEmit` clean. **A real bug only live browser verification caught (not vitest, not curl):** `matchsvc.ts`'s CORS policy declared `access-control-allow-headers: content-type` only — every bearer-token call (`/auth/me`, `/account/meta`) was silently rejected by the browser's CORS preflight (`Failed to fetch`, no server-side log at all, since curl/Node's own fetch don't enforce preflight). Fixed (`authorization` added to the allow-list) and re-verified live end-to-end via claude-in-chrome: register → unlock a blueprint → log out → clear local state → log in with a changed password → the blueprint reappeared, pulled from the account's real SQLite row.

**Update (same day): expanded test coverage on request.** `matchsvc.ts` refactored for testability (`createMatchsvcServer(opts)` builds the server without starting it; `main()` guarded behind an ESM entrypoint check) so `server/test/matchsvc.http.test.ts` could become the first-ever direct HTTP-layer test in this repo — a real server on an ephemeral port, real `fetch`, and a real CORS preflight assertion that regression-tests the exact bug above. Added a local username blacklist (`usernameFilter.ts` — reserved names + a starter profanity list, no external moderation API configured anywhere in this project). `AuthService` edge cases (boundary lengths, unicode rejection, SQL-injection-style strings proven inert, concurrent-registration race) surfaced and fixed a real gap: username uniqueness/login lookup were case-sensitive, now `COLLATE NOCASE`. `LoginScreen`'s `doLogin`/`doRegister`/`doChangePassword`/`doLogout` gained the re-entrant busy-guard `PartyScreen`'s `doCreate`/`doJoin` already had but this screen had missed. **134 server tests (was 100) + 568 client tests (was 564).** Not built (at the time): third-party OAuth (columns/routing reserved), persisted ladder ratings (still the in-memory `RatingStore`), password reset/rate-limiting — **the latter two are done, see the 2026-08-03 update below.**

**Update (2026-08-03): the two items flagged above are done — ladder ratings persist, login is rate-limited.** `server/src/rating.ts`'s `RatingStore` gained an optional `DatabaseSync` constructor param; when passed (matchsvc.ts now passes its own `openDb()` result), `get`/`applyMatch` read/write `db.ts`'s pre-existing (previously unused) `ratings` table instead of an in-memory `Map`, so a player's ladder rating survives a server restart. Caught a real schema bug before shipping: `ratings.account_id` had a `REFERENCES accounts(id)` foreign key from when the table was first added, but `node:sqlite` enforces FKs by default (unlike a bare `sqlite3` CLI) — inserting a guest/bot's `seat:{roomId}:{seatIdx}` scaffold id (never a real `accounts` row) threw `FOREIGN KEY constraint failed`, a real gap only a test exercising that exact path caught. Fixed by dropping the FK (a rating key was never truly a foreign key into accounts — no real DB file exists on disk yet, so the schema was changed directly rather than migrated). Also added: `AuthService.login` now locks a username out for 15 minutes after 5 consecutive failures (in-memory counter, case-folded key to match the `COLLATE NOCASE` lookup, reset on any success) — a standard brute-force throttle, keyed by username rather than request IP since this server has no IP plumbing today. 142 server tests (was 134), `tsc --noEmit` clean; 1133 across the repo.

**Update (same day, later): expired `sessions` rows are now swept too.** The last of the three items this doc had flagged as not built. `verifySession` already deleted the one expired row it happened to look up, but a session nobody came back to check (e.g. logged in once, never returned) just sat in the table forever. `AuthService.issueSession` (the one place a new row is written) now runs an opportunistic `DELETE FROM sessions WHERE expires_at < now` sweep first — not a background timer, matching the project's existing "no process the team doesn't need yet" convention; `verifySession`'s own hot per-request path is deliberately untouched, so an authenticated request stays one indexed lookup. 144 server tests (was 142), `tsc --noEmit` clean; 1135 across the repo. Still not built: third-party OAuth, email/password-reset flows.

---

## Phase 7 — Internationalization ✅ (2026-08-02)

The project's first i18n system (`design/17-i18n.md`), closing the "every UI string is
a hardcoded English literal" gap across all of `client/src/game/*.ts`. `client/src/i18n/`:
`locales/en.ts` is the canonical/source-of-truth locale (semantic dotted keys, e.g.
`t('forge.title')`, not raw English sentences as keys); `locales/zh.ts` is the first
translation, typed as `Translations<typeof en>` so a missing/extra key is a compile
error, not a silent runtime fallback. `t()`'s own `TranslationKey` type is a
compile-time union of every valid key, so a typo fails `tsc`. The live locale is a
`setLocale()`/`getLocale()` in-process mirror of the persisted `SettingsState.locale`
(same `SettingsStore` convention as volume/mute); a new `Settings` screen `languageBtn`
toggles `en ⇄ zh`. Every screen (`MainMenu`/`PauseMenu`/`Settings`/`Forge`/`HudView`/
`LoginScreen`/`PartyScreen`/`Screens`/`RunOutcome`/`EventReactor`/`compareCard`) migrated
to `t()`. Found and fixed a real correctness bug in the process: `RunOutcome`/`Screens`
used to infer the win/loss result icon by comparing the (now-translated) title text
against English literals — replaced with an explicit `won: boolean` threaded through
`RunOutcomeHost.showOutcomeScreen`. Enum/data-driven values (damage type, weapon kind,
rarity/blueprint/character ids) are deliberately left untranslated — a separate
content-localization effort, not UI-string i18n. 739 client tests (was 681 at initial
ship — a follow-up pass added locale-switch coverage to every migrated screen plus new
suites for MainMenu/PauseMenu/Settings/EventReactor/settings-store, none of which had
any test coverage before), `tsc --noEmit` clean, verified live (English↔中文 round-trip
across every migrated screen).
Also recorded as a standing repo rule (`CLAUDE.md`): all code/comments/docs/commit
messages stay English; translation locale files are the one exception.

**Update (2026-08-03): six more locales, browser-language auto-detect on first boot,
a real CJK word-wrap bug found and fixed, one plural mismatch reworded.** `de`/`fr`/
`es`/`pl`/`ru`/`it` join `en`/`zh` (8 locales total), each a full `Translations<typeof
en>` translation — the existing "locale parity" test already walks every locale
against every `en.ts` key, so all six are covered by the same guard `zh` always had,
no new test-writing needed for coverage. `Settings.ts`'s language toggle became a
`nextLocale()` cycle through all 8 (the old 2-entry `en`⇄`zh` swap doesn't scale).
`index.ts`'s new `detectBrowserLocale(languages)` maps `navigator.languages` to a
supported locale (falling back to English on no match); wired into
`createWebSettingsStore` for a genuinely fresh install ONLY (`localStorage.getItem`
returns `null`) — a pre-i18n or corrupt save still falls back to English via the
existing `migrate()`, since a returning player's implicit "never touched this
setting" should never be silently overridden. Verified live under `zh` (real Chrome)
that Pixi's `wordWrap` — which only breaks at whitespace — genuinely overflows an
unbroken long CJK string instead of wrapping it, exactly as design/17 had
speculated; `TextStyle.breakWords = true` fixed it (`PortalPrompt.ts`'s title text,
the one place today's copy could someday hit it, plus `Forge.ts`'s `infoText` as
defense-in-depth). `results.materialsBanked`'s `'+{count} materials banked'` (wrong
at count=1) reworded to `'Materials banked: {count}'`, a count-agnostic label style
applied pre-emptively across the new locales' own count-adjacent strings too (Polish/
Russian have plural rules far more complex than English's). A follow-up pass then added `wordWrap`/`breakWords`
config-pinning tests to `PortalPrompt.test.ts`/`Forge.test.ts` (the wrap fix itself can
only be verified live — Pixi text layout needs a real canvas — but a test can still pin
the config so a future edit can't silently drop `breakWords` unnoticed). 593 client
tests (was 582), `tsc --noEmit` clean. See design/17-i18n.md for the full account.

**Update (2026-08-15): weapon/character/material/buff DISPLAY NAMES are now translated
too — the "rarity/blueprint/character ids deliberately left untranslated" line above is
superseded, not still accurate.** A player screenshot of the Forge screen showed weapon
names, the character name, and material short codes rendering as raw English tokens
under `zh`. Turned out to be finishing an already-half-built feature, not a new one:
`design/09-content-data.md` had long required a `nameKey: string` field on every content
type for exactly this, and every catalog already carried one (`'weapon.repeater.name'`,
etc.) — it was pure write-only scaffolding, never read by any client code, and no locale
file had a matching namespace. Added `tName()` alongside `t()` (`i18n/index.ts`) — a
deliberate second entry point for dynamic content ids (`t()`'s `TranslationKey` stays a
closed compile-time union, right for a fixed UI-label set but wrong for an open-ended,
ever-growing content catalog), backed by a new parity test
(`i18n/contentNames.test.ts`) that walks the real catalogs and stands in for the
compile-time exhaustiveness `t()` gets for free. New namespaces across all 8 locales:
`weapon.<id>.name` (25), `skin.<id>.name` (3 — `SkinDef` gained a `nameKey` field, the
one type design/09 never gave one), `buff.<id>.name` (4 — the same untranslated-id bug
existed in the buff pickup toast, fixed alongside), `material.<element>.name` (5), and
`hud.elementShort.<element>` (5, replacing `Forge.ts`'s old `e.slice(0,3).toUpperCase()`
— English values unchanged). Fixed call sites: `Forge.ts`, `compareCard.ts`,
`WeaponCard.ts` (also fixed a real cache-invalidation bug this exposed — the redraw-skip
key was still tracking the render-only id, not the new display-name key), `PlayerCard.ts`/
`AllyRow`, `EventReactor.ts`'s pickup toasts. 1205 client tests (was 1205 — net flat;
existing raw-id assertions in `WeaponCard.test.ts`/`PlayerCard.test.ts`/`HudView.test.ts`/
`PvpPreview.test.ts` were updated to expect translated names rather than growing the
count), 577 engine tests, `tsc --noEmit` clean both workspaces, verified live (English↔
中文) via a real Chrome screenshot. `WeaponBlueprint.nameKey` deliberately stayed
unwired — every blueprint id already equals its `weaponId`, so Forge shows the crafted
WEAPON's own translated name for a blueprint row rather than authoring the identical
string twice per locale. One adjacent gap found but left out of scope: `forge.
lockedSource`'s `{source}` (`'purchase'`/`'event'`) still interpolates raw English —
flagged as its own follow-up. See design/17-i18n.md's own dated entry for the full account.

---

## Client hardening pass ✅ (2026-08-04)

Not a feature phase — a full code review of every file under `client/src/` (182 files,
~21.6k lines), split across five parallel reviews (controllers/match, scene/fx,
screens/ui, net/platform, render/meta/settings/i18n), then fixed finding-by-finding. The
two most severe findings (mid-match reconnect never actually wired; a real squad-win
scoring bug) are written up under their own phases above since they're genuine gaps in
already-"closed" functionality, not new work. The rest, all real but lower-severity:

- **`PartyScreen`/`LoginScreen` staleness guard** — `doStart()`/`pollOnce()` (Party) and
  `doLogin()`/`doRegister()`/`doChangePassword()` (Login) had no guard against a stale
  async continuation acting after the player already backed out (`Matchmaking.ts`
  already had this `attemptToken` pattern; these two screens didn't). Concretely: a
  party leader could tap START MATCHING, immediately tap BACK, and still get yanked into
  `beginSquadMatch` once the request landed; logging in and backing out before it
  resolved could silently overwrite a guest run's live `meta` mid-run once it did. Both
  now bump an `attemptToken` on `hide()` and check it before any state mutation/callback
  — `busy` itself always still clears regardless, so a later re-entry to either screen
  isn't left permanently stuck.
- **`weaponSkins.ts` preload/fallback** — `preloadWeaponSkins()` ran every texture load
  through one `Promise.all` with no per-item try/catch (unlike every sibling preloader),
  so ONE failed weapon PNG aborted every other still-in-flight load instead of degrading
  best-effort; separately, `getWeaponTexture`/anchor/scale/rotation only fell back to
  the kind-default silhouette when a weapon id was entirely unregistered, not when it
  WAS registered but its texture simply never loaded — leaving the socket invisible
  instead of the neutral silhouette the file's own header describes. Both fixed
  together so texture and calibration always agree on which entry is actually in play.
- **`net/transport.ts` hardening** — `WebSocketTransport` didn't invalidate itself after
  `close()`/an error, so a `send()` queued before close (e.g. behind `LaggyTransport`'s
  own delay) could still reach the dying socket; and the message listener's single
  try/catch swallowed a bug INSIDE the handler the same way it swallowed a genuinely
  malformed frame, so a `NetInputSource` bug had zero diagnostics. Both fixed: a `dead`
  flag set synchronously in `close()`/on error/close, checked by `send()`; JSON parsing
  and the handler call now have separate error boundaries.
- **`TextInputOverlay`'s documented blur-to-close behavior didn't exist** — its own doc
  comment claimed it tears down "on submit, cancel, or blur," but only Enter/Escape were
  wired. A stray click on a nearby Pixi button (instead of pressing Escape) could be
  intercepted by the still-focused DOM `<input>` sitting on top of the canvas. Now
  implemented, guarded against `close()`'s own `.remove()` synchronously re-triggering
  the same blur handler (removing a focused element fires a native blur).
- **`Slider` had no `pointercancel` handling** — an OS-level interruption mid-drag (e.g.
  an incoming call) left `dragging` stuck true forever; on Settings.ts's three sliders
  sharing one drag surface, the next unrelated pointer move would silently drag the
  stuck slider. Now clears on `pointercancel` like `pointerup`/`pointerupoutside`.
- **`Rig` assumed bones are listed parent-before-child with no validation** — a
  misordered `RigDef.bones` array silently computed a wrong rest angle in the
  constructor, then crashed deep inside `computeFK` with a bare "Cannot read properties
  of undefined" pointing nowhere near the actual mistake. Now fails fast at
  construction with a message naming the offending rig/bone/parent.
- **`main.ts`/`main.wechat.ts` had no boot() error boundary** — a throw anywhere in
  platform/app init or `Game` construction was an unhandled promise rejection; the code
  path that removes `#boot-loading` never ran, leaving an infinite loading spinner with
  no indication anything failed. Extracted into a side-effect-free `bootError.ts`
  (`reportWebBootFailure`/`reportWeChatBootFailure`, unit-testable without triggering a
  real boot) — the web entry now shows a "refresh the page" message; WeChat's mini-game
  shell has no DOM to update but at least logs clearly instead of vanishing silently.
- **`meta/store.ts`'s `migrate()` didn't validate `materialBank` values** — every other
  field filtered ill-typed saved data, this one didn't, so a corrupted/hand-edited save
  with a string quantity broke `forge.ts`'s `sum + e.qty` reduce via string
  concatenation instead of failing safe.
- **`net/auth.ts`'s `fetchMe`/`fetchAccountMeta` could throw a raw `SyntaxError`** on a
  non-JSON error body (e.g. a proxy's HTML page on a 502/504) instead of the clean
  `Error` every other call in the file already produced — missing the same
  `res.json().catch(() => null)` guard `call()` already had.
- **`theme.ts` had Chinese-language comments**, a straight violation of this repo's
  English-only policy (translation/locale data is the only carve-out) — translated in
  place, no behavior change.

30+ new/extended test files, `tsc --noEmit` clean on every workspace throughout,
`npm run check` green end to end (see the updated tally in this doc's header).

---

## Platform-layer test coverage pass ✅ (2026-08-05, "全部加测试")

Closed the last remaining self-flagged gap from a prior audit (`WeChatInput.test.ts`
didn't exist — the one bare-code, mechanically-testable item, per the
daydayup-testing-conventions memory's standing "add tests for everything" preference),
then went further and closed every OTHER untested file under `client/src/platform/`
in the same pass rather than leaving the rest for a future prompt to re-flag. Full
account in design/04-wechat.md's "Adaptation layer" section; summary here:

- **`WeChatInput.test.ts`** (10 tests) — a fake `wx` global capturing registered touch
  callbacks + a fake `Application`, mirroring `WebInput.test.ts`'s own convention.
  Covers layout-on-attach, the movement stick, the fire zone, the INTERACT hold, the
  weapon-switch buttons + `onSwitchWeapon` proxy, multiple simultaneous touches in one
  `changedTouches` batch, and — the one branch `WebInput` doesn't have —
  `touchcancel` closing the stick the same as `touchend`.
- **`audioSynth.test.ts`** (9 tests) — the shared procedural SFX voice table (design/11),
  driven with a fake `AudioContext`/node graph whose `connect()` returns whatever was
  passed in (matching real `AudioNode.connect()`'s own return value, so
  `a.connect(b).connect(c)` chains exactly like production code). Covers `tone()`/
  `noise()`'s exact oscillator/gain-envelope/filter parameters and every one of the 16
  `AudioCue` voices in the table (looped, so a future typo'd/missing voice fails loud).
- **`WebAudio.test.ts`** (12) / **`WeChatAudio.test.ts`** (9) — `../audioSynth`'s
  `playCue` mocked out so these only exercise the two backends' OWN logic: the
  autoplay-gesture resume gate, the `ctx.state === 'running'` play gate, the
  `AudioContext`/`webkitAudioContext` fallback (Web) or `wx.createWebAudioContext`
  absence (WeChat), volume clamping, and — WeChat-only — the "base library claims
  `createWebAudioContext` exists but construction throws" permanent-degrade branch
  (`supported = false`, never retries).
- **`WeChatAdapter.test.ts`** (12) — Pixi's DOM-adapter surface against a fake `wx`.
  The module caches its 2D-context-constructor probe at MODULE scope, so every test
  resets the module fresh via `vi.resetModules()` + a dynamic re-import first — otherwise
  an earlier test in file order would silently pre-populate the cache for every test
  after it. Also covers the WebGL1-detection global-vs-stub-class branch, and the
  `fetch`/`parseXML` not-implemented rejects/throws.
- **`WebPlatform.test.ts`** (3) / **`WeChatPlatform.test.ts`** (3) — only the two
  testable factory methods, `createInput`/`createAudio` (confirms the right class, a
  fresh instance per call). `createApp()` on both is explicitly NOT covered: it
  constructs a real Pixi `Application` and calls a real `app.init()` against a real
  WebGL context, the same class of exemption `Game.ts`/`ArenaCanvas.mount()` already
  have (daydayup-testing-conventions memory) — flagged here rather than silently
  skipped.

Every new file needed nothing beyond a hand-rolled global fake (`wx`/`window`/
`AudioContext`) — no jsdom, no real DOM, matching this repo's existing plain-node
vitest convention throughout. `client/src/platform/types.ts` (pure type declarations,
no runtime code) is the only file in the directory with no test file, correctly so.
48 new client tests (907, was 859), `tsc --noEmit` clean, `npm run check` green end to
end (see the updated tally in this doc's header).

---

## Repo structure pass ✅ (2026-08-02)

Not a feature phase — a four-step reorganization prompted by asking whether the code was
still filed where it belongs. Pure restructuring: **931 tests before and 931 after**
(engine 373 / client 388 / server 134 / animator 23 / map-editor 13), zero behaviour
change, both vite builds and the PvP balance sim green throughout.

1. **`client/src/engine/` → top-level `engine/`.** The deterministic sim core was always
   shared by the client, the server and both tools — all three reached into the client
   package via `../../client/src/engine`, so any client-side directory move silently broke
   the three nobody remembered to update. It is now its own package (`@dd/engine`) with its
   own `tsconfig`/`vitest.config`. That tsconfig deliberately **drops the `DOM` lib and
   narrows `paths` to itself**, so design/06's "the sim core imports nothing and touches no
   host API" stops being a review convention and becomes a compile error. The existing
   source needed no changes to satisfy it — the discipline was already being kept.
2. **`client/src/game/` split by concern.** 52 flat files mixing screens, Pixi scene views,
   input/event controllers, run configuration, net glue and an offline balance harness →
   `screens/ scene/ controllers/ match/` beside the existing `ui/ fx/`. The root keeps only
   `Game.ts`, `theme.ts`, `score.ts`, `coords.ts`, `phase.ts`. `Phase` was extracted out of
   `confirmEdge.ts` (a core flow type was living inside a mouse-edge helper). The PvP
   balance harness moved to `client/sim/`, outside `src/`, so shipped code cannot import it.
3. **Root npm workspace.** One install, one lockfile, one `node_modules`. `npm run check`
   typechecks and tests all five packages in one command — previously impossible. The
   `@dd/*` path map, previously copy-pasted into four tsconfigs and four vite configs, now
   lives in exactly two files: `tsconfig.base.json` (type side) and `build/ddAlias.mjs`
   (bundler side). `tools/png-pipeline/` got the `package.json` it never had.
4. **`game/config.ts` deleted.** Its `playerSpeed`/`playerRadius`/`pickupRadius`/
   `healChance`/`waveBreakFrames`/… were px copies of engine-owned values left over from the
   pre-engine Stage-B loop, and every one had **zero readers** — so this was dead-code
   removal, not the derive-from-engine refactor it looked like. What remained split by
   concern into `theme.ts` (`THEME` palette + `ELEMENT_COLORS`/`RARITY_COLORS`/
   `biomePalette`) and `score.ts` (`SCORE`). There is no `CONFIG` symbol in the client now.

**Reading the older entries above:** every dated entry written before this pass names files at
their pre-restructure paths — `client/src/engine/*` is now `engine/*`, and a flat
`game/Forge.ts` / `game/MainMenu.ts` / `game/PauseMenu.ts` / `game/confirmEdge.ts` /
`game/Screens.ts` is now `game/screens/…`, `game/Actor.ts` / `game/Scene.ts` is
`game/scene/…`, `game/CommandBuilder.ts` / `game/LocalPredictor.ts` / `game/RunOutcome.ts` is
`game/controllers/…`, and `game/pvpConfig.ts` / `game/arenaCatalog.ts` is `game/match/…`.
Those entries are historical records of what shipped when, so they are left as written rather
than rewritten; the mapping here is how to follow them. (`game/config.ts` is the exception —
it was deleted, not moved, per step 4.)

Two portable lessons, both caught here the hard way: a refactoring tool that rewrites
relative imports must also rewrite **`vi.mock('...')` specifiers** (string arguments, not
import statements — missing them makes mocks silently stop applying, which surfaces as
unrelated-looking DOM/canvas failures); and `paths` in a tsconfig that `extends` another
resolve against the **inherited** `baseUrl`, so a package overriding `paths` must restate
its own `baseUrl`.

---

## Room & door model — co-resident PvE floors ✅ (2026-08-04, `ENGINE_VERSION` 33→34)

Design/05's "Room & door model" section (locked earlier the same day): PvE floors move
from the old one-room-at-a-time swap (`SpawnSystem.loadRoom` teleporting on clear, "never
walk through a door") to a co-resident, door-connected floor — every room placed and
stitched into `GameState` at once, matching PvP's `ArenaMap` shape. A room is "in combat"
purely because it has a live enemy (never an authored flag); that locks every door
touching it as a unit and force-regroups every other online, non-downed player onto its
entrance; a cleared room never re-locks.

Engine: `world/dungeon.ts` gained `placeFloor`/`carveDoorGaps`/`buildFloorGeometry` (a
west→east spine placement — the MVP shape, real 2D graph layout deferred) and
`generateFloor` dropped its `stages`/candidate shape (`layout:'branching'` now resolves
its extra pick via one more `roomgenPrng` draw at generation time, not a live player
choice — "the moment of arrival" it used to read facing from no longer exists once every
room pre-exists). `GameState` gained `dungeonRooms`/`dungeonDoors`/`dungeonRoomRuntime`/
`dungeonRoomRects`/`dungeonRoomIndexById`/`dungeonBaseWalls`, replacing
`roomIndex`/`roomTick`/`roomSchedule`/`roomSpawnCursor`/`floorStages`/`floorLayout`. New
`DoorSystem` (step 11.5) owns activation/lock/unlock/force-regroup; `AIDecideSystem` gates
enemy AI behind room activation; `EnvironmentSystem`'s room-id tracking generalized to
dungeon mode (previously PvP-only); `ExtractionSystem`'s dungeon branch checks the floor's
capstone room directly instead of the old floor-wide `wavesExhausted` flag. `world/rooms/
ember.ts perimeterWalls()` no longer carves a centered door gap — every gap is now cut
generically at placement time, at a drawn, non-centered anchor (`~5 positions per wall`
is a snapping-candidate count, not a data constraint). One `ENGINE_VERSION` bump (34) —
a `dungeonEnabled` config has no way to opt into old-vs-new behavior, so the cutover is
atomic — see `config.ts`'s v34 entry for the full 5-part breakdown. 407 engine tests
(was ~340), `tsc --noEmit` clean.

Art: `art/environment/door_{locked,open}_raw.png` generated (GPT Image 2, flat-cel,
alpha-verified) — a hazard-saturated glowing barrier / a desaturated inert frame.

Client, same day: `HudView.ts`'s floor/room chips and floor-progress track were left
broken by the schema change (still read the removed `roomIndex`/`floorStages`) — fixed to
derive "which room" from the local player's own `roomId` via `dungeonRoomIndexById`
(there's no more single global "current room," since every room is live at once and
"current" is inherently per-player), with a tested fallback for the one-tick gap right
after a floor places. Two other now-stale comments (`floorProgressMath.ts`,
`minimapLayout.ts` — both used to claim PvE structurally *couldn't* have co-resident data)
corrected in place. 796 client tests (was 795), `tsc --noEmit` clean.

**Client room rendering ✅ (2026-08-04, follow-up):** research going in found the *base
geometry* already rendered correctly — `state.walls`/`obstacles` are stitched for a whole
floor at once (co-resident, matching PvP's `arenaMap`) and `RoomBuilder.build()` already
drew all of it in one pass, so backtracking between already-drawn rooms already worked.
The real gaps were narrower: doors folded into the generic wall fill (locked) or a bare gap
(open), a lock/unlock flip was invisible after the first draw (`RoomBuilder` only reruns on
`room_enter`, and `DoorSystem` never fires that), and `force_regroup` was silently dropped
by `EventReactor`. Fixed: new `client/src/render/environmentSprites.ts` (same
`Assets.load`/best-effort-preload convention as `biomeTiles.ts`) loads
`door_{locked,open}_raw.png` (processed into `client/public/environment/`, alpha-audited
clean); `RoomBuilder` now excludes a locked door's `passageAabb` from the generic wall loop
by reference identity (`DoorSystem.rebuildWalls` pushes the same object, never a copy) and
draws one `Sprite` per `state.dungeonDoors` entry instead, texture/tint swappable in place
via a new `updateDoors()` (no full rebuild) — falls back to a hazard-red/neutral-grey tint
on `Texture.WHITE` if art isn't loaded. `EventReactor` gained `door_locked`/`door_unlocked`
(→ `onDoorStateChange` → `updateDoors()`) and `force_regroup` (→ `onForceRegroup()` →
`Scene.player.snap()`, collapsing `prevX/Y` onto `curX/Y` so the camera cuts instantly to
the teleport instead of interpolating a pan across the floor — same mechanism
`positionLocal`/new-entity spawn already used `Entity.snap()` for) cases, gated correctly
on `e.playerIds` (entity ids) containing the local player's own id, not `localOwner`
itself. Verified live in the browser (not just unit tests): drove a real generated 2-room
floor, confirmed the door sprite renders in its own gap with no wall/sprite overlap,
confirmed a kill→revive-enemy cycle flips the door's texture in place with the ground
layer's child count unchanged (same sprite instance, no rebuild), and confirmed a
force-regrouped player's view snaps (`prevX===curX`) to the room's exact entrance.
`environmentSprites.ts` got its own preload/fallback registry test, mirroring
`biomeTiles.test.ts`'s "no asset server in this test environment" convention — the one
new file this pass didn't already cover on the first pass ("全部加测试" follow-up). 812
client tests (was 796, +16), `tsc --noEmit` clean.

**Fully-realized branching ✅ (2026-08-05, `ENGINE_VERSION` 34→35):** closes the deliberate
scope cut named above. `layout:'branching'` no longer resolves its candidate at generation
time via a wraparound-offset PRNG perturbation on the same linear pick — a `'branching'`
floor now gets **one real fork-and-reconverge diamond**: `generateFloor` draws which interior
normal-stage transition forks (never stage 0, so spawn stays a single ordinary room), then
resolves that stage to `branchFactor` distinct, same-width sibling `RoomPiece`s (clamped down
to a plain single room, no throw, when the pool has no same-width match — same graceful-degrade
convention `branchFactor` itself already had). `placeFloor` places those siblings side-by-side
(same X, stacked in Y with a gap, centered on the fork point's own vertical center) and
connects each one's own door onward into the next stage's room (ordinary room or capstone) —
the reconvergence, no separate merge-room concept needed. New `FloorStage = RoomPiece |
RoomPiece[]` type; `FloorLayout` gained `stages` (what `placeFloor` now consumes) alongside the
existing flattened `rooms` (kept for back-compat). Needed **zero client changes** —
`DoorSystem`/`RoomBuilder`/`EventReactor` were already topology-agnostic (confirmed by reading
all three before writing any code), so combat-lock/force-regroup/rendering all work on a real
fork for free. Scope cuts, not data-model limits (`Door`/`PlacedRoom` already support an
arbitrary graph, same as PvP's `ArenaMap`): only one fork per floor (no fork-into-fork
chaining), siblings must share one width. `ENGINE_VERSION` bumped (34→35) purely because the
module's own documented `'branching'` draw-sequence contract changed again — no shipped
content used `'branching'` yet (`EMBER_DUNGEON` was `'linear'` at the time), so no real
replay broke. (`EMBER_DUNGEON` later switched to `'graph2d'` instead, 2026-08-05's
"graph2d content" pass, Phase 1 section above — `'branching'` still stays unused.)
19 new/updated engine tests (426, was 407), `tsc --noEmit` clean across all 7 workspaces (1556
total tests, was 1537). One known side effect, left for the minimap-adapter item below to fix:
the client's `FloorProgress` HUD track computes done/current/upcoming purely from `dungeonRooms`
array index, which isn't meaningful once a floor has siblings — a latent inaccuracy with no live
impact today, since no shipped content forks yet.

**PvE minimap adapter ✅ (2026-08-05, same-day follow-up):** decided with the user against
the "not a replacement" framing this section used to have — `FloorProgress`/
`floorProgressMath.ts` are deleted; PvE now shares the exact same `Minimap` widget PvP
already had. Two new pure functions in `minimapLayout.ts`: `dungeonToArenaMap(rooms,
doors)` converts `PlacedRoom[]`/`DoorRuntime[]` into the same `ArenaMap` shape
`computeMinimapLayout` already consumes (`Door` needs no remapping — same type PvP uses;
room offsets normalized to a non-negative origin, since a fork's siblings can have
negative `offsetYGrid`), and `dungeonRoomStatus(runtimes, indexById, roomId)` extends the
existing `RoomStatus` (`safe`/`closing`/`danger`) with a new `unvisited` bucket — exactly
the state an untaken fork sibling needs, closing (not just working around) the
branching-floor inaccuracy the previous entry above documented. `Minimap.update()`'s
signature changed from `(map, zone, players)` to `(map, statusOf, players)` — the caller
now supplies the room-tint resolver, so the one shared widget stays mode-agnostic instead
of hardcoding PvP's zone semantics. PvE also shows other online players' rooms now
(reusing `Minimap`'s existing player-dot rendering as-is), which `FloorProgress` never
could. No engine changes, no `ENGINE_VERSION` bump. 4 client files touched
(`minimapLayout.ts`/`Minimap.ts`/`HudView.ts` + 3 one-line stale-comment fixes citing the
deleted widget), 2 test files deleted, `minimapLayout.test.ts`/`HudView.test.ts` gained
new/updated coverage, `tsc --noEmit` clean across all 7 workspaces.

**"全部加测试" follow-up, same day:** closed the coverage gaps a first read-through left —
`Minimap.ts` itself had never had a dedicated test file (only the pure `minimapLayout.ts`
functions it wraps were tested, and this pass changed its own public `update()` signature),
so it gained one (`Minimap.test.ts`, 12 tests) reading Pixi's internal
`context.instructions` log directly (no renderer attached, same class of workaround
`getLocalBounds()` already is elsewhere in this repo, just precise enough to assert exact
fill color/shape) to verify room tinting per `RoomStatus` (including `unvisited`), door
lines, player-dot presence/color/radius, and redraw-clears-stale-state. Also added:
`placeFloor` fail-loud coverage for a fork's hub/sibling missing an exit, and direct
entranceGrid-tie-break assertions (a merge room's entrance is set from whichever
connecting door is processed first); `dungeonToArenaMap` coverage for negative-offsetX
normalization (symmetric with the Y case a fork actually produces), multi-solid pass-
through, and a doors-empty floor; `dungeonRoomStatus` coverage for a stale/out-of-range
index (distinct from an unknown roomId entirely). 4 new engine tests (430, was 426), 15
new client tests (826, was 811) — 1574 total, `tsc --noEmit` clean.

**Map-editor door placement ✅ (2026-08-05)** — closes the last item from the
original three-item follow-up list (fully-realized branching and the PvE minimap
adapter above already closed the other two). The "~5 positions per wall,
editor-configurable, not wall-centered" instinct used to only have a
procedural-generation-side implementation (`pickDoorAnchor`'s candidate anchors +
PRNG draw); there is now a real PvE map editor to hand-place a door in. See
design/05's "Hand-authored PvE floors" subsection for the full shape: a new
`DungeonFloorMap` content type (analogous to PvP's `ArenaMap`), a new
`placeAuthoredFloor` sibling to `placeFloor` (`world/dungeon.ts`),
`DungeonConfig.floorMaps` as the per-floor-index override `SpawnSystem` checks
before falling back to procedural generation, and a third `tools/map-editor` mode
("PvE Dungeon Floor") reusing `ArenaCanvas`'s move/pan/zoom/door-connect-tool
machinery (a "place a fixed-size RoomPiece instance" tool instead of freehand-draw),
plus a new `validateDungeonFloorMap` save-time gate (piece resolution, no
overlaps, doors on a real shared wall, reachability from the entrance room, the
last room being an extraction/boss piece). No `ENGINE_VERSION` bump (no shipped
config sets `floorMaps`). Verified live in the browser via synthetic event
dispatch (mode/tool switching, room placement with overlap rejection, drag-move,
a real door connect, the save-validation gate blocking a bad capstone). **"全部加
测试" follow-up, same day:** `DungeonFloorCanvas` (the tool's most complex new
file) had zero dedicated tests, matching `ArenaCanvas`/`RoomCanvas`'s own gap —
closed instead of extended, via a confirmed-safe "skip `mount()`, drive the real
private methods directly" technique (see design/05's matching entry for the
full reasoning) — `DungeonFloorCanvas.test.ts`, 28 tests. 49 new tests total (11
engine, 38 map-editor), 1623 total across all 7 workspaces, `tsc --noEmit`
clean.

**Real 2D graph layout ✅ (2026-08-05, same day) — closes the last deliberate scope
cut from this section's original 2026-08-04 entry** ("a west→east spine placement
— the MVP shape, real 2D graph layout deferred"). A new third
`DungeonConfig.layout: 'graph2d'` (alongside `'linear'`/`'branching'`) places a
*generated* floor in real 2D instead of a single axis — `generateFloor`'s own
stage/piece selection is completely unchanged for it (it never forks, same
one-`nextInt`-per-stage stream `'linear'` already uses); what's new is placement,
in `world/dungeon.ts placeFloorGraph2d` — a sibling to `placeFloor`, not a variant
of it, same precedent `placeAuthoredFloor` already set. Each transition walks out
of whichever of the previous room's exits is unconsumed (not the one already used
entering it) and has a matching opposite exit on the next piece;
`roomgenPrng.nextInt` draws a direction only when more than one is viable — the
same "only draw when it matters" discipline `combatPrng`'s crit draw established
(design/07). Consequence: a west/east-only content pool (every `EMBER_ROOMS`
normal piece but `ember_cross`) places every stage after the first exactly like
`'linear'`'s own spine, and only a piece with a free north/south exit (or an
ambiguous first room with both a west and an east exit) actually bends the floor
— a real, if occasionally subtle, expression of 2D freedom rather than a
relabeled clone of the old spine. Throws (fail loud, design/09) if a placement
would overlap an earlier room — a real risk once placement can walk any of 4
directions, unlike `placeFloor`'s single-axis spine where it structurally
cannot happen; this module does not try to auto-avoid it, same "curated content,
not a solver" contract `placeFloor`'s own too-small-for-a-door check already
assumes. No `ENGINE_VERSION` bump (no shipped `DungeonConfig` used `'graph2d'` at
the time — `EMBER_DUNGEON` was `'linear'`; authoring real north/south-exit content
to make a shipped biome actually bend was left as a content task, same "no
shipped content exercises it yet" note `'branching'` and hand-authored floors
both shipped with). 16 new tests (11 `dungeon.test.ts` unit + 2 `generateFloor`
graph2d-selection + 3 `dungeonrun.test.ts` end-to-end integration), 1639 total
across all 7 workspaces, `tsc --noEmit` clean. **Update, 2026-08-05 same day,
"graph2d content" pass (Phase 1 section above):** `EMBER_DUNGEON` switched to
`'graph2d'`, closing this gap — that pass also added a direction-retry to
`placeFloorGraph2d` itself (found necessary by testing the real content, not by
inspection), so this paragraph's "does not try to auto-avoid" overlap-avoidance
claim is superseded; see that pass's own notes and `world/dungeon.ts`'s current
`placeFloorGraph2d` doc comment for the up-to-date contract.

**"加测试" follow-up, same day:** `entranceFromDoor`'s reuse inside
`placeFloorGraph2d` itself now has dedicated east/west AND north/south
assertions (the first pass only re-verified the function directly, via
`placeAuthoredFloor`'s own tests), plus the spawn room's inset/size-half
fallback when it authors no player spawn; a door-anchor "not pinned to one
position" spread check (`placeFloor`'s own existing convention) now covers a
`graph2d` south-going connection too, not just east; a `roomA`/`roomB`
chain-order assertion across a 3-room stretch; and a `CountingPrng` test
subclass asserting the EXACT `roomgenPrng` draw count per door (1 when only
one direction is viable, 2 when a real choice exists) — closing the sharpest
gap, since "a direction is drawn ONLY when more than one exit is viable" is
the module doc's own central claim and the first pass never asserted the
draw count directly. `dungeonrun.test.ts` gained a forced, seed-independent
SOUTH-bending floor (every other dungeon fixture in that file only ever
produces an east-going/vertical door) proving `buildFloorGeometry`'s carving
and `DoorSystem` activation genuinely handle a horizontal (north/south-wall)
door end-to-end. 8 new tests (6 engine unit + 2 integration) — 1647 total
across all 7 workspaces, `tsc --noEmit` clean.

**Bug fix pass ✅ (2026-08-12, `ENGINE_VERSION` 35→36) — two real bugs from a live player
report, not inspection.** The report: "I moved to the door, cleared every enemy in the
room, and still can't walk through it." Two independent, unrelated root causes, both fixed:

1. **`DeathDropsSystem`'s `onDeathSpawn` boss-adds skipped `DoorSystem`'s same-tick
   `hasLiveEnemy` scan.** `BLIGHTLORD` (and any future boss with `onDeathSpawn`) spawns 2
   basic adds the instant it dies (`engine/systems/DeathDropsSystem.ts`), but those minions
   never got a `roomId` — unlike `SpawnSystem.dispatchDungeonSpawns`'s existing "set `roomId`
   DIRECTLY, same tick" fix (its own doc comment already named the general bug class:
   "without it, a room's doors would stay open for one extra tick after its first enemy
   spawns"). `DoorSystem` (step 11.5, right after death/spawns) skips any enemy with
   `roomId===undefined`, so it saw the boss room as cleared for exactly one tick: the door
   unlocked, then — the moment `EnvironmentSystem` tagged the new minions next tick — re-locked
   and force-regrouped the player straight back. From the player's seat: door opens, you walk
   in, door slams shut and yanks you back. Fixed by inheriting `e.roomId` on the minion at
   spawn time, same tick.
2. **`placeFloorGraph2d` could place a room at a negative offset, which the world-bounds
   math never accounted for.** A `'graph2d'` floor's spawn room is pinned at the origin
   (`world/dungeon.ts`); walking out through its `'north'` or `'west'` exit places the next
   room at a NEGATIVE `offsetXGrid`/`offsetYGrid` (`placeAdjacent2d`). `buildFloorGeometry`'s
   `worldW`/`worldH` is a running max seeded at 0 — blind to negative extents — and
   `MovementSystem.clampToWorld` hard-clamps every player to `[margin, worldW - margin]` with
   no lower bound below 0. A player standing at (or trying to cross) a negative-offset door
   was physically walled off from ever reaching the room beyond it, even though the door
   itself had genuinely unlocked. (The minimap adapter above already normalized negative
   offsets for RENDERING — `dungeonToArenaMap`'s "room offsets are normalized to a
   non-negative origin" note — but that never touched the actual walkable-world bounds.)
   Fixed by having `placeFloorGraph2d` shift the WHOLE floor (every room's offset + entrance,
   every door's passage rect) by the same delta once, right before returning, so the minimum
   offset on each axis lands at exactly 0 — a pure translation; every relative adjacency the
   function already computed is unaffected. `'linear'`/`'branching'` (`placeFloor`) only ever
   walk west→east (+ south-only hub forks) and so never produce a negative offset — a
   deliberate no-op for them, never even reached.

Both bugs are real, replay-affecting changes for `EMBER_DUNGEON` specifically (already
`'graph2d'` since the "graph2d content" pass above) — not just docs-contract bumps, hence
`ENGINE_VERSION` 36. 2 new regression tests (`engine/systems/doors.test.ts`'s "onDeathSpawn
adds never open a walk-back-out window", `engine/world/dungeon.test.ts`'s "never leaves a
negative offset on any room") — 2631 tests green across all 7 workspaces (root build-script
corrected from a stale "14" to its actual "7" while touching this count — same class of
pre-existing miscount the header above already flagged once for desktop-shell/root), `tsc
--noEmit` clean.

---

## Documentation pass ✅ (2026-08-02)

Prompted by "are the docs complete and self-consistent?" — a full audit of all 19 `design/`
docs plus every README against the actual code. Docs and `art/` only; zero code changes, 931
tests and `tsc --noEmit` green before and after.

The drift had one dominant shape, worth naming because it will recur: **a doc gets a dated
"Update:" paragraph appended, but the Status blockquote at the top is never edited.** So
`12-art-animation.md` opened with "nothing here is built yet" above six paragraphs describing
the shipped art pipeline; `art/README.md` said production assets didn't exist; `10-ui-hud.md`
still called the touch controls invisible four days after `TouchControlsView.ts` shipped;
`client/README.md` opened with "currently a vertical slice" and listed a jump key and a block
key that no longer exist; and this file's own line 5 was headed **"Current built state"** while
quoting `ENGINE_VERSION` 17 against a real 31. **When auditing docs here, read the top-of-file
Status block against the code first — that is where the stale claim lives, not in the body.**

Also fixed: commit `82b7aa1` (MainMenu contrast/hierarchy) had shipped with no doc entry at all
— it now has one above, plus the rule it produced in `10`'s decisions; `design/README.md`'s
index was missing `16-accounts` and `17-i18n` and never pointed at this file; `engine/` — the
most important package after the restructure — had no README while `client/` and `server/` did;
`06`'s migration steps 1–4 were unmarked despite being done, and that file carried the repo's
only unbalanced ``` fence; and `09`'s one genuinely stale path (`game/Actor.ts`). Older entries
in this file keep their pre-restructure paths on purpose — see the mapping note in the Repo
structure pass above.

`art/` was renamed to match its own stated convention (`<id>_raw.png`, `_alt`/`_alt2` for
rejected attempts, never a generator UUID): 21 UUID-named files identified by decoding pixels
with `tools/png-pipeline/pngCodec.mjs` and matching against the shipped `client/public/` copy —
for art whose background was later removed, by **dark-outline silhouette occupancy** rather than
colour, which separates a true source (~0.01–0.03) from a rejected attempt (~0.37) cleanly. That
also surfaced 8 byte-identical duplicates (`art/Skirmisher/` and `art/Juggernaut/` were copies of
files already in `art/units/`), now deleted with both directories collapsed into `art/units/`,
and three enemy concepts misfiled under `art/map/`.

---

## Test coverage audit pass ✅ (2026-08-05)

Prompted by "全部核查项目的tests，该补的补，该删的删" (fully audit the project's tests — add what
needs adding, delete what needs deleting) — a from-scratch audit of every source file across all
7 workspace packages against its test coverage, run as parallel per-workspace sweeps rather than
by precedent/memory of what was tested before.

**该删的删 (deletions): nothing found.** Every workspace came back clean — no orphaned tests
(source file deleted, test left behind), no stale imports (test importing a symbol that no
longer exists), no exact-duplicate coverage, and zero `.skip`/`.todo`/commented-out test bodies
anywhere in the repo. The suite had no rot to clear.

**该补的补 (additions): ~50 files closed, 891 new tests** (1736 → 2627): `engine/systems/
targeting.ts`/`AIDecideSystem.ts`/`nearest.ts` and `content/ballistics.ts`/`materials.ts` (real
logic only ever exercised transitively via consumer tests before); `server/src/config.ts`/
`db.ts`; a `client/src` sweep across `game/match/*Config.ts`, `meta/{store,MetaState,
accountSync}.ts`, `game/scene/{Skin,Bullet,Portal,Backdrop,layers}.ts`, `game/theme.ts`,
`game/coords.ts`, `render/{skinRegistry,taoBundle}.ts`, `game/fx/{Particles,filters}.ts`
(`VignetteFilter`/`ChromaticAberrationFilter` had literally never run for real anywhere — every
existing test mocked the whole module out), and `settings/SettingsState.ts`; and, in `tools/`,
`map-editor`'s `ArenaCanvas.ts`/`RoomCanvas.ts` (the stated "needs `mount()`/DOM" exemption
carried over from `DungeonFloorCanvas.ts`'s own precedent turned out to be stale — same
unmounted-constructor technique applies), its state layer (`RoomEditTarget.ts` + all 3
`*Document.ts` classes), and its `fields.ts`/`Inspector.ts`/`EncounterTable.ts` UI (a small
hand-rolled fake-DOM-element helper, no jsdom); `animator`'s core (`EventBus`/`CommandManager`/
`AppState`), io layer (`EditorProjectIO.ts`/`TaoExporter.ts`/`AutoSaveController.ts` — the
largest untested files in the workspace), `InteractionController.ts`/`AnimationController.ts`,
`TimelineView.ts` (a hand-rolled call-recording fake `CanvasRenderingContext2D`, since Canvas2D
has no built-in "what got drawn" introspection the way Pixi's `Graphics.context.instructions`
does), its remaining UI panels, and `ProjectStore.ts` (a from-scratch minimal fake IndexedDB —
no `fake-indexeddb` dependency existed in the repo, and none was added); `png-pipeline`, which
had **zero test infrastructure at all** before this pass (no `vitest` devDependency wired, no
`test` script), now has both plus real `pngCodec.mjs` coverage; and `desktop-shell`'s
`preload.ts`/`preloadSidebar.ts` (driven through a mocked `electron` `contextBridge`/
`ipcRenderer`, same convention as its existing `main.test.ts`).

Two small, behavior-preserving production changes fell out of chasing "mechanically testable,
just needs a seam" rather than accepting an exemption at face value: `server/src/index.ts` got
the same `createGameserver(opts)` factory + run-only-when-main guard `matchsvc.ts` already had,
so a real-HTTP integration test could exercise it the way `matchsvc.http.test.ts` does; and
`tools/map-editor/src/main.ts`'s mode-transition/tool-visibility branching moved into a small
pure `modeLogic.ts` so it could be unit-tested directly instead of staying trapped in an
entry-point shell with top-level DOM side effects.

One real bug surfaced and was deliberately left unfixed as out of scope for a test-only pass
(documented inline in the new test instead): `tools/animator/src/io/TaoExporter.ts`'s
`restoreAnimationData` (used by `.tao` re-import) never calls `state.setAllLengthScales(...)`,
unlike `EditorProjectIO.loadEditorBlob`'s equivalent path — a `.tao` re-import silently drops
any per-bone length customization. `tools/desktop-shell/src/preload.ts`'s `onRequestSave` was
also found to send its save-ack even when the save callback's promise rejects, without ever
catching that rejection (an unhandled-rejection, not a hang) — spun off as a separate follow-up
rather than folded into this pass. **Follow-up (✅ 2026-08-05):** fixed — `onRequestSave` now
catches both a rejecting promise and a synchronously-thrown callback (the latter a second,
related gap found while adding the fix's test), logs via `console.error`, and always sends
the ack. `TaoExporter.restoreAnimationData`'s bug is still open.

`npm run check` (typecheck + full test suite, all 7 workspaces) is clean before and after.

---

## File-length convention pass ✅ (2026-08-12)

Ported the sibling project `funny`'s "single file ≤500 lines" convention
(`claudedocs/server.md`/`claudedocs/client-modules.md`, "单文件 500 行收敛") into this repo,
scaled down for its smaller codebase: the rule + split-priority order (independent function
modules → independent classes + composition → linear inheritance chain, fallback only) now
lives in `CLAUDE.md`; `build/checkFileLength.mjs` (one shared, extension-configurable
implementation, unlike funny's per-workspace copies) + a `scripts/file-length-baseline.json`
per workspace enforce it as a baseline-drift gate — `check:filelength` wired into every
workspace's `package.json` and folded into the root `check` script (after `typecheck`, before
`test`).

**Then applied it**, per the plan the introduction pass laid out as backlog: `engine` had 4
files over the limit, all fixed the same day (baseline now empty — 0 tracked exceptions):
- `engine/config.ts` (567→76): the bulk was `ENGINE_VERSION`'s ever-growing replay-
  compatibility changelog — a documentation-placement problem, not a code-organization one.
  First split into a same-shape `.ts` file (`versionHistory.ts`), which itself landed at 505
  lines; moved the prose to `engine/ENGINE_VERSION_HISTORY.md` instead (checkFileLength only
  scans `.ts`/`.tsx`, and ~500 lines of changelog prose was never code to begin with).
- `engine/state/GameState.ts` (528→381): pure type/interface declarations (`EngineConfig`,
  `PlayerConfig`, `ZoneState`, `ArenaRoomRuntime`, `DungeonRoomRuntime`, `DoorRuntime`, …) split
  into `GameState.types.ts` — form ①, zero logic, re-exported wholesale so every existing
  import path is untouched.
- `engine/content/weaponSpecs.ts` (578→17-line assembly): `WEAPON_SPECS` is a content table
  with zero shared state between entries — split by the catalog's own pre-existing section
  comments into `weaponSpecs/{starter,dropOnly,elemental,frameLibrary,frameElemental}.ts`.
- `engine/world/dungeon.ts` (772→70-line assembly): a batch of pure, side-effect-free
  functions with no `this`/classes — form ① textbook case. Split into
  `dungeon/{types,placementConstants,generateFloor,placeFloor,placeFloorGraph2d,
  placeAuthoredFloor,entranceGeometry,floorGeometry}.ts` by concern (selection vs. each of the
  three placement strategies vs. geometry stitching), sharing a small leaf helper
  (`entranceGeometry.ts`) between the two placement functions whose doors can land on any of a
  room's four walls.

All four were pure code-motion (zero behavior change) verified by `tsc --noEmit` + the full
engine suite (548 tests) staying green throughout, plus a runtime check that the reassembled
`WEAPON_SPECS` still has all 25 entries.

`client/src/game/Game.ts` (1348 lines, by far the largest file in the repo) got two real
composition extractions rather than a full atomization: `controllers/ForgeActions.ts` (craft/
cycle-character/acquire/clear/browse-cursor — takes `MetaState` + screen size as plain
parameters, zero callbacks back into Game) and `controllers/ScreenFlow.ts` (the 7 `showX()`
methods' hide-everything-then-show-one widget mechanics, plus settings/pause — Game keeps
owning `phase` itself since the main loop/run lifecycle/forge actions all read it equally, so
`ScreenFlow` never calls back into Game either). Both follow this repo's own established
host-callback-interface pattern (`RunOutcome.ts`/`EventReactor.ts`) and got real test coverage
(`ForgeActions.test.ts`, `ScreenFlow.test.ts`, 19 new tests) — using the same fake-canvas
`DOMAdapter` seam `Forge.test.ts` already established for the `Text.height` layout reads.
Landed Game.ts at 1256 lines (still over 500, tracked in the client baseline with a detailed
inline rationale): the remainder (run lifecycle + the main sim/render loop) genuinely fails
the split-priority order's own cross-call test — nearly every remaining method reads/writes
`phase`/`engine`/`session`/`meta`/`scene`/`roomBuilder`/`fx` in combination, not a short
countable list crossing one clean boundary, so forcing a further split now would relocate the
same coupling through more callback ceremony rather than remove it (CLAUDE.md's own "genuine
two-way dependency" guidance). `Game.ts` itself still has no dedicated test file (a
longstanding, user-accepted exemption — constructing it needs a live Pixi `Application`); the
screen-flow/pause/settings/run-start/quit sequence was instead verified live via
`window.__game` headless driving (menu → modeSelect → forge → beginRun → pause → resume →
quitRun → settings open/close), confirming every phase transition and widget-visibility flip
plus zero console errors.

`npm run check` (typecheck + `check:filelength` + full test suite, all 7 workspaces) is clean
before and after; `engine`/`server`/`tools/*` all sit at 0 tracked file-length exceptions,
`client` at 1 (`Game.ts`, documented above).

**Follow-up (✅ same day, 2026-08-12): the main loop.** User asked specifically to split
"Game.ts's remaining main loop" — `controllers/GameLoop.ts` now owns `update()`'s three
phase branches (playing/paused/idle), the offline fixed-step loop (`advanceSim`/`stepSim`),
its online counterpart (`advanceOnline`, latency-hiding local-player prediction), and the
render-side adapters they share (`spawnBulletTrails`/`updateFx`/`updateCamera`/`updateHud`/
`pollConfirm`) — plus the accumulator (`acc`), rising-edge confirm latch (`prevFire`), and
online predictor (`predictor`/`predLastTick`), none of which were read anywhere outside
those methods, so they moved in as `GameLoop`'s own private state rather than staying on
Game. Takes a `GameLoopDeps` bundle of already-independent collaborators (scene/fx/hud/
touchControlsView/portalPrompt/roomBuilder/partyScreen/builder/ally/input/events/
runOutcome/tutorialHints — none of which call back into Game themselves) plus a narrow
`GameLoopHost` (phase/online/coop/arenaDemo/tutorialActive/localOwner/engine/session reads,
`activeState`/`currentScore` reused from the existing EventReactorHost/RunOutcomeHost
methods, plus `markTutorialSeen`/`confirm` — both genuinely shared with run-lifecycle so
they stay host-owned). `resetForNewRun()`/`resetOnlinePrediction()` replace Game's direct
`acc`/`predictor` field pokes from `resetRunRenderState`/`finalizeOnlineRun`. 17 new tests
against a real `createGameEngine` (same convention as `controllers/ally.test.ts`) plus
faked Pixi collaborators (same convention as `EventReactor.test.ts`'s fake `FxController`)
— covering phase dispatch, the fixed-step cadence and its `MAX_STEPS` catch-up cap,
coop/arenaDemo ally-seat driving, hit-stop freezing `stepSim` but not rendering, the online
session lifecycle (not-started/started/gameover-reporting), and both reset hooks. Verified
live via `window.__game` (real offline run: 10×16ms frames → tick 4, matching the 30Hz
accumulator math; pause genuinely freezes the tick, resume continues it; tutorial run ticks
and quits to the right phase) — zero console errors throughout. Landed Game.ts at **1029
lines** (1348→1256→1029). What's left — `start()`'s screen-callback wiring (inherently
belongs in the assembly shell), the constructor, run lifecycle (`beginRun`/
`beginTutorialRun`/`beginArenaDemoRun`/`finalizeOnlineRun`/`quitRun`/`resetRunRenderState`),
matchmaking/network glue, and the now-trivial host-interface one-liners — is recorded in the
client baseline's updated inline note; run lifecycle specifically is the next real
candidate if this gets revisited.

---

## Live-play bug-fix pass ✅ (2026-08-12, user report from a dungeon-mode screenshot)

Three bugs reported from a live screenshot (`FLOOR 1/3 · ROOM 2/2` HUD chip, i.e. dungeon
mode):

1. **Stuck after clearing a non-final-floor room.** Root cause: the 2026-08-04 "Room & door
   model" pass (above) rewrote `ExtractionSystem`'s dungeon branch to check the floor's
   capstone room directly (`activated && !hasLiveEnemy`) instead of the old floor-wide
   `wavesExhausted` flag, but the client-side render gate — then `Game.ts`, now
   `GameLoop.ts`'s `updateHud` — was never updated to match, and kept reading
   `s.wavesExhausted` (which dungeon mode's `SpawnSystem.tick` returns before ever setting).
   The portal's open/closed visual and the extract/descend popup were therefore permanently
   gated shut on any non-final floor — masked on the LAST floor only, where
   `ExtractionSystem`'s own capstone check auto-resolves regardless of what the client
   thinks. Fixed by mirroring `ExtractionSystem`'s per-mode condition into a new
   `checkpointReached()` (`client/src/game/match/floorCount.ts`, alongside the existing
   `totalFloorCount()` — same "engine's private logic needs a render-side copy" pattern),
   used by `GameLoop.ts` in place of the raw `wavesExhausted` read. Also fixes a second,
   latent mismatch the old code had even in flat/non-dungeon mode's shape: dungeon mode's
   capstone check was never supposed to be ANDed with a global `enemies.length === 0` (a
   co-resident floor can have a live mob in some OTHER room while the capstone itself is
   clear) — `checkpointReached()` folds the right per-mode condition into one place instead
   of composing it at each call site.
2. **Dark bars around a small floor, reported as "viewport doesn't scale with the window."**
   Confirmed NOT a resize-tracking bug (window size was unchanged the whole time, per the
   user) — it's `FxController.updateCamera`'s intentional small-room contain-fit zoom
   (design/10, 2026-08-02) hitting its `MAX_ZOOM` cap on a floor narrower than the viewport,
   with `Backdrop` filling the leftover void in the biome's (deliberately very dark)
   `void` palette colour — visually indistinguishable from an unrendered black canvas. Per
   the user's choice among three options (brighten the void colour / raise the zoom cap /
   leave as-is), raised `MAX_ZOOM` 1.8 → 2.5 (`client/src/game/fx/FxController.ts`), shrinking
   the void for undersized floors without touching anything already viewport-sized+.
3. **Energy-shield glow rendering off-centre ("leaning to one side").** `EnergyShieldFilter`'s
   shader (`fx/filters.ts`) hardcodes texture-coordinate (0.5, 0.5) as the character's centre,
   but the filter is applied to `Actor`'s whole `skin.view`, whose auto-computed bounds are
   asymmetric — the Graphics placeholder's facing-direction "front" wedge and a real rig's
   aim-mounted weapon sprite both extend outward on one side only, dragging the
   auto-bounds' centre (and therefore the shader's UV origin) along with them. Fixed by
   pinning an explicit, fixed, symmetric `filterArea` on `skin.view` (`Actor.ts` constructor,
   `±3×radiusPx` centred on the actor's true local origin) — every skin-level filter now
   renders against a stable area that doesn't drift with facing/weapon pose.

13 new tests (`floorCount.test.ts` ×7 for `checkpointReached`'s dungeon/flat-mode cases
including the co-resident-room regression, `Actor.test.ts` ×3 for `filterArea` centering,
`GameLoop.test.ts` ×3 end-to-end through `updateHud`/`setPortalOpen`) plus the matching
`FxController.test.ts` cap-value update. 1134 client tests (was 1121), 548 engine tests
unaffected, `tsc --noEmit` and `check:filelength` clean across all 7 workspaces.

---

## Viewport-fill bug-fix pass ✅ (2026-08-12, follow-up — a second, real "viewport doesn't
fill the window" report)

A different bug from item 2 of the pass above — that one was confirmed NOT a resize bug
(a small floor's intentional zoom-cap void, mistaken for one); this one IS a real
resize/layout bug, reported this time from the **main-menu** screen (not a dungeon room),
via a user screenshot showing black bars along the right and bottom edges of the window.

Root cause: `Game.screenSize()` computed `app.renderer.width / app.renderer.resolution`,
on the assumption that `.width` is a device-pixel size needing conversion back to
logical/CSS pixels. Empirically, in this Pixi build (`autoDensity: true`,
`platform/web/WebPlatform.ts`), `.width` is ALREADY logical and equal to
`.renderer.screen.width` — so that division silently shrank every screen's whole layout
to `1/devicePixelRatio` of the real viewport. Invisible at devicePixelRatio 1 (division
by 1 is a no-op — most quick local checks run at 100% display scaling), so it kept
surviving review; real on any HiDPI display — reproduced live via `claude-in-chrome`
(real Chrome, not the sandboxed Browser-pane tool, which has its own unrelated
non-compositing limitation — see [[daydayup-engine-conventions]]) at devicePixelRatio 1.5:
game content rendered into only the top-left ~2/3 of the canvas.

Fixed by reading `app.renderer.screen.width/height` directly — Pixi's own documented
logical render-area size, no resolution math needed. Extracted the one-line formula into
a new `client/src/game/viewport.ts` (`computeScreenSize`) purely so it's unit-testable
without a live Pixi `Application` — `Game.ts` itself still has no test file (documented,
standing exemption), but there was no reason the formula it delegates to needed the same
exemption. 4 new tests (`viewport.test.ts`) covering resolution 1, the exact HiDPI
regression case (1.5), resolution 2, and non-integer window sizes. Landed with `Game.ts`
one line UNDER its 1029-line baseline (1028) rather than growing it. 1138 client tests
(was 1134), `tsc --noEmit` and `check:filelength` clean.

---

## Portal placement + VFX pass ✅ (2026-08-12, follow-up — a third user screenshot,
same dungeon-mode run)

The visible-but-open portal from the "Live-play bug-fix pass" above landed in the wrong
place: a user screenshot showed it sitting in a corridor/doorway area outside the room
it belonged to, and separately asked for a more convincing "space-time portal" look than
the original static ring + glow.

1. **Wrong position.** `RoomBuilder.buildPortal` centered the portal on `(w/2, h/2)`,
   where `w`/`h` are `fpToPx(s.worldW/worldH)`. In dungeon mode those are the bounding
   box of the floor's WHOLE co-resident room set (`buildFloorGeometry`), not the single
   checkpoint room — on any floor with more than one room, that box's center can land in
   a corridor or on a wall instead of inside the capstone (extraction/boss) room. Fixed
   by centering on `state.dungeonRoomRects[state.dungeonRoomRects.length - 1]` instead —
   the capstone room's own rect, always the LAST entry (`SpawnSystem`'s own convention,
   already relied on by `ExtractionSystem.capstoneCleared`). Flat (non-dungeon) runs never
   populate `dungeonRoomRects`, where `w/h` already IS the single room's size, so the old
   `w/2, h/2` center is kept as that mode's fallback — unchanged behavior there.
2. **VFX redesign.** `Portal.ts`'s single static ring + one pulsing ellipse read as a flat
   sticker, not a gate. Rebuilt from four layers, all still plain Pixi `Graphics` (no new
   art asset, no shader) reusing `THEME.colors.extractGlow`: a wide additive ground bloom,
   a standing dark-rimmed arch (the pillar-shading "highlight/shadow band" trick), a
   two-ring vortex around a bright core that spin in opposite directions at different
   speeds (turbulent "event horizon" read from two static shapes, just spun via
   `rotation`), and a handful of motes that spiral inward and vanish on a deterministic,
   golden-angle-spaced schedule (matter falling into the portal — no `Math.random`, so
   the animation stays reproducible frame-to-frame). Verified live via `claude-in-chrome`
   (the sandboxed Browser-pane tool can't composite frames — see
   [[daydayup-engine-conventions]]): instantiated `Portal` directly onto the running app's
   stage and screenshotted the spin/particle motion across two frames.

17 new tests (`RoomBuilder.test.ts` ×4 for capstone-vs-flat-mode centering, a single-room
dungeon floor, and re-centering across a floor transition; `Portal.test.ts` rewritten for
the new 4-layer structure plus counter-rotation, radius-scaled vortex/core geometry, and
the particle field's determinism/redraw-not-accumulate/actually-moves properties). 1150
client tests (was 1134 — some prior Portal tests were replaced, not just added to),
`tsc --noEmit` and `check:filelength` clean.

---

## Shield-centering follow-up + rig-art aliasing fix ✅ (2026-08-12, follow-up — a fourth
user screenshot, same character/monster-legibility report)

Two more bugs off the same screenshot ("角色和怪物的图片看起来不对，根本看不出特点" /
"护盾没有将角色放在中心位置" — character and monster art unreadable, and the shield glow
doesn't centre on the character).

1. **The "Live-play bug-fix pass" shield fix (item 3, above) only fixed HALF the
   problem.** That fix pinned `EnergyShieldFilter`'s `filterArea` to a fixed square
   centred on `skin.view`'s local `(0,0)` — which stopped the glow drifting sideways
   with facing/aim (the bug it targeted), but its own test only ever exercised the
   Graphics placeholder (no `skinRegistry` mock in `Actor.test.ts`), so it never caught
   that a real rig's decorative bones hang off the body bone's TIP, not its centre
   (`orbCoreRig.ts`: `char_vanguard`'s eye/belly/weapon-socket bones all sit roughly one
   body-length above the `shell` bone's own origin). That makes the assembled character
   consistently top-heavy relative to `(0,0)` — pinning Y to a flat 0 left the glow
   hugging the ground/feet while the top of the sprite poked out above it, which is
   exactly the follow-up report. `critter-core`'s single-bone enemies have no such
   offset, which is why the first fix looked complete at the time. Real fix: `Actor.ts`'s
   constructor now calls `skin.setFacing(0,0,0,'idle')` once and measures
   `skin.view.getLocalBounds()` for that rest pose, centring the filter square's Y on the
   MEASURED bounds centre instead of an assumed 0 (X stays pinned at 0 — that asymmetry
   genuinely is facing-dependent, so baking in one frame's reading would just move the
   bug). Confirmed live via `claude-in-chrome`, not just the unit test: the shield glow
   now evenly surrounds the whole character instead of sitting low.
2. **Character/monster art reads as unidentifiable blobs at actual gameplay scale.**
   Traced to the ART PIPELINE, not the art itself — pulling `orb-core`'s source PNGs
   directly (`shell.png`, `eye.png`) shows a well-drawn robot body and a distinct blue
   cartoon eye. The problem: those sources are ~1254px, but a decorative bone like `eye`
   renders at only ~13px on screen at `char_vanguard`'s gameplay `radiusPx` — a ~96:1
   minification ratio. `Assets.load` was requesting these textures with NO mip chain
   (`autoGenerateMipmaps: false`, confirmed via the live texture source), so bilinear
   filtering at that ratio only samples a 2×2 texel neighbourhood per output pixel —
   textbook un-mipmapped aliasing, which reads as unrecognizable colour noise on
   anything with fine detail (worse for the small, high-contrast `eye` than the larger,
   flatter `shell`). Fixed in `taoBundle.ts`: `Assets.load` now passes
   `{src, data: {autoGenerateMipmaps: true}}` for every texture it loads, not a bare url
   string. Confirmed live two ways: the GL sampler state
   (`gl.getTexParameter(...,TEXTURE_MIN_FILTER)`) now reads `LINEAR_MIPMAP_LINEAR` with
   an 11-level chain (was 1 level), and an isolated render of just the `eye` sprite (every
   other bone + the mounted weapon hidden) now shows a clean, correctly light-blue circle
   instead of the aliased smear. NPOT (1254px, not power-of-two) was a real risk — Pixi's
   WebGL backend gates auto-mipmap generation on `nonPowOf2mipmaps` support — but this
   project's context reports that `true` (WebGL2), so it wasn't blocked. The fix is
   generic (every loaded rig texture, not special-cased to Vanguard's eye), so it should
   help every skin sharing the same "huge source, tiny on-screen radius" shape
   (`critter-core`/`brute-core`/etc.) — only re-verified live for `char_vanguard`.

Separately **flagged, not fixed**: even with the eye rendering cleanly, the mounted
weapon sprite sits almost on top of the eye/face cluster in normal play (both anchor
near the `shell` bone's tip), so the gun still visibly covers a good chunk of the face at
gameplay scale — a weapon-socket-position/z-order question, out of scope for this pass.

4 new tests (`Actor.test.ts` ×3 — X-pinned assertion split out on its own, a
placeholder-Y-matches-measured-bounds regression, and a real-rig repro using the same
faked-bundle-over-a-real-`Rig` trick as `Skin.test.ts`; `taoBundle.test.ts` ×1 asserting
every `Assets.load` call carries `data.autoGenerateMipmaps: true`). 1154 client tests
(was 1150), `tsc --noEmit` clean.

---

## Boss-room instant-extract bug fix ✅ (2026-08-12, follow-up — a fifth user report:
"打完boss直接就退出房间了，掉的东西都没捡" / killed the boss, got kicked out of the room
immediately, never got to pick up its drops)

Root cause: `ExtractionSystem`'s LAST-floor branch resolved `EXTRACT` — `state.phase =
'gameover'` — the instant the capstone room's `activated && !hasLiveEnemy` went true,
which is the SAME tick the boss dies (`DeathDropsSystem` spawns its drops a few steps
earlier in that same tick's system order, `PickupSystem` a few steps after — but the run
was already over before the player could ever walk to them). This was a deliberate
design decision (design/05 "the boss fight was the challenge, walking through the portal
after is automatic") — `GameLoop.ts`'s `updateHud` even explicitly excluded the last
floor from opening the portal/popup at all, since `ExtractionSystem` never waited on one.
Live play showed the "automatic" framing read as "instant," not "walk up and it just
works" — reversed per the user's own follow-up spec ("boss打完之后出传送门,玩家主动通过
传送门退出" / "打完boss玩家原地停留" — a portal should open and the player should stay put
until they choose to leave through it).

Fix, three files: (1) `ExtractionSystem.tick` drops the LAST-floor early-return
entirely — every floor now resolves identically off `p.confirmExtract`/`confirmDescend`,
with the last floor's only remaining special case being `confirmDescend` staying a no-op
(no next floor to descend to). (2) `GameLoop.ts`'s `checkpointEligible` drops its
`&& !isLastFloor` clause, so the portal opens on the last floor too, exactly like any
other checkpoint; `updateHud` now also passes `isLastFloor` through to
`portalPrompt.update`. (3) `PortalPrompt.update` gained that third `isLastFloor` param
(default `false`, so every pre-existing call site is unaffected) — hides the Descend
button and re-centres Extract into its slot, so the last floor's popup reads as one
deliberate choice instead of a two-button prompt with a dead half. Net effect: the boss's
own death drops (materials auto-collect on proximity, weapons via the loot panel) are
reachable exactly like any other floor's before the player chooses to leave.

10 new/updated tests across 4 files. `extraction.test.ts`: the last-floor checkpoint no
longer resolves without an explicit `confirmExtract`; a `confirmDescend` press there is
ignored; plus a full end-to-end regression for the actual reported bug — a material drop
placed 50 grid units from the player survives the checkpoint opening untouched
(`PickupSystem` doesn't vacuum it from a distance), gets collected into
`floorMaterials` once the player actually walks over, and still banks into
`bankedMaterials` on the `confirmExtract` the player presses afterward. `dungeonrun.test.ts`:
both its capstone-clear integration tests (the plain last-floor case and the
live-enemy-elsewhere-on-the-floor case) now assert the checkpoint WAITS after the capstone
clears, then press `CONFIRM_EXTRACT` explicitly instead of asserting an auto-resolve.
`GameLoop.test.ts`: the portal now opens on the last floor too; `isLastFloor` is passed
through to the popup. `PortalPrompt.test.ts`: Descend hidden/shown across `isLastFloor`
true/false/back-to-false.

Also verified live against the running dev client (`window.__game`, same
screenshot-times-out workaround as this doc's other entries): jumped a real run to its
last floor, killed the boss capstone's enemy, confirmed `phase` stayed `'playing'` and the
portal opened, confirmed the popup showed Extract only (Descend hidden), then tapped
Extract and confirmed `phase` went `'gameover'`/`winner: 0` — the full user-facing flow,
not just the unit-level assertions above.

Engine suite: 552 tests (was 549 before extraction/dungeonrun edits, net +3 there since
one old auto-resolve assertion was replaced rather than added alongside). Client suite:
1161 tests, unchanged count (existing tests rewritten in place, no new files).
`tsc --noEmit` and `check:filelength` clean across all 7 workspaces.

---

## Camera cover-fit + weapon-slot HUD chip ✅ (2026-08-12, follow-up — a sixth user
request, from an annotated screenshot: the current room should fill the viewport as much
as possible; show the OTHER carried weapon next to the active one, tappable to swap; and
confirm a melee attack targets the nearest enemy, falling back to the character's own
facing when there is none)

Two real changes plus one confirmation that no change was needed:

1. **Camera: contain-fit → cover-fit (closes the void gap item 2 of the "Live-play
   bug-fix pass" above left open).** That earlier pass raised `MAX_ZOOM` 1.8→2.5 to *shrink* the dead void beside
   a narrow room, but a room whose aspect ratio just doesn't match the viewport's still
   left a real, un-rendered void on one axis — raising the cap further couldn't fix an
   aspect-ratio mismatch, only a too-low cap. Asked the user to pick between eliminating
   the void entirely (cover-fit: zoom by whichever axis needs MORE zoom, room can exceed
   the viewport and pan/crop with the player) or keeping the whole room always visible
   and just repositioning the leftover void; the user picked cover-fit. Fix is a one-line
   formula change in `FxController.updateCamera` (`client/src/game/fx/FxController.ts`):
   `Math.min(vw/worldW, vh/worldH)` (contain-fit) → `Math.max(1, vw/worldW, vh/worldH)`
   (cover-fit, still capped at `MAX_ZOOM`) — the existing clamp-to-room-bounds branch for
   `cx`/`cy` already handled "room bigger than viewport, pan with the player" (needed
   before for arenas/big rooms), so it just runs for the previously-letterboxed axis too,
   no new code. `Backdrop`'s void-color rect is now only a safety net for a
   `MAX_ZOOM`-capped degenerate/tiny room, not the common case. Tradeoff, confirmed
   accepted by the user: a door/wall can scroll off-screen while the player is elsewhere
   in the room (visible near the top of the screen only when the player is actually near
   it) — same as any camera-follow game. Confirmed live via `claude-in-chrome`: a room
   that previously showed dark void bands on both sides now fills edge-to-edge with zero
   void.
2. **The idle weapon slot is now shown, and tappable to swap** (closes the gap `10`'s own
   HUD table used to call out: "the HUD shows the active weapon only"). New
   `WeaponSlotChip` (`client/src/game/ui/WeaponSlotChip.ts`) — a small, dimmed icon chip
   using the same rarity-bordered-chip look as the active `WeaponCard`'s own icon, just
   quieter, so it visibly reads as "idle." Wired into `HudView.ts` immediately right of
   the active `WeaponCard` (x tracks the card's own name-length-dependent width every
   `layout()`, so a long weapon name never overlaps it), hidden whenever the loadout has
   fewer than two weapons. Tapping it doesn't target a slot directly — a player carries
   at most two weapons (`PlayerActor.weapons`), so "tap the idle slot" and "cycle the
   active slot" are the same action — `onTap` routes through `HudView.onSwapWeapon` to
   the exact same `CommandBuilder.requestSwap()` the keyboard (1/2) and touch corner
   buttons already use (`Game.ts`). Confirmed live via `claude-in-chrome`: the chip
   renders next to the active card, and tapping it actually flips `activeSlot` and swaps
   which weapon the active `WeaponCard` shows.
3. **Melee targeting — checked, already correct, no code change.** `ApplyInputSystem`
   already faces a player at the nearest hostile (any range) every tick if one exists,
   else the movement direction, else it holds its last facing — and a melee swing (and a
   ranged shot) already fires along that same facing (design/10 v33's auto-face). This
   already matches the request; nothing needed changing.

New tests: `FxController.test.ts`'s 3 zoom-math tests updated for the cover-fit formula
(including a rewritten case proving zero letterbox void on the axis that used to have
one), `HudView.test.ts` +3 (chip shows/hides by loadout size, positions right of the
active card, tap fires the swap callback), and a new `WeaponSlotChip.test.ts` +9 (tap
wiring mirrors `Button`'s own "press ≠ activate" contract; the icon's cache-key guard,
same shape `WeaponCard.test.ts` pins for the active card, verified via a mocked
`render/weaponSkins` texture since real weapon art needs `Assets.load`). `tsc --noEmit`
and the full client suite green.

---

## "Which one is me" ground ring dropped, two-report follow-up (2026-08-14)

Same lineage as the 2026-08-02 legibility pass and the 2026-08-12 shield-centring fixes
above — a live user screenshot, circled: a cyan ring around their own character looking
"only half drawn." Two rounds:

1. Root cause: `Actor.setLocal`'s ground ring shared the body sprite's own y=0 "feet"
   origin (see `BODY_LIFT_R`), so its top half sat behind the lifted, opaque body and got
   painted over — same geometry a shadow uses, but a shadow is supposed to be occluded by
   its caster and this identity ring is not. Fixed by moving the ring to a zIndex in
   front of the body instead of behind it, so the full ellipse always renders.
2. Immediate follow-up report on the now-fully-visible ring: it and `EnergyShieldFilter`'s
   rim-glow (`01`) are both cyan and both wrap the character, so a live shield pool and
   "this is you" became visually the same effect — the exact ambiguity the marker exists
   to prevent, just relocated from "ring vs body" to "ring vs shield." Asked the user how
   to resolve it (recolour the ring / hide it while shielded / drop it and rely on the
   health-bar outline alone); picked dropping the ring. `Actor.setLocal` now only flags
   `isLocal` and forces the health bar to re-outline in `THEME.colors.player` teal
   (`setHealth`'s existing local-outline branch, unchanged) — that outline never occupies
   the same screen space as the shield glow, so the two can no longer be confused. `10`
   updated to match. `Actor.test.ts`'s ring-specific assertions replaced with one covering
   the new no-extra-child invariant; the health-bar-outline test is untouched. Render-only,
   no `ENGINE_VERSION` impact. 1170 client tests green, `tsc --noEmit` and
   `check:filelength` clean.

## `isqrt()` 32-bit-overflow fix + fixed-point math test coverage (2026-08-14)

`engine/math/fixed.ts`'s `isqrt()` (design/06's integer square root, used for every
distance check in `geom.ts`/`HitResolveSystem.ts`/`MovementSystem.ts`) silently returned
a wrong, much-too-small result for any input `n >= 2^32` (e.g. `isqrt(5_000_000_000)`
returned `26552` instead of `70710`). Root cause: the digit-by-digit algorithm's `bit`
starts at the largest power of 4 ≤ n and can legitimately exceed 2^31 for large n, and
once `res` picked up that large value the loop's `res >> 1` / `res >>= 1` coerced `res`
to a 32-bit **signed** integer (JS `>>` semantics) each iteration, silently
wrapping/corrupting it. Fixed by replacing both `res >> 1` sites with
`Math.trunc(res / 2)`, matching this module's existing style of using `Math.trunc` for
integer division elsewhere (`bit`'s own `Math.trunc(bit / 4)` was already safe). No
`ENGINE_VERSION` bump — every real caller's distance stays within a single dungeon room
(well under the 2^32 threshold), so this only corrects the previously-broken,
never-actually-reached large-input range; no shipped-content result changes.

There was no dedicated test file for `isqrt()` before this pass (`fixed.test.ts` existed
but only covered a 0–10000 sweep, never large n), so the bug had never been caught. Added
regression coverage: exact values straddling the 2^32 boundary, the reported repro, a
realistic Fp-squared-distance sweep up to a 10,000-grid room, and perfect-square
exactness up to `~sqrt(Number.MAX_SAFE_INTEGER)`. Also rounded out the rest of
`fixed.ts`'s coverage (per the standing "add tests for everything" habit) with negative-
result `addFp`/`subFp`, negative-operand `mulFp` truncation direction, zero/negative
`scaleFp` coefficients, negative `fp`/`fromFp` round-trips, and `negFp`'s `-0` edge case
— 15 tests total in `fixed.test.ts` (was 6). `tsc --noEmit` clean.

## Forge blueprint grid: icon cards replace the row list (2026-08-14)

User feedback on a screenshot of the Forge outpost: "这里不要用列表的形式，用图标卡的形式进行展示"
(don't use a list here, show it as icon cards). `Forge.ts`'s blueprint picker was still a
vertical stack of one-`Button`-per-row text lines (weapon icon + monospace-padded id/cost/
status columns) — closed the same "still looks like a text list" complaint design/13's
2026-08-01 art pass first addressed for the row backgrounds, this time for the rows'
own layout shape.

Shipped: a new `ui/BlueprintCard.ts` widget — weapon art centered on a rarity-bordered
icon chip, name/cost/status stacked below it, a `[n]` key tag top-left (same shortcut
digits as before), and a compact `▸×N` staged-count badge top-right. `Forge.ts` now lays
`PAGE_SIZE` (8) of these out as a 4×2 grid instead of a vertical stack; the browse cursor
(`selectedIndex`) is a bright accent border on the current card rather than the old
leading `»` text glyph — a grid has no "line start" for an inline glyph to sit at, so the
highlight moved to the one thing every card already draws: its own border. Page-nav/
acquire/clear button x-positions now derive from the grid's own measured half-width
(`GRID_W / 2`) instead of the hardcoded `cx ± 280` the row list used. Pure presentation:
no `MetaState`/craft-transaction logic touched, same click-to-craft and keyboard-shortcut
behavior as before (`Forge.test.ts` updated to read the new card's text getters instead of
the old `Button.label`).

Browser-verified live via claude-in-chrome (real crafting flow: main menu → mode select →
forge, pages 1 and 2) — cards render with correct rarity-colored borders, amber "need
materials"/gray "locked" status coloring, dimmed icons on locked cards, and no overlap
with the page nav, acquire button, or forger NPC art. New `ui/BlueprintCard.test.ts` (13
tests) covers text-field updates, icon add/remove based on texture presence, the locked-
icon dim, the selected-vs-rarity border color (read via `Graphics.context.instructions`,
the no-renderer technique `Minimap.test.ts` established), and the press-vs-tap contract
(matches `Button`'s own, `widgets.test.ts`). 1180 client tests (13 new) + `tsc --noEmit` +
`check:filelength` clean throughout. Render-only, no `ENGINE_VERSION` impact.

---

## Dependency summary

```
Phase 0 (sync)  ─┬─ 0.1 affix removal ──┬─ 0.2 rarity
                 │                       └─ 0.3 run-buffs ── 0.6 pickup names
                 └─ 0.4 shield ── 0.5 characters
                    (0.7 doc pass after all)
Phase 1 (in-run loop)   ALL DONE (✅). 1.2 rooms/1.3 dungeon generation AND live wiring (generated multi-room floors, room-to-room traversal, branching, WaveScript timing — this is what the real client runs); 1.4 extraction/1.5 materials work over either the generated-dungeon or flat single-arena mode. 1.1 frames independent (✅ done)
Phase 2 (meta)          ALL DONE (✅) — forge + tier-gated craft + 3-char roster + monetization scaffolding
Phase 3 (co-op/net)     ALL DONE (✅). 3.2 revive/downed engine-side; 3.1 net layer = EngineConfig.players (the 2nd player) + @dd/engine/net + server/ + CoopSession, loopback-verified byte-for-byte; live N-player render wired (localOwner seam + ?coop=1 bot ally), browser-verified. 3.3 matchmaking control plane = matchsvc + HMAC tickets + ticket-verified /ws + client ?online=1, two-tab browser-verified (byte-identical lockstep) + render-layer LocalPredictor (movement/aim, snap-vs-lerp, ?lag= harness). NOTHING deferred (local firing prediction is a documented non-goal — needs sim rollback). 2026-08-04: mid-match reconnect (resume ticket + gameserver handshake routing + CoopSession.reconnect()) actually wired end-to-end — the wire protocol/server logic existed since 3.1 but was unreachable dead code until this pass; the local player's own walk animation (a real, separate render bug) also fixed — see the Phase 3 update above.
Phase 4 (PvP)           COMPLETELY DONE (✅ 4.1 through 4.6, design/15, no open items). 8p solo BR decided; team/hostility (ENGINE_VERSION 18) + multi-room broadphase/stitching + zone/EnvironmentSystem + placement win condition + in-arena loot/AI + anti-cheat checkpoints (ENGINE_VERSION 19) + sparse net sync + matchsvc ladder rating all shipped and tested. End-to-end match assembly wired (2026-07-26): mode:'coop'|'pvp' threaded through Matchmaker/ticket/MatchRoom/matchsvc, client ?pvp=1 -> arena EngineConfig (teamId per seat) -> placement gameover screens -> CoopSession.reportResult actually fires (was dead code for coop too) -> checkpoint/ladder settlement. The real ~60-room ArenaMap (arena_prototype_60.json, a concurrent session) is wired into ARENA_CATALOG. buildArenaSpecs' HP-scale/loadout preset is now called from GameState.buildSeat too (ENGINE_VERSION 19->20) — a PvP seat's weapons/maxHp/maxShield come from the scaled arena preset, never the PvE loadout. All browser-verified two-tab, byte-identical. 2026-07-29: the 4.1 "squads/revive reserved interface" is now built too (ENGINE_VERSION 29->30) — pre-formed party invite (server/src/PartyService.ts) + squad-chunked Matchmaker/teamId + squad placement/gated bandage revive + a PartyScreen lobby UI; see the Phase 4 update above. 2026-08-04: fixed a real squad-win scoring bug (RunOutcome compared seat identity instead of team membership, so most of a winning squad saw a DEFEAT screen) — see the Phase 4 update above.
Phase 5 (presentation)  parallelizable throughout
Client hardening pass   DONE (✅ 2026-08-04) — full client/src code review (182 files), fixed in place: PartyScreen/LoginScreen staleness guards, weaponSkins preload/fallback resilience, net/transport.ts dead-socket + swallowed-handler-exception fixes, TextInputOverlay blur teardown, Slider pointercancel, Rig bone-order validation, main.ts/main.wechat.ts boot() error boundary, meta/store.ts materialBank validation, auth.ts non-JSON error guard, theme.ts English-policy fix. See the Client hardening pass section above.
Room & door model       DONE (✅ 2026-08-04/05, ENGINE_VERSION 34→35) — PvE floors co-resident + door-connected (placeFloor/carveDoorGaps/buildFloorGeometry, new DoorSystem: activation/lock-unlock/force-regroup), replacing the old one-room swap. HudView.ts fixed to compile against the new schema. Client room rendering shipped same day: door_{locked,open}_raw.png loaded and wired onto RoomBuilder's per-door Sprite (reactive lock/unlock in place via updateDoors(), no full rebuild), EventReactor reacts to force_regroup with a local-player camera snap. Fully-realized branching shipped 2026-08-05 (ENGINE_VERSION 35) — a real fork-and-reconverge diamond of sibling rooms, needing zero client changes (DoorSystem/RoomBuilder/EventReactor already topology-agnostic). PvE minimap adapter shipped same day — FloorProgress deleted, PvE now shares PvP's own Minimap widget via dungeonToArenaMap/dungeonRoomStatus (minimapLayout.ts). Map-editor door placement shipped same day (no engine version bump) — DungeonFloorMap/placeAuthoredFloor/DungeonConfig.floorMaps + a third tools/map-editor mode ("PvE Dungeon Floor") + validateDungeonFloorMap, closing the last item of the original three-item follow-up list. "全部加测试" follow-up added DungeonFloorCanvas.test.ts (28 tests, previously zero coverage on the tool's most complex new file). Real 2D graph layout (`layout: 'graph2d'`, `placeFloorGraph2d`) shipped same day too — a generated floor can place in real 2D instead of a forced west→east spine. "graph2d content" pass shipped 2026-08-05 (same day): `EMBER_DUNGEON` switches to `'graph2d'` (a new `ember_atrium` piece + wider exit authoring on `ember_pillars`/`ember_extraction`/`ember_boss`), and `placeFloorGraph2d` gains a direction-retry fallback for fold-back overlaps — both found necessary by testing the real content, not by inspection. `'branching'` still stays unused by any shipped config. **Bug fix pass shipped 2026-08-12 (ENGINE_VERSION 35→36):** two real bugs found from a live player report (door unlocked but still physically impassable) — `DeathDropsSystem`'s `onDeathSpawn` boss-adds now inherit the dying boss's own `roomId` (was `undefined`, so `DoorSystem` briefly saw the room as cleared and force-regrouped the player back), and `placeFloorGraph2d` now shifts a floor's whole coordinate space so a north/west hop off the origin-pinned spawn room never leaves a room (and its door) at a negative, physically-unreachable offset. See the Room & door model section above.
Phase 6 (accounts)      DONE (✅) — real username/password login (SQLite via node:sqlite), never required to play. Bound to PvP ladder rating (accountId in the signed ticket -> MatchRoom.seatAccounts -> ladderReport, guest/bot fallback preserved) and Forge MetaState (best-effort /account/meta sync). Independent of Phases 1-5; third-party OAuth reserved, not built.
Phase 7 (i18n)          DONE (✅) — client/src/i18n/: en.ts canonical + zh.ts translation, both compile-time key-checked (Translations<typeof en>, TranslationKey). Every screen migrated to t(); Settings gained a language toggle backed by SettingsState.locale. Independent of Phases 1-6; enum/data-driven values (damage type, weapon kind, rarity/ids) deliberately left untranslated.
Documentation           DONE (✅ 2026-08-02) — all 19 design docs + every README audited against the code; stale top-of-file Status blocks rewritten (12/10/client/art READMEs and this file's own header), design/README index completed, engine/README written, art/ UUID filenames + duplicate files cleaned up. Docs-only, no code change.
Repo structure          DONE (✅ 2026-08-02) — engine/ hoisted to its own top-level package (DOM-free, self-only paths: the determinism rule is now compile-enforced); client/src/game/ split into screens|scene|controllers|match; root npm workspace with a single `npm run check` across all 5 packages; game/config.ts deleted (dead pre-engine duplicates) and split into theme.ts + score.ts. 931 tests before and after, zero behaviour change.
Test coverage audit     DONE (✅ 2026-08-05) — full test-coverage sweep across all 7 workspaces; zero dead/obsolete tests found (nothing to delete); ~50 previously-untested files closed, 1736 → 2627 tests. See the Test coverage audit pass section above.
```
