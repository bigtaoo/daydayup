# Implementation roadmap

Ordered task list to take DayDayUp from the current **combat-sandbox vertical slice** to the **full closed loop** the design docs describe. Work top-to-bottom; within a phase, respect the noted dependencies.

**Current built state (2026-07-24):** single-arena wave-survival — menu/victory/defeat shell, waves, pickups, damage + elemental status + resist, deflect, one boss, `straight` bullets only, plus the placeholder audio seam. Deterministic engine (fp/brad/PRNG/InputSource/replay) is in place. **Phase 0 (design↔code sync) is done through 0.6** — the engine now matches the locked design: no affixes, intrinsic weapon rarity, run-buffs, two-pool shield health + regen + shield-break, characters = SkinDef (side-grade roster), and the design/09 pickup vocabulary (`heal`/`material`/`weapon`/`buff`). **`ENGINE_VERSION` is 14.**

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

- **1.1 🔴 Frame library** beyond `straight` (design/03 landing order): `spread` → `homing`/`lob` → `beam` → `boomerang`/`orbit`/radial; melee `hammer`/`spear`. Each = a per-tick velocity rule in `content/ballistics.ts` + `ProjectileStepSystem`.
- **1.2 🔴 RoomState collision geometry** (07/09): AABB tile/wall solids (round pillars already done) + spawn/exit markers; the `RoomPiece` schema.
- **1.3 🔴 Seeded dungeon assembly** (05/09): floors × rooms via `roomgenPrng`, hand-authored `RoomPiece` library, `DungeonConfig`. *After 1.2.*
- **1.4 🔴 Extraction rooms** (05): per-floor checkpoint; `EXTRACT` vs `DESCEND`; floor material buffer → run carry-out; death forfeits current-floor buffer. *After 1.3.*
- **1.5 🔴 Materials carry-out** (05/09): `MaterialDef` tiers by depth (`materialTierByDepth`), banked at extraction — the only thing that leaves a run.

## Phase 2 — Close the meta loop

- **2.1 Forge outpost** (14/09): blueprint unlock (permanent) + per-run craft from materials; recipes (`element × qty × min-tier`).
- **2.2 Loadout screen** (10): bring up to 2 crafted weapons; none → auto pistol; sits before a run in `ScreenManager`.
- **2.3 Character roster + select** (14/09/13): the 3 launch characters' `(maxHp,maxShield)`+passive, free-vs-paid, and the **side-grade balance-test suite**.
- **2.4 Monetization scaffolding** (14): direct-purchase blueprint/character store, no gacha. *Later — needs 2.1–2.3.*

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
Phase 1 (in-run loop)   1.2 rooms ── 1.3 dungeon ── 1.4 extraction ── 1.5 materials ; 1.1 frames independent
Phase 2 (meta)          needs 1.5 (materials) + 0.5 (characters)
Phase 3 (co-op/net)     needs Phase 1 (a run to co-op through)
Phase 4 (PvP)           4.1 design decision → 4.2/4.3 ; needs 0.5 (characters) + 0.2 (rarity irrelevant here)
Phase 5 (presentation)  parallelizable throughout
```
