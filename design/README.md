# Design

This directory records **decisions** and **architecture**. It is the single source of truth for the team. Change the plan here first.

| Doc | Contents |
|-----|----------|
| [00-tech-stack.md](00-tech-stack.md) | Tech-stack decision record (why single-engine Pixi; why not Three.js / Cocos) |
| [01-rendering.md](01-rendering.md) | Rendering & depth: tilted view, Y-sort, height/shadow separation, layers, fake-3D techniques and limits |
| [02-entity-model.md](02-entity-model.md) | Entity model: Actor / Skin / Weapon three-layer split |
| [03-weapon-system.md](03-weapon-system.md) | Weapon system: ranged, melee, block/deflect, extensibility |
| [04-wechat.md](04-wechat.md) | WeChat mini-game adaptation, base-library version notes, verification checklist |
| [05-gameplay.md](05-gameplay.md) | Gameplay: core loop, PvE dungeon / PvP arena (separate modes), hybrid-gear economy, parry positioning, landscape controls |
| [06-netcode-determinism.md](06-netcode-determinism.md) | Netcode & determinism: server frame-broadcast lockstep + client prediction, deterministic `@dd/engine` core, migration plan (mirrors sibling project `funny`) |
| [07-collision-combat.md](07-collision-combat.md) | Collision & combat: circle/wall collision, uniform-grid broad phase, swept directional bullets, block/deflect & melee arcs (brad/fp-trig), damage pipeline, death & drops — bodies of `08`'s step 4–9 |
| [08-simulation-core.md](08-simulation-core.md) | Simulation core: `GameState` schema, fixed `step()` system order, per-tick twin-stick `PlayerCommand`, `InputSource`/replay/headless (concrete form of `06`'s principles) |
| [09-content-data.md](09-content-data.md) | Content & data model: `@dd/engine` config layout, weapon/enemy/skin/affix schemas, room-piece & seeded-dungeon formats, PvP fairness build-wall, human-units→fp/brad conversion & versioning |
| [10-ui-hud.md](10-ui-hud.md) | UI, HUD & screen flow: all-Pixi UI, the menu→loadout→match→result state machine, in-match HUD read from `state`/`events`, twin-stick input → `PlayerCommand` quantization boundary, landscape/safe-area layout, WeChat text constraints |
| _11 — audio (reserved, not yet written)_ | SFX/music: engine `events` → audio channel (`08`), WeChat `Audio` constraints (`04`), determinism/audio decoupling |
| [12-art-animation.md](12-art-animation.md) | Art & animation pipeline: Skin = shared rig + swappable atlas (`02`), spritesheet/animation-data + event-frame format, Pixi `Assets` loading (web + WeChat adapter), tilted-view authoring rules (`01`), art-is-presentation-only determinism rule |

## Decision format

Record each important decision as a one-line conclusion + rationale + impact, so it is easy to revisit "why we chose this" later.
