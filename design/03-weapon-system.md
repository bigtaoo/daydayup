# Weapon system

The heart of the game. Design goal: a very large variety of weapons with distinct behavior, where melee can block/deflect bullets.

## Categories

- **Ranged:** pistol, rifle, shotgun, laser, bullet-pattern emitter, … Parameterized: fire rate, bullet count, spread, bullet speed, ballistic shape, damage.
- **Melee:** sword, hammer, spear, … Swing arc/angle, damage, knockback, plus **block/deflect** capability.

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
RangedSpec { fireRate, bullets, spread, speed, damage, pattern }
MeleeSpec  { arc, range, damage, knockback, deflect: bool, deflectSpeed }
           // the swing's arc+range is BOTH the damage sector and the deflect sector
```

Adding a weapon = adding a config row (+ code only for special behavior), not hard-coding each one.

## Verified in the demo

- Ranged gun: click to fire, emits a straight bullet.
- Melee sword: click to swing; the swing damages enemies in its arc **and** deflects enemy bullets caught in that same arc back at enemies — no separate block input.
- `[1]`/`[2]` swap the active weapon slot. Weapon positions by facing, with local z-order switching.

## To design

- Config format and loading (JSON / table).
- Pickup / switch / inventory / drops.
- Rarity, affixes, combo effects (roguelite builds).
- Ballistic-shape library (straight, homing, arcing, bullet-pattern, boomerang).
