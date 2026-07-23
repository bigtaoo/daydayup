# Weapon system

The heart of the game. Design goal: a very large variety of weapons with distinct behavior, where melee can block/deflect bullets.

## Categories

- **Ranged:** pistol, rifle, shotgun, laser, bullet-pattern emitter, … Parameterized: fire rate, bullet count, spread, bullet speed, ballistic shape, damage.
- **Melee:** sword, hammer, spear, … Swing arc/angle, damage, knockback, plus **block/deflect** capability.

## Damage types & status effects (shipped 2026-07-10, `ENGINE_VERSION` 8)

Every weapon carries a `damageType`; a hit is no longer a bare integer. `physical` is the plain flat-damage path, and the four elements each layer an **on-hit status** the combat systems interpret (bodies in `07`, data in `09`):

| type | on hit |
|------|--------|
| **physical** | raw damage only |
| **fire** | **burn** — a refreshing damage-over-time (topped up while you keep hitting) |
| **ice** | **chill** — a movement slow for a duration (Movement scales displacement) |
| **lightning** | **chain** — the hit arcs to the nearest other same-side actor in range |
| **poison** | **stacks** — independent stacks, each aged on its own timer (ramps with uptime) |

Enemies carry a per-type **resist/weakness** multiplier (per-mille; `1000` normal, `2000` weak/×2, `500` resist/×½), so matching the enemy's weakness melts it and hitting its resist floors toward min-1. A hit never rounds below 1. This is the axis that makes the 12-weapon roster a *choice* — plus elemental enemy variants (`emberling`/`frostling`/`galvanist`/`ironclad`) that each resist one element and are weak to a counter (`09`).

The lingering DoT/chill is ticked by a dedicated `StatusEffectSystem` (tick step 8, `08`), on a global `tick % DOT_INTERVAL` cadence so every affected actor ticks in lockstep — no per-actor clock, fully deterministic (`06`). All status math is integer/fp; the chain uses squared-distance nearest (no trig). A deflected bullet keeps its element, so a parried fire bolt burns enemies.

> **Known caveat:** a `×weakness` multiplier on a base-1 hit truncates back to 1, so low-damage elemental weapons don't visibly benefit from a weakness — the effect only reads on damage ≥ 2. Fix candidates: round instead of truncate in `applyResist`, or give elemental weapons a small flat-damage floor.

## Weapon composition: Frame × Element × Affix

The concrete answer to this doc's opening goal ("a very large variety of weapons with distinct behavior"): a weapon is **not** hand-built one at a time — it is **composed from three orthogonal axes**, so a large roster grows from a few authored pieces (`09`'s "content is data keyed by type; special behavior is a tagged field").

