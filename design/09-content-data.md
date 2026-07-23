# Content & data model

The data-driven backbone: **where every gameplay number and every piece of content lives, and in what shape.** `06`/`08`/`07` decide *how the engine behaves*; this doc decides *what data it reads to behave that way*. It is the single source of truth for the `@dd/engine` config layout, the weapon/enemy/skin/affix schemas (`02`/`03`), the room & dungeon formats (`05`), and the collision geometry deferred from `07`.

It exists because `03`, `05`, `07`, and `08` all say "numbers live in one place" and repeatedly defer their concrete formats here.

> **funny mapping.** funny keeps *all* balance in `server/engine/src/config.ts` (single source), blueprints as plain `Record<Type, Blueprint>`, PvE levels as pure-data `LevelDefinition`s driven by a `WaveDirector`, and affixes as an `AFFIX_FIELD_MAP` mutating blueprints in place. DayDayUp reuses the discipline and the fairness wall wholesale. It **⟂ diverges** on world data: funny levels are fully hand-scripted with a fixed seed; DayDayUp's PvE is **hybrid** — hand-authored room *pieces* stitched by a **seeded procedural layout** (`05`) — so the level format is a piece library + assembly rules, not one scripted timeline.

## The decisions (locked)

- **All numbers live in `@dd/engine` config; prose only snapshots them with a date.** Client and server read the same module (webpack alias / workspace dep, `06`). No balance constant is ever duplicated into a doc, a UI file, or the render layer — funny's ADR-001 rule, the fix for "same number, four values across four docs."
- **Author in human units, convert once at construction.** Config is written in seconds, grid-units/second, degrees, and percent — *readable*. The engine converts to ticks/`Fp`/brad exactly once, when a blueprint is instantiated, using a fixed truncation so every client converts identically (funny: `attackInterval_s → round(s·TICK_RATE)`, `speed grid/s → toFp(speed)`). **Raw floats never survive past construction** into stored state (`06`).
- **Content is plain data keyed by type.** Weapons, enemies, skins, affixes, rooms, drop tables are all serializable records — no code, no Pixi, no closures. Special behavior is a *tagged field* the engine interprets (funny's `traits`/`projectile`/`onDeathSpawn`), never an inline function. This is what lets the same data drive engine, headless re-judge, and (later) a data editor.
- **The PvP fairness wall is structural, not disciplinary.** ⟂ The builder that produces arena specs takes **no meta/affix parameter at all**, so it is *compile-time impossible* to leak persistent gear into PvP (funny's `buildPvpBlueprints()` signature has no equipment arg, guarded by hard-wall tests). Meta and in-run affixes only reach the *run* builder. This is the concrete enforcement of `05`'s "PvP normalizes gear" / `06`'s casual-first.
- **Forward-compatible by default.** An unknown affix id / trait / field is **silently ignored**, not a crash (funny). New content can ship to data before the engine understands it, and an old replay won't explode on a field it doesn't know — but any change that alters *outcomes* still bumps `ENGINE_VERSION` (`08`).
- **No display strings in engine data.** Names/descriptions are **i18n string keys** (plain strings in the engine; the client re-narrows to typed keys at the render boundary — funny's koan). Engine data is logic + keys only.

## Config module layout

Mirror funny's `@nw/engine` structure:

```
@dd/engine/
  config.ts            // global constants: TICK_RATE, gravity, i-frame defaults, world scale
  math/{fixed,prng,trig}.ts   // 06 (trig = the new brad/fp-trig module)
  content/
    weapons.ts         // WEAPON_SPECS: Record<WeaponId, WeaponSpec>   (03)
    damage.ts          // DamageType, StatusState, resist + status tuning (03/07)
    enemies.ts         // ENEMY_BLUEPRINTS: Record<EnemyType, EnemyBlueprint>
    skins.ts           // SKIN_DEFS: Record<SkinId, SkinDef>           (02)
    ballistics.ts      // BALLISTIC_SHAPES: straight/arc/homing/…       (03/07)
    drops.ts           // DROP_TABLES                                    (05)
  balance/
    affixes.ts         // AFFIX_FIELD_MAP + caps                         (03)
    presets.ts         // ARENA_PRESETS (PvP loadouts)                   (05)
    build.ts           // buildRunSpecs() / buildArenaSpecs() — the wall
  world/
    rooms/*.ts|json    // RoomPiece library (hand-authored)             (05/07)
    dungeon.ts         // DUNGEON_CONFIGS: assembly rules per biome     (05)
    arenas/*.ts|json   // PvP arena maps                                (05)
```

## Entity blueprints

Author in human units; the constructor converts (as funny's `Unit` ctor does).

### `WeaponSpec` (`03`)

```
WeaponSpec = { id, kind, nameKey, skinRef, cooldownSec, grip? }  &  (RangedSpec | MeleeSpec)
  // grip: 'ranged1h'|'ranged2h'|'melee1h'|'melee2h' — picks the arm hold pose that aims
  //   the weapon on the skin's gear_hand attachment point (02/12); render-only, ~4 poses
  //   shared by all weapons. Omitted = inferred from kind. Never read by the sim (06).

RangedSpec = {
  kind: 'ranged'
  fireRateSec        // → cooldownTicks
  // emission — how shots leave per trigger (03 Frame axis); all orthogonal to ballistic
  bullets            // pellets per shot (spread frame)
  spreadDeg          // → brad half-angle; jitter drawn from combatPrng (07). ≈360 = radial
  burstCount?        // shots per trigger for the burst frame (03); omitted = 1
  burstGapTicks?     // spacing between burst shots
  bulletSpeed        // grid/s → fp/s
  damage             // integer
  damageType?        // 'physical'|'fire'|'ice'|'lightning'|'poison' (07); omitted = physical
  ballistic: BallisticId   // per-tick MOTION rule; see BALLISTIC_SHAPES catalog below (03 Frame axis)
  // ballistic params — each shape reads only its own (unset = shape unused / default):
  turnRateBrad?      // homing: max turn toward nearest enemy per tick
  arcHeight?         // lob: peak of the fake-3D arc (bulletZ)
  blastRadius?       // lob: AoE grid radius on land
  returnAfterTicks?  // boomerang: tick at which vel reverses
  beamTicks?         // beam: total damage-window length
  beamTickInterval?  // beam: ticks between damage applications
  orbitRadius?       // orbit: grid radius of the circling bodies
  orbCount?          // orbit: number of orbiting bodies
  lifespanSec        // → lifespanTicks
  piercing?: bool
  bulletZ?           // cosmetic muzzle height for the fake-3D render (01); NOT a hit gate
}

MeleeSpec = {
  kind: 'melee'
  arcDeg, rangeGrid  // swing sector (→ brad half-angle + fp range)
  damage, knockback
  damageType?        // 'physical'|'fire'|'ice'|'lightning'|'poison' (07); omitted = physical
  swingSec           // → swingTicks (active-hit window, 07)
  deflect: bool      // does the swing deflect bullets in its arc (03) — ranged-vs-melee trade-off gate
  deflectSpeed       // grid/s of a redirected bullet (07). The swing's arcDeg/rangeGrid
                     //   IS the deflect sector — there is no separate blockArc.
}
```

### `BallisticId` catalog (`03` Frame axis)

`content/ballistics.ts` maps each `BallisticId` to a **per-tick velocity rule** + the params it reads (the params above). All integer/brad — no float survives a tick (`06`); `homing` uses squared-distance nearest + a brad turn cap (no trig beyond the shared `math/trig` table, `06`). **Only `straight` is implemented today; the rest are the build queue in `03`'s landing order.**

| id | per-tick rule | reads |
|----|---------------|-------|
| `straight` | `pos += vel` (shipped) | — |
| `lob` | fake-3D arc via `bulletZ`; on land, AoE hit in `blastRadius` | `arcHeight`, `blastRadius` |
| `homing` | rotate `vel` toward nearest enemy, ≤ `turnRateBrad`/tick | `turnRateBrad` |
| `boomerang` | reverse `vel` at `returnAfterTicks`; re-hits on the way back | `returnAfterTicks` |
| `beam` | hitscan the facing line; apply damage every `beamTickInterval` for `beamTicks` | `beamTicks`, `beamTickInterval` |
| `orbit` | `orbCount` bodies circling the actor at `orbitRadius` | `orbitRadius`, `orbCount` |

**Emission (single/spread/burst/radial) is not a `BallisticId`** — it is the `bullets`/`spreadDeg`/`burstCount` fields on `RangedSpec`, orthogonal to the motion rule, so any emission composes with any ballistic (spread-of-homing, burst-of-lobs). Melee has no ballistic; its frame is `arcDeg`×`rangeGrid`×`swingSec` (`03`).

### `EnemyBlueprint` (mirrors funny `UnitBlueprint`)

```
EnemyBlueprint = {
  type, nameKey, skinRef
  hp, armor          // integers; takeDamage = max(1, raw-armor) (07)
  moveSpeed          // grid/s → fp/s
  radius             // grid → radius_fp (07 collision)
  weapon?: WeaponId  // enemies fire through the same weapon system (02/03)
  resist?: Partial<Record<DamageType, number>>  // per-type per-mille mult (07); 1000=normal, missing=neutral
  tint?              // render-only body colour (01); the sim never reads it
  aiProfile: AiId    // behavior selector read by the AI system (08 step 2)
  traits?: Trait[]   // tagged behaviors: aura_heal, enrage, shielder, …  (funny traits)
  onDeathSpawn?: { type, count }   // boss adds (funny)
  isBoss?: bool
}
```

> **Shipped 2026-07-10 (`ENGINE_VERSION` 8).** `content/enemies.ts` holds `ENEMY_BLUEPRINTS: Record<type, EnemyBlueprint>` (basic + elemental variants emberling/frostling/galvanist/ironclad). A wave spawn entry is `[x, y]` (basic) or `[x, y, type]` (`SpawnSpec`), resolved through the registry by `SpawnSystem`; a bare `[x, y]` and any unknown type fall back to basic — a forward-compatible content add (new ids + optional field), so it did **not** bump the version on its own. The elemental status runtime (`StatusState`: burn/chill/poison fields) lives on every `Actor`, constructed via `freshStatus()`; it is plain data mutated only by `StatusEffectSystem` (`07`/`08`).

> **Boss shipped 2026-07-11 (no version bump).** `blightlord` — a durable finale (`maxHp 40`, 2× radius) that exists to *show* the combat systems: its big HP pool lets poison stacks ramp to full and lingering burn/chill/poison auras persist, while a broad `resist` (physical ×0.4, fire/ice/lightning ×0.8, **poison ×2.0**) forces the right tool — venom melts it. `boss?: bool` is the shipped form of the aspirational `isBoss` but **render-only** (like `tint` — the sim never reads it): the view draws a floating HP bar so the poison melt is legible. `onDeathSpawn`/AI traits remain unbuilt. Added as a `blightlord` finale wave; another new id + optional render field, so still no version bump.

`PLAYER_BASE` holds the stats **shared by all characters** (collision radius, move speed, `WEAPON_SLOTS = 2`, the auto-granted starter pistol `WeaponId`, `SHIELD_REGEN_DELAY`/`SHIELD_REGEN_INTERVAL`, revive channel length & restored HP); the **chosen `SkinDef`** supplies the per-character `(maxHp, maxShield)` + `shieldBreak`. At match start the two are merged into the `PlayerActor`; persistent-meta and in-run affixes then modify a *copy* via the build layer below — never the shared constant.

### `SkinDef` (`02`)

Skins are content too, and `02`'s "animation data separate from texture" is a data-format decision. A skin **is** the character, so it also carries the character's entire gameplay contribution: its `(maxHp, maxShield)` defensive pair and its shield-break passive (`02`/`05`/`07`):

```
SkinDef = {
  id, atlasKey            // texture atlas to swap (02)
  animRef: AnimId         // shared animation-data reference (frame timing, events)
  maxHp                   // integer hard-floor HP (05); recovered only by heal items
  maxShield               // integer soft buffer, absorbed before HP; auto-regens (05/07)
                          //   NOT balanced to equal EHP: 8/0 starter vs 3/10 skirmisher (05)
  shieldBreak?: ShieldBreakPassive  // fires the instant shield hits 0 (07); the concrete
                          //   form of 02's "minor passive". Omitted for 0-shield characters.
}
ShieldBreakPassive =      // tagged data, interpreted by combat (07) — no inline code
  | { kind: 'aoe';   radiusGrid; damage; damageType? }   // burst on nearby enemies
  | { kind: 'knock'; radiusGrid; impulse }               // shove nearby enemies back
AnimData = {
  clips: Record<ClipName, { frames: Frame[]; fps; loop }>
  handAnchors: Record<frameIndex, { x, y }>   // 02 "hand anchor follows the frame" — weapon mount
}
```

`handAnchors` is what `02`/`07` mean by "weapon mount tracks the hand anchor every frame": it is *data*, per animation frame, not hard-coded. Animation is render-layer data (no fp needed — it never feeds logic), but it lives in the content catalog so a skin swap is a pure data swap.

## Affixes, rarity, combos (`03` roguelite builds)

The in-run power axis (`05`). Adopt funny's `AFFIX_FIELD_MAP` model exactly:

```
Affix = { id: AffixId; value: number }     // id namespace: m_* primary / s_* secondary / k_* proc

AFFIX_FIELD_MAP: Record<AffixId, {
  kind: 'mult_damage'|'mult_firerate'|'flat_damage'|'flat_armor'|'crit'|'crit_mult'|'add_bullets'|…
  target: keyof WeaponSpec | keyof PlayerActor
}>

EFFECT_CAPS: Record<kind, cap>    // Σ-then-clamp (e.g. crit ≤ 50), funny §7.7
```

- `applyAffixes(spec, affixes)` clones the spec and mutates the copy: multiplicative and additive stacks summed per kind, then clamped by `EFFECT_CAPS`. Order of application is fixed (mult before add, or documented) so it's deterministic.
- **Rarity** = how many affix rolls an item gets (common 1 → epic 3+), rolled from `dropPrng` against weighted tables (`content/drops.ts`). Rolls are reproducible from `seed + input stream` (`06`).
- **Combo effects** (`k_*` procs — on-hit/on-kill triggers) are tagged data the combat system (`07`) checks; **recognized-but-no-op if unimplemented** (funny's proc stub), so content can list them before the hooks exist. First-pass proc families (`03`): `k_explode_on_kill` (small AoE on a kill), `k_ricochet` (hit bounces to a nearby target), `k_lifesteal_shield` (a hit trickles shield back — ties into the HP+shield model, `05`/`07`), `k_overload` (every Nth shot enhanced). Concrete numbers/caps are `03`'s remaining content work.
- **Element-adding affixes** (`elem_fire`/`elem_ice`/`elem_lightning`/`elem_poison`, kind `set_element`) carry a `damageType` in the field map and *override* the weapon's own `damageType` in `applyAffixes` — the drop that turns any gun elemental (`03`/`07`). This kind is a **set, not a sum**: it skips `sumAffixes`/`EFFECT_CAPS` (non-numeric), and `resolveElement` picks a fixed winner by `DAMAGE_TYPES` order when several are stacked, so it stays order-independent like the numeric stack. The roll's `value` is unused. Added `ENGINE_VERSION` 9 (enlarging `AFFIX_DROP_POOL` shifts the `dropPrng` sequence).
- **Unknown affix id → ignored** (forward-compat).

## The build layer — the fairness wall

Two builders, and the *types themselves* enforce `05`/`06`:

```
// PvE run: persistent meta (horizontal) + in-run drops (the real power axis)
buildRunSpecs(baseLoadout: MetaLoadout, runAffixes: Affix[]): ResolvedSpecs

// PvP arena: a preset id and NOTHING else — no meta parameter exists
buildArenaSpecs(presetId: ArenaPresetId): ResolvedSpecs
```

`buildArenaSpecs` physically cannot receive meta/affixes — there is no parameter for it (funny's compile-time wall, unit-tested). PvP power comes only from `ARENA_PRESETS[presetId]` + on-map pickups (`05`). PvE builds through `buildRunSpecs`, where persistent meta is horizontal (build breadth / small deltas, capped) and in-run affixes are the power fantasy. This is `05`'s hybrid-gear table made executable.

## World data

### Collision geometry — `RoomState` (deferred from `07`)

A room's static solids and markers, all on the `gx/gy` grid (`01`):

```
RoomPiece = {
  id, sizeGrid: { w, h }
  solids: AABB[]              // static collision rects (07 actor–wall / bullet–wall)
  pillars?: { center, radius }[]  // round static solids (07 — implemented as circle push-out)
  spawns: { player: Point[]; enemy: SpawnPoint[] }
  exits: { edge, toTag }[]    // connective openings for dungeon assembly
  props?: PropPlacement[]     // decorative + Y-sortable pillars (01)
  encounter?: WaveScript      // per-room enemy script (see below)
}
```

`solids` are integer-grid AABBs → converted to `Fp` bounds on load. This is the schema `07` said it needed and left to `09`.

### Dungeon assembly (`05` hybrid)

⟂ The core divergence from funny. Instead of one scripted level, a **seeded layout stitches hand-authored pieces**:

```
DungeonConfig = {
  biomeId, nameKey
  floorCount                  // ~5 tentative (05 to-tune)
  roomsPerFloor: { min, max } // 5–10 (05 to-tune)
  pieceTags: RoomTag[]        // which RoomPiece pools this biome draws from
  layout: 'linear'|'branching'   // 05 reward-choice structure
  extractionPiece: RoomPieceId   // the per-floor extraction room (descend vs leave, 05)
  bossPiece: RoomPieceId         // the deepest floor's room; its portal opens post-kill and
                                 //   doubles as that floor's extraction (05)
  difficultyCurve: CurveSpec  // scales enemy count/tier by floor depth (05 to-tune)
  dropTableByDepth: DropTableId[]      // better pools deeper
  materialTierByDepth: number[]        // material quality shift per floor (05)
}

RoomPiece.role?: 'normal' | 'extraction' | 'boss'   // extends the RoomPiece schema above;
                 // exactly one non-normal room per floor carries the extract/descend portal
```

- **Floors, not one flat room list.** Each floor is `roomsPerFloor` pieces with exactly one **extraction room** placed among them; its position gates how many rooms are skippable (`05`). The deepest floor's extraction *is* the boss room.
- Generation is driven by the injected **`roomgenPrng` seeded per run** (`06`/`08`), so a run is reproducible from `seed + input stream` — required for co-op determinism and headless re-judge (`06`). Layout/selection reuses funny's PRNG roomgen approach (`05`).
- **Encounter quality stays curated**: pieces are hand-authored; only their *arrangement* and *which enemies/tier* are procedural (`05`).

### Encounters — `WaveScript` (reuse funny's `WaveDirector`)

Per-room enemy timeline, structurally funny's `WaveScript`/`WaveEntry`, adapted from lanes to spawn points:

```
WaveScript = { entries: WaveEntry[] }
WaveEntry  = { atTick; enemyType; spawnPoint; count; spacingTicks?; isBoss? }
```

The `WaveDirector` (funny, ported) pre-expands `count`/`spacing` into a tick-sorted list and emits due spawns per tick via a monotonic cursor (`08` step 10). It reads only `tick` + its static script; its injected `Prng` is reserved for randomized spawn variety so those stay reproducible.

### Arenas & presets (`05` PvP)

```
ArenaMap = RoomPiece-like, but symmetric, hand-designed sightlines/cover (05); no procedural layout.
ARENA_PRESETS: Record<ArenaPresetId, { nameKey; loadout: WeaponId[]; baseStats }>   // 05 fixed balanced set
PICKUP_TABLE: on-map power-ups, equal for both teams (05)
```

Preset count/archetypes, win condition, and the pickup table are `05`'s open design work; this doc fixes their *shape*.

### Drops, pickups & materials (`05`)

A `Pickup` on the ground is one of three kinds; `DropTable` rolls which drops from a chest or a slain enemy:

```
Pickup =
  | { kind: 'weapon';   spec: WeaponId; affixes: Affix[] }   // in-run, ephemeral (05)
  | { kind: 'heal' }                                          // flat +1 HP (05/07)
  | { kind: 'material'; matId: MaterialId; qty }             // the ONLY carry-out (05)

DropTable = { entries: { itemPool; weight; rarityWeights }[] }   // itemPool spans all 3 kinds

MaterialDef = { id: MaterialId; nameKey; tier }   // tier feeds meta forging (meta doc)
```

- **Materials are the run's only carry-out** and the meta-forge input. They are **banked at extraction rooms** (reaching one = a checkpoint, `05`); a death forfeits only the *current floor's* un-banked materials.
- **Deeper floors roll better materials** — `dropTableByDepth` / `materialTierByDepth` (below) shift the pools by floor; weapon *finds* stay random at every depth (`05`).
- Rolled from `dropPrng`; rewards are recomputed/validated server-side, never trusted from the client (funny ADR-006, `06`).

## Loading, validation, versioning

- **Load once, convert once.** At match start the engine resolves blueprints (human units → ticks/fp/brad) and freezes them into `GameState` (funny `state.unitBlueprints`). Nothing re-reads config mid-match.
- **Validate at load, not at use.** Bad data (undefined weapon ref, spawn off-piece, affix targeting a missing field) fails loudly at load / in a content unit test — never mid-tick.
- **`ENGINE_VERSION` coupling.** A content change that only adds a new id is forward-compatible (ignored by old engines). A change to how existing data is *interpreted* (conversion rule, affix arithmetic, ballistic behavior) can diverge replays → bump `ENGINE_VERSION` (`08`).
- **i18n boundary.** Engine data carries only string keys; the client owns the translation tables.

## Relationship to the other docs

- **`03`:** `WEAPON_SPECS`/affixes/ballistics are the concrete form of its `RangedSpec`/`MeleeSpec` "to design" list and its rarity/affix/combo note.
- **`02`:** `SkinDef` + `AnimData.handAnchors` realize "animation separate from texture" and "hand anchor follows the frame."
- **`05`:** dungeon assembly, drop tables, arena presets, difficulty curve — the data behind its core loop, economy, and PvP; its open design questions (room count, reward structure, preset set) fill these schemas.
- **`07`:** `RoomPiece.solids`/`pillars` are the collision geometry (round pillars implemented, AABB tiles deferred); `WeaponSpec`/`EnemyBlueprint` feed its damage/ballistic bodies.
- **`08`:** the build layer resolves specs into `GameState` at match start; `WaveScript`/`WaveDirector` is step 10; all PRNG-seeded content obeys its determinism contract.
- **`06`:** single-source config, human→fp/brad conversion, injected PRNG, and the fairness wall all originate there.

## To design

- **Concrete first-pass numbers** for the demo's two weapons (gun/sword, `03`) and a starter enemy set — the actual values in `content/*.ts`.
- **Character roster** (`02`/`05`): the actual `SkinDef` `(maxHp, maxShield)` pairs and `shieldBreak` passives, plus the `PLAYER_BASE` shared constants (slot count, starter pistol, regen/revive timings).
- **Material catalog & forging** — `MaterialDef` tiers and what forging turns them into; the whole forging recipe layer is the **meta** doc's scope, this file only fixes the `Pickup`/`MaterialDef` shape.
- **`RoomPiece` authoring pipeline**: hand-edit JSON, or a small editor? Format must round-trip with whatever tool authors `solids`/`spawns`/`exits`/`role`.
- **Difficulty & material curve** (`05`): how enemy count/tier and material quality scale with *floor* depth; extraction-room placement rules; boss-piece rules.
- **Arena preset set** (`05`): count, archetypes/roles, `baseStats`, win condition, pickup table.
- **Meta "horizontal" numeric cap** (`05`/`06` open question): where a "small stat delta" stops being horizontal — a concrete clamp in `balance/`.
- **Frame content & tuning** (`03`): the `BallisticId` catalog and its config params are now specified (above) with a locked landing order (`03`); what remains is implementing each shape's per-tick rule in `content/ballistics.ts` and tuning the `WeaponSpec` rows per frame × element.

## Open questions

- **Content format: TS modules or JSON?** TS gives type-checking and lets constants reference each other (funny is all TS); JSON enables a data editor and hot-reload but needs a schema validator. Likely TS for balance, JSON for room pieces (bulky, tool-authored). Decide with the authoring pipeline.
- **Where do arena maps and dungeon pieces physically live** — in-engine (bundled, versioned with code) or fetched (updatable without a client release)? Fetched content complicates the `ENGINE_VERSION`/replay guarantee.
- **Affix application order** (mult-then-add vs interleaved) and whether combos can *reference other affixes* — affects both balance and determinism.
- **Shield-break passive scope** (`02`/`05`): the character's break-passive *is* a combat blueprint (it spawns an AoE / applies knockback). If characters appear in PvP, does the passive survive preset normalization or get normalized out like gear? Keep it out of the `buildArenaSpecs` path unless deliberately balanced in.
- **Per-room vs per-run seed derivation**: one `roomgenPrng` for the whole run, or a child stream per room? Child streams make a single room re-generable in isolation (useful for tooling) but must derive deterministically from the run seed.
