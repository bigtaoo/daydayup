# Entity model: Actor / Skin / Weapon

Core principle: **offensive depth is not tied to the character.** A character contributes *only* its **defensive identity** — a `(maxHp, maxShield)` pair plus one **shield-break passive** — and nothing else; all moment-to-moment power is the weapon. "Different characters" are a skin + those two-ish knobs, not a stat sheet. (`05` locks the two-pool survivability model these knobs feed.)

## Three-layer responsibilities

| Layer | Responsibility | Carries gameplay? |
|-------|----------------|-------------------|
| **Actor** | Logical entity: `gx/gy`, `facing`, movement, `hp/maxHp`, **`shield/maxShield` + `ticksSinceHit`**, faction | Yes (core) |
| **Skin (character)** | Appearance: animation rig / frames + swappable textures. Carries the character's `(maxHp, maxShield)` and its **shield-break passive** (the concrete "minor passive") | Defensive identity only — no offense |
| **Weapon** | First-class citizen: stats, ballistics, hand anchor, muzzle position, fire/deflect behavior | **Yes (all offensive depth)** |

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
  facing: number       // brad in the engine (06); radians only in this sketch
  hp, maxHp            // hard floor; 0 = death; recovered ONLY by items (05/07)
  shield, maxShield    // soft buffer, absorbed before hp (incl. DoT); auto-regens (05/07)
  ticksSinceHit        // idle timer; any damage → 0; drives shield regen (07/08)
  faction              // 'player' | 'enemy'
  skin: Skin
  slots: [Weapon?, Weapon?]  // two weapon slots; either may be empty
  activeSlot: 0 | 1    // which slot fires / receives a pickup; SWAP toggles it
}

Skin {                 // "the character": defensive identity + look
  atlasKey             // texture atlas id (change this to swap skins)
  anim                 // shared animation-data reference
  handAnchor()         // hand anchor for the current frame (for weapon mounting)
  // maxHp, maxShield, and the shield-break passive are authored on the character
  //   blueprint (SkinDef / PLAYER_BASE, 09); the Actor is constructed from them.
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

## Weapon-slot system (locked, `05`)

- **Two slots, one active.** `SWAP_WEAPON` (`08`) toggles `activeSlot`; the right stick fires whatever is in the active slot. Firing an **empty** active slot does nothing — "no weapon → can't attack" just means you switched to an empty slot; switch back (or pick one up) to fire.
- **Pickup replaces the active slot; the replaced weapon drops to the ground.** Walking onto a map weapon and pressing `INTERACT` puts it into the **active** slot — replacing the weapon there (`onUnequip` old → `onEquip` new) or equipping into it if empty. When a slot's weapon is replaced, **the old weapon is dropped back onto the floor** as a pickup (you can grab it again, or swap back and forth between two candidates before committing). The switch button is how you choose *which* of the two slots to overwrite. There is **no manual drop button** — replacement is the only trigger, but it *does* leave the old weapon on the ground rather than destroying it.
- **You always have at least one.** Entering a run you may bring 0–2 weapons; bringing none auto-grants a starter **pistol**, so an active slot is essentially never both-empty at spawn. Carried count is thus 1 or 2 in practice.
- **All weapons are ephemeral.** Nothing in the slots survives run end (`05`); only materials extract. Swapping/holding is purely in-run.
- The demo starts with two slots pre-filled (ranged gun / melee sword) and the switch button, to validate the structure before pickups exist.
