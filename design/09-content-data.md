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
WeaponSpec = { id, kind, nameKey, skinRef, cooldownSec }  &  (RangedSpec | MeleeSpec)

RangedSpec = {
  kind: 'ranged'
  fireRateSec        // → cooldownTicks
  bullets            // pellets per shot
  spreadDeg          // → brad half-angle; jitter drawn from combatPrng (07)
  bulletSpeed        // grid/s → fp/s
  damage             // integer
  ballistic: BallisticId   // key into BALLISTIC_SHAPES (straight/arc/homing/boomerang/pattern)
  lifespanSec        // → lifespanTicks
  piercing?: bool
  bulletZ?           // cosmetic muzzle height for the fake-3D render (01); NOT a hit gate
}

MeleeSpec = {
  kind: 'melee'
  arcDeg, rangeGrid  // swing sector (→ brad half-angle + fp range)
  damage, knockback
  swingSec           // → swingTicks (active-hit window, 07)
  deflect: bool      // does the swing deflect bullets in its arc (03) — ranged-vs-melee trade-off gate
  deflectSpeed       // grid/s of a redirected bullet (07). The swing's arcDeg/rangeGrid
                     //   IS the deflect sector — there is no separate blockArc.
}
```

### `EnemyBlueprint` (mirrors funny `UnitBlueprint`)

```
EnemyBlueprint = {
  type, nameKey, skinRef
  hp, armor          // integers; takeDamage = max(1, raw-armor) (07)
  moveSpeed          // grid/s → fp/s
  radius             // grid → radius_fp (07 collision)
  weapon?: WeaponId  // enemies fire through the same weapon system (02/03)
  aiProfile: AiId    // behavior selector read by the AI system (08 step 2)
  traits?: Trait[]   // tagged behaviors: aura_heal, enrage, shielder, …  (funny traits)
  onDeathSpawn?: { type, count }   // boss adds (funny)
  isBoss?: bool
}
```

`PlayerActor` base stats live similarly (a `PLAYER_BASE` blueprint); persistent-meta and in-run affixes modify a *copy* via the build layer below — never the shared constant.

### `SkinDef` (`02`)

Skins are content too, and `02`'s "animation data separate from texture" is a data-format decision:

```
SkinDef = {
  id, atlasKey            // texture atlas to swap (02)
  animRef: AnimId         // shared animation-data reference (frame timing, events)
  passive?: MinorPassive  // 02 "may carry a minor passive"
}
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
- **Combo effects** (`k_*` procs — on-hit/on-kill triggers) are tagged data the combat system (`07`) checks; **recognized-but-no-op if unimplemented** (funny's proc stub), so content can list them before the hooks exist.
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
  roomCount: { min, max }     // 05 "run length" (to-tune)
  pieceTags: RoomTag[]        // which RoomPiece pools this biome draws from
  layout: 'linear'|'branching'   // 05 reward-choice structure
  bossPiece: RoomPieceId
  difficultyCurve: CurveSpec  // scales enemy count/tier by room depth (05 to-tune)
  dropTableByDepth: DropTableId[]
}
```

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

### Drop tables (`05`)

```
DropTable = { entries: { itemPool; weight; rarityWeights }[] }
```

Rolled from `dropPrng`; rewards are recomputed/validated server-side, never trusted from the client (funny ADR-006, `06`).

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
- **`RoomPiece` authoring pipeline**: hand-edit JSON, or a small editor? Format must round-trip with whatever tool authors `solids`/`spawns`/`exits`.
- **Difficulty curve spec** (`05`): how enemy count/tier scales with room depth; boss piece rules.
- **Arena preset set** (`05`): count, archetypes/roles, `baseStats`, win condition, pickup table.
- **Meta "horizontal" numeric cap** (`05`/`06` open question): where a "small stat delta" stops being horizontal — a concrete clamp in `balance/`.
- **Ballistic-shape catalog** (`03`/`07`): the per-shape velocity-update rules and their config params.

## Open questions

- **Content format: TS modules or JSON?** TS gives type-checking and lets constants reference each other (funny is all TS); JSON enables a data editor and hot-reload but needs a schema validator. Likely TS for balance, JSON for room pieces (bulky, tool-authored). Decide with the authoring pipeline.
- **Where do arena maps and dungeon pieces physically live** — in-engine (bundled, versioned with code) or fetched (updatable without a client release)? Fetched content complicates the `ENGINE_VERSION`/replay guarantee.
- **Affix application order** (mult-then-add vs interleaved) and whether combos can *reference other affixes* — affects both balance and determinism.
- **Skin passive scope** (`02`): if skins carry a "minor passive," does it touch combat blueprints (and thus the fairness wall in PvP)? Keep passives cosmetic/utility in PvP, or normalize them out like gear.
- **Per-room vs per-run seed derivation**: one `roomgenPrng` for the whole run, or a child stream per room? Child streams make a single room re-generable in isolation (useful for tooling) but must derive deterministically from the run seed.