| Axis | Decides | Status |
|------|---------|--------|
| **Frame** | *behavior* — how shots leave the muzzle and how they fly (or, for melee, the swing's shape) | only `straight` shipped — **the main gap** |
| **Element** | *status layer* — burn / chill / chain / poison-stack + resist/weakness (above) | shipped (`ENGINE_VERSION` 8/9) |
| **Affix** | *roguelite depth* — rarity = roll count; numeric / element-set / proc (`09`) | schema in `09`, content to fill |

**The bet: variety is combinatorial, not authored per weapon.** `N` ranged frames × 5 elements yields `N×5` distinct-feeling guns from `N+5` pieces; affixes then open the in-run build space (`05`). One weapon = one frame id + one element tag + a stat row — nothing hard-coded per weapon.

### The Frame axis — ranged

A ranged frame is **emission** (how shots leave per trigger) × **ballistic** (how each shot then moves). The two facets combine — a spread of homing pellets, a burst of lobs.

**Emission** — the `bullets` / `spreadDeg` / `burstCount` fields on `RangedSpec` (`09`), *not* a ballistic id:

| emission | how | fields |
|----------|-----|--------|
| single | one shot (baseline) | — |
| spread | shotgun cone of pellets | `bullets` `spreadDeg` (exist) |
| burst | N shots over a few ticks per trigger | `burstCount` `burstGapTicks` (new) |
| radial | ring / spiral emitter (bullet-hell) | `bullets` + `spreadDeg` ≈ 360 |

**Ballistic** (`ballistic: BallisticId`) — a per-tick velocity rule, integer/brad, deterministic (`06`/`07`). Catalog + params live in `09`; **only `straight` is implemented today**:

| ballistic | behavior | new params |
|-----------|----------|-----------|
| `straight` | line (baseline) — the only one shipped | — |
| `lob` | parabola to a point, AoE on land; rides `bulletZ` z-gating over low cover (`07`) | `arcHeight` `blastRadius` |
| `homing` | curves toward the nearest enemy | `turnRateBrad` |
| `boomerang` | out then back, hits each way | `returnAfterTicks` |
| `beam` | hitscan line, damage ticked over a window (laser; pairs with fire DoT) | `beamTicks` `beamTickInterval` |
| `orbit` | orbs circling the actor / deployables | `orbitRadius` `orbCount` |

### The Frame axis — melee

Melee has no ballistic; its frame is the **swing shape** (`arcDeg` × `rangeGrid` × `swingSec`). That shape doubles as a **parry-frequency axis** — a fast narrow frame parries often (many swings), a wide slow one bats a big sector at once. Every melee frame keeps `deflect: true`, so the ranged-vs-melee trade-off (below) is untouched.

| melee frame | feel | parry character |
|-------------|------|-----------------|
| `dagger` | short arc/range, low cd, low dmg | dense small windows |
| `saber` | balanced (shipped) | baseline |
| `hammer` | wide arc, high knockback, slow | one big deflect sector, crowd control |
| `spear` | narrow arc, long reach | deflect / poke at distance |

### Landing order

Only `straight` exists, so the frame library **is** the build queue (highest differentiation first):

1. `spread` — near-free (`bullets`/`spreadDeg` already in schema), adds a sharp new feel immediately.
2. `homing`, `lob` — the strongest new behavior (tracking + over-cover arc).
3. `beam` — laser; shines with fire/DoT.
4. `boomerang` / `orbit` / radial `pattern`, plus melee `hammer`/`spear` and a first batch of `k_*` procs (`09`).

## Deflect / parry (core mechanic)

Deflect is **part of the melee attack — not a separate state or button.** Pressing attack with a melee weapon produces one swing sector (a fan centered on facing, `arc` half-angle + `range` radius; different weapons have different arc and range). During that swing, within the SAME sector:

- **Enemies** in the sector take the swing's damage (once per swing).
- **Enemy bullets** in the sector are deflected: faction flips to player, velocity is redirected toward the nearest enemy (or mirror-reflected when the arena is clear), and a deflect flash plays (additive on the fx layer).

So there is no `isBlocking`, no block key, no separate `blockArc` — the arc that hits enemies is the arc that bats bullets back. A per-weapon `deflect: bool` gates whether a given melee weapon can parry at all (the ranged-vs-melee trade-off: ranged loadouts get no parry).

- Extensible: perfect-swing timing window for a damage bonus, etc.

> This makes "swing your melee through an incoming bullet, and it flies back at the enemy" work — the pivot of the differentiated gameplay. It rewards *timing the swing*, not holding a button. The demo implements a minimal version.

## Parameterization & extension

Weapons should be **data-driven** as much as possible: one shared ranged/melee implementation derives many weapons from config.

```
RangedSpec { fireRate, bullets, spread, speed, damage, damageType, pattern }
MeleeSpec  { arc, range, damage, damageType, knockback, deflect: bool, deflectSpeed }
           // the swing's arc+range is BOTH the damage sector and the deflect sector
           // damageType: 'physical'|'fire'|'ice'|'lightning'|'poison' (omitted = physical)
```

Adding a weapon = adding a config row (+ code only for special behavior), not hard-coding each one.

## Verified in the demo

- Ranged gun: click to fire, emits a straight bullet.
- Melee sword: click to swing; the swing damages enemies in its arc **and** deflects enemy bullets caught in that same arc back at enemies — no separate block input.
- `[1]`/`[2]` swap the active weapon slot. Weapon positions by facing, with local z-order switching.

## Pickup & switch (locked — see `05`)

Weapons are **not** auto-picked-up (unlike materials/consumables) — swapping your weapon is a choice, so it stays button-driven:

- **Ground compare card (render-only).** Standing next to a floor weapon floats a non-blocking card (name / element / rarity / affixes) beside your active weapon. It is **pure client render — never in the sim**, so it does not touch determinism (`06`) and never pauses the co-op run (no modal — a blocking popup is impossible under lockstep, `06`).
- **`INTERACT` swaps it into the active slot**, and the **replaced weapon drops back onto the floor** (`02`); the switch button chooses which of the two slots to overwrite. No manual drop button.

## To design

The composition model, frame library, and landing order are now locked (above); what remains is content + tuning:

- Per-frame numbers and the `WeaponSpec` rows for each frame × element (values live in `09`'s `content/weapons.ts`).
- The `k_*` proc table and affix numeric caps (families sketched in `09`).
- Config format/loading is `09`'s open question (TS for balance vs JSON for tool-authored data).
