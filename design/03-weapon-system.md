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

- Config format and loading (JSON / table).
- Rarity, affixes, combo effects (roguelite builds).
- Ballistic-shape library (straight, homing, arcing, bullet-pattern, boomerang).
