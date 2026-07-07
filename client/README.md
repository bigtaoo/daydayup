# DayDayUp Client

Single-engine PixiJS v8 client. Currently a **vertical slice** that validates the core architecture and gameplay.

## Run (Web)

```bash
cd client
npm install
npm run dev        # open http://localhost:5173
```

## Controls

| Input | Action |
|-------|--------|
| `WASD` / arrows | Move |
| Mouse | Aim (character faces the cursor) |
| Left click | Fire / swing (depends on the equipped weapon) |
| `1` | Switch to ranged gun |
| `2` | Switch to melee sword |
| Right click / `Shift` (with sword) | **Block**: deflect enemy bullets back at enemies |
| `Space` | Jump (demonstrates height / shadow separation) |

## What the demo validates

- Tilted-view scene + **Y-sort depth occlusion** (walking in front of / behind a pillar occludes correctly)
- **Height / shadow separation** (jumping lifts the character while the shadow stays on the ground and shrinks)
- **Actor / Skin / Weapon three-layer structure** (see `design/02-entity-model.md`)
- **Weapon-swap system** + **melee block/deflect** (the core fun, see `design/03-weapon-system.md`)
- Weapon positioning by facing with local z-order switching
- Additive-blend fx layer (muzzle / deflect flashes), WeChat-safe rendering path (pure Graphics, no canvas2D dependency)

## Layout

```
src/
├─ main.ts            Web entry (creates the Application)
├─ game/
│  ├─ Game.ts         assembly, main loop, layers, gameplay orchestration
│  ├─ config.ts       constants
│  ├─ layers.ts       render layers (ground/shadow/entities/fx/ui)
│  ├─ Entity.ts       base: gx/gy/z, sync transform, shadow
│  ├─ Actor.ts        logical entity (HP/facing/movement/faction)
│  ├─ Skin.ts         appearance (placeholder Graphics, the decoupling point)
│  ├─ Bullet.ts       bullet
│  ├─ Enemy.ts        simple shooter enemy
│  ├─ input.ts        input abstraction (Web keyboard+mouse; WeChat swaps in touch)
│  └─ weapons/
│     ├─ Weapon.ts    abstract weapon base
│     ├─ RangedWeapon.ts
│     └─ MeleeWeapon.ts   with block/deflect
└─ platform/          platform isolation (WeChat adaptation added later)
```

## WeChat verification

See `../design/04-wechat.md`. Core logic (`src/game`) is separated from the platform entry; the WeChat entry is added later under `platform/wechat` as `game.js` + weapp-adapter.
