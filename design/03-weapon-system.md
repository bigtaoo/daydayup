# Weapon system

The heart of the game. Design goal: a very large variety of weapons with distinct behavior, where melee can block/deflect bullets.

## Categories

- **Ranged:** pistol, rifle, shotgun, laser, bullet-pattern emitter, … Parameterized: fire rate, bullet count, spread, bullet speed, ballistic shape, damage.
- **Melee:** sword, hammer, spear, … Swing arc/angle, damage, knockback, plus **block/deflect** capability.

## Block / deflect (core mechanic)

Melee weapons hold a blocking state:

- **`isBlocking`** — entered while the player holds the block key.
- **`blockArc()`** — a sector centered on the character's facing (half-angle `half` + radius `range`).
- **Resolution:** each frame, iterate enemy bullets; if a bullet falls inside the block arc (distance < range and angle-to-facing < half):
  - **Deflect:** change the bullet's faction to player, redirect its velocity toward the nearest enemy (or mirror-reflect), and play a deflect flash (additive on the fx layer).
  - Extensible: perfect-block timing window for a damage bonus, stamina cost, etc.

> This makes "block a bullet with melee, then send it back at the enemy" work — the pivot of the differentiated gameplay. The demo implements a minimal version.

## Parameterization & extension

Weapons should be **data-driven** as much as possible: one shared ranged/melee implementation derives many weapons from config.

```
RangedSpec { fireRate, bullets, spread, speed, damage, pattern }
MeleeSpec  { arc, range, damage, knockback, blockHalf, blockRange, deflect: bool }
```

Adding a weapon = adding a config row (+ code only for special behavior), not hard-coding each one.

## Verified in the demo

- Key `1` ranged gun: click to fire, emits a straight bullet.
- Key `2` melee sword: click to swing; **hold right mouse / Shift to block**, deflecting enemy bullets back at enemies.
- Weapon positions by facing, with local z-order switching.

## To design

- Config format and loading (JSON / table).
- Pickup / switch / inventory / drops.
- Rarity, affixes, combo effects (roguelite builds).
- Ballistic-shape library (straight, homing, arcing, bullet-pattern, boomerang).
