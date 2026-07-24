# Implementation roadmap

Ordered task list to take DayDayUp from the current **combat-sandbox vertical slice** to the **full closed loop** the design docs describe. Work top-to-bottom; within a phase, respect the noted dependencies.

**Current built state (2026-07-24):** floors → checkpoint → extract-or-descend → bank, on a single-arena/wave geometry — menu/victory/defeat shell, waves, pickups, damage + elemental status + resist, deflect, one boss, plus the placeholder audio seam. Deterministic engine (fp/brad/PRNG/InputSource/replay) is in place. **Phase 0 (design↔code sync) is done through 0.7** — the engine matches the locked design: no affixes, intrinsic weapon rarity, run-buffs, two-pool shield health + regen + shield-break, characters = SkinDef (side-grade roster), and the design/09 pickup vocabulary (`heal`/`material`/`weapon`/`buff`). **Phase 1 (1.1–1.5) is done**: `spread`/`homing`/`lob`/`beam`/`boomerang` ballistics + melee `hammer`/`spear`; AABB tile/wall solids + the `RoomPiece` schema + seeded `generateFloor` (neither yet wired into a live floor transition — see the Phase 1 status note below); and a live, tested `EngineConfig.floors` → `ExtractionSystem` → materials-banking loop using the existing single-arena infrastructure. **`ENGINE_VERSION` is 16** (bumped once for the orbit/radial frame finish; every other Phase 1–2 item shipped additively — see `config.ts`'s version-history comment). **Phase 2 (meta loop) is done through 2.4** — forge, tier-gated crafting, the 3-character roster + balance suite, and monetization grant-scaffolding all ship.

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
- **Render/audio:** the `'affix'` case + `CONFIG.colors.pickupAffix` in `game/Game.ts`; the `'pickup.affix'` cue in `platform/types.ts` + `WebAudio.ts` + `Game.consumeEvents`.
- **Done when:** no `affix`/`Affix` symbol remains, tests green, replay regenerated, version bumped.

### 0.2 ✅ 🔴 Intrinsic rarity (03/09/14) — *after 0.1* — DONE (additive, no bump)
Rarity becomes a fixed weapon property, not a roll count.
- Add `balance/rarity.ts`: `RarityTier = 'common'|'fine'|'epic'|'legend'|'legendary'` (白蓝紫橙金) + `RARITY_TIERS` quality multipliers (a *small* edge — design/14).
- Add `rarity: RarityTier` to `WeaponSpec`/`WeaponSimSpec` (`content/weapons.ts`, `state/entities.ts`); apply the quality mult at build/convert time.
- **Done when:** every weapon has a rarity, HUD/compare-card can read the tier colour (🟢 render side).

### 0.3 ✅ 🔴 Run-buffs = the in-run power layer (14/09) — *after 0.1* — DONE (v10→11)
Replaces affixes as the moment-to-moment power fantasy (design/05).
- Add `balance/runbuffs.ts`: `RUN_BUFFS` families (`mult_damage`/`mult_firerate`/`flat_hp`/`crit`/…) + `BUFF_CAPS` (Σ-then-clamp, fixed order — deterministic).
- Player-level buff stack (reuses the slot the deleted `affixes: Affix[]` freed); a `'buff'` pickup kind; apply to player/all weapons.
- **Done when:** a buff pickup measurably changes stats, summed-and-clamped, replay-stable.

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

The core PvE loop (floors → extraction → bank) is fully designed (05/09) but unbuilt — today it's one arena of waves.

- **1.1 ✅ 🔴 Frame library** beyond `straight` (design/03 landing order) — DONE (`ENGINE_VERSION` 14→15, then 15→16 for the tier-4 finish). Shipped: `spread` emission (WeaponFireSystem, combatPrng jitter), `homing`/`lob`/`beam`/`boomerang` ballistics (`content/ballistics.ts` + `ProjectileStepSystem`/`HitResolveSystem`), melee `hammer`/`spear` frames (pure data — `MeleeSimSpec` was already generic). Then the tier-4 finish (`ENGINE_VERSION` 15→16): `orbit` ballistic (a projectile that circles its owner, tracking the moving owner each tick — new `Projectile.ownerId`/orbit fields + `orbitStep`) and `radial` emission (a PRNG-free even ring; `RangedSimSpec.pattern` = `'spread'`|`'radial'`, `'spread'` the byte-identical default). Nine showcase weapons in the drop pool (scattergun/seeker/mortar/lasercutter/tomahawk/hammer/spear + novaburst/gyre). Only `k_*` on-hit procs remain unbuilt (a later content-tuning tier, not a frame gap).
- **1.2 ✅ RoomState collision geometry** (07/09) — DONE, additive (no `ENGINE_VERSION` bump). AABB tile/wall solids (`state.walls`, `MovementSystem`/`ProjectileStepSystem`) + the `RoomPiece` schema + `roomGeometry()` converter (`content/rooms.ts`). Spawn/exit markers are part of the shipped schema; nothing places a piece into a live run yet — that's 1.3.
- **1.3 ✅ Seeded dungeon assembly** (05/09) — generation DONE, additive (no `ENGINE_VERSION` bump). `world/dungeon.ts DungeonConfig` + pure `generateFloor()` (floors × rooms via `roomgenPrng`, `layout:'linear'` only) + a first hand-authored `RoomPiece` library (`world/rooms/ember.ts`, 4 normal + 1 extraction + 1 boss). *Remaining (pushed into 1.4/1.5, which need it together with the checkpoint/banking to form a testable loop):* wiring a generated floor into a live, traversable `GameEngine` run — mutable room geometry, room-to-room transitions, the `WaveScript` encounter format actually driving spawns, `'branching'` layout.
- **1.4 ✅ Extraction rooms** (05) — DONE, additive (no `ENGINE_VERSION` bump). `EngineConfig.floors?` (floors after the first) opts a run into the checkpoint loop; a new `ExtractionSystem` (step 12) resolves the per-floor checkpoint (`wavesExhausted && enemies.length===0`) into `EXTRACT` (a sustained INTERACT hold — a deliberate commitment, mirrors the revive-channel precedent) or `DESCEND` (a tap — reloads the next floor's waves). Death forfeits the floor buffer for free (a run-ending death simply never reaches the bank step). The last floor auto-resolves as `EXTRACT` with no gesture (design/05 "the boss room IS its extraction room"). *Shipped using the existing single-arena/wave infrastructure, not the 1.2/1.3 RoomPiece system — see the "what's still not live" note below.*
- **1.5 ✅ Materials carry-out** (05/09) — DONE, additive. `state.floorMaterials` (this floor's un-banked buffer, filled by `PickupSystem`) merges into `state.bankedMaterials` (the run's only carry-out) on every `EXTRACT`/`DESCEND`. `rollDrop` gained an optional depth `tier` param (`DeathDropsSystem` passes `state.floorIndex`) so a material pickup/event carries a rolled instance tier — first-pass "material quality shift per floor" (a straight `tier = floorIndex` identity curve; `DungeonConfig.materialTierByDepth` remains an unwired schema field for when 1.2/1.3's RoomPiece system is live).

**Phase 1 status (2026-07-24): the loop closes end-to-end, on the demo's single-arena geometry.** A run can now go floors → checkpoint → EXTRACT-or-DESCEND → bank, with materials as the only carry-out — the whole point of Phase 1. What's still NOT live: each "floor" reuses the same arena/room (no distinct `RoomPiece` geometry per floor, no room-to-room traversal within a floor, no `'branching'` layout) — 1.2's AABB walls / 1.3's `generateFloor` are real and tested but not yet the thing a floor transition actually loads. Wiring `generateFloor` + `roomGeometry` into `ExtractionSystem`'s descend step (swap `state.walls`/`state.obstacles`, spawn via the piece's `WaveScript` instead of a flat `WaveDef`) is the natural next increment, whenever multi-room floors matter more than the economy loop did.

## Phase 2 — Close the meta loop ✅ (2026-07-24)

- **2.1 ✅ Forge outpost** (14/09): blueprint unlock (permanent) + per-run craft from materials. Recipes are `element × qty × min-tier` — and **`minTier` is now enforced**: the material bank keys by (element, rolled tier) via `bankKey` (additive, no bump — tier 0 keeps the flat key), so a premium recipe (e.g. emberblade: fire×2 minTier 1) genuinely demands materials from deeper floors; spending is lowest-qualifying-tier-first.
- **2.2 ✅ Loadout screen** (10): up to 2 crafted weapons carried into a run via `EngineConfig.loadout`; none → auto pistol. Lives in the demo forge outpost (`game/Forge.ts`).
- **2.3 ✅ Character roster + select** (14/09/13): the **3 launch characters** ship — vanguard (6/4), skirmisher (3/8), juggernaut (9/0, the flat-HP tank). Full side-grade balance suite (`skins.test.ts`): Pareto-non-domination, per-axis spread, equal-worth budget band, no inert passive on a zero-shield body. All free for now (paid split is the store's job).
- **2.4 ✅ Monetization scaffolding** (14): direct-purchase blueprint/character grant APIs (`acquireBlueprint`/`grantCharacter`/`purchasableBlueprints`), no gacha. Real billing is deliberately out of scope (a platform adapter would call these after its own payment flow).

**Deferred out of Phase 2 (not blocking the loop):** touch/WeChat forge input (web-keyboard only today); the outpost's real art/NPCs (design/13 → Phase 5 art pipeline); a real billing adapter.

## Phase 3 — Co-op & netcode

- **3.1 🔴 Net layer** (06): server frame-broadcast + `NetInputSource` + local-player prediction/reconcile. (Migration steps 5→6 in design/06.)
- **3.2 🔴 Co-op revive/downed + team-wipe end** (05/07): the ~15 s revive channel is locked; **decide** revive count, downed vulnerability, and what ends a run on total wipe (open Q in 05).

## Phase 4 — Close PvP (decide design first)

PvP is scaffolded, not closed. **Resolve the open design decisions before building.**
- **4.1 DESIGN** (05 open Qs): win condition (elimination/score/objective), arena-AI role (hazard/objective/farm), the preset set (count + archetypes).
- **4.2 🔴 Arena build wall** (09): `ARENA_PRESETS` + `buildArenaSpecs(presetId, skinId)` (no weapon param — the structural wall) + hard-wall tests.
- **4.3 In-match pickups** (05): the on-map power-up table, equal for both teams.

## Phase 5 — Presentation & platform

- **5.1 Audio finish** (11): WeChat `InnerAudioContext` backend + real/authored SFX (license-checked) + music/ambience. (Web placeholder seam already ships.)
- **5.2 UI/HUD** (10): real Pixi widget kit (bars, toasts, compare card, minimap), settings incl. SFX/music volume.
- **5.3 Art pipeline** (12/13): port funny's `.tao` editor, author the orb-core rig + character atlases, replace the Graphics placeholders; concrete element/biome palette.
- **5.4 Fidelity roadmap** (01): normal-map lighting → post-processing → particles → shaders.
- **5.5 WeChat device verification** (04): lowest base library, low-end frame rate, real-device touch, WebGL2 fallback.

---

## Dependency summary

```
Phase 0 (sync)  ─┬─ 0.1 affix removal ──┬─ 0.2 rarity
                 │                       └─ 0.3 run-buffs ── 0.6 pickup names
                 └─ 0.4 shield ── 0.5 characters
                    (0.7 doc pass after all)
Phase 1 (in-run loop)   ALL DONE (✅). 1.2 rooms/1.3 dungeon shipped as pure schema+generation (not yet wired into a live floor); 1.4 extraction/1.5 materials shipped live, on the existing single-arena geometry instead of waiting on that wiring. 1.1 frames independent (✅ done)
Phase 2 (meta)          ALL DONE (✅) — forge + tier-gated craft + 3-char roster + monetization scaffolding
Phase 3 (co-op/net)     needs Phase 1 (a run to co-op through)
Phase 4 (PvP)           4.1 design decision → 4.2/4.3 ; needs 0.5 (characters) + 0.2 (rarity irrelevant here)
Phase 5 (presentation)  parallelizable throughout
```
