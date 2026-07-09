# Entity model: Actor / Skin / Weapon

Core principle: **gameplay logic is not tied to the character**, because "different characters are only skins" — the character carries no core stats.

## Three-layer responsibilities

| Layer | Responsibility | Carries gameplay? |
|-------|----------------|-------------------|
| **Actor** | Logical entity: `gx/gy`, height `z`, `facing`, movement, HP, faction | Yes (core) |
| **Skin** | Appearance: animation rig / frames + swappable textures. May carry a **minor** passive | Almost none (pure presentation) |
| **Weapon** | First-class citizen: stats, ballistics, hand anchor, muzzle position, fire/block behavior | **Yes (core system)** |

## Key constraints

1. **The weapon is a first-class entity**, not a property of the character. Gameplay depth comes from weapons; the system is built around swapping them (see `03-weapon-system.md`).
2. **Skins decouple animation from texture:** animation data (frame timing, anchors, events) is separate from texture assets. Swapping a skin = swapping the atlas, without touching animation logic. Build it this way from the start, or adding skins later hurts.
3. **The hand anchor follows the animation frame:** the weapon mount tracks the character's hand anchor + facing every frame; it is never hard-coded.
4. **Weapon local z switches by facing** (see `01-rendering.md`).

## Data structure sketch

```
Actor {
  gx, gy               // ground position (2D — no height; jump removed, 07)
  vx, vy               // velocity
  facing: number       // radians
  hp, maxHp
  faction              // 'player' | 'enemy'
  skin: Skin
  weapon: Weapon       // currently equipped; swapping = replacing this reference
}

Skin {
  atlasKey             // texture atlas id (change this to swap skins)
  anim                 // shared animation-data reference
  handAnchor()         // hand anchor for the current frame (for weapon mounting)
}

Weapon (abstract) {
  name, kind           // 'ranged' | 'melee'
  view: Container      // render node
  cooldown
  onEquip(actor)
  onUnequip()
  update(dt)           // position to hand anchor, facing, local z
  use(ctx, firing)     // fire behavior (subclass); melee 'use' = a swing whose arc
                       //   both damages enemies AND deflects bullets in it (03/07).
                       //   No blocking state — parry is the swing, not a held key.
}
```

## Weapon-swap system scope

- Swapping = replacing `actor.weapon` + calling `onUnequip` / `onEquip`.
- Weapons can be picked up / switched / dropped; inventory and drops are designed later.
- The demo starts with key-based switching between two weapons (ranged gun / melee sword) to validate the structure.
