# Design

This directory records **decisions** and **architecture**. It is the single source of truth for the team. Change the plan here first.

| Doc | Contents |
|-----|----------|
| [00-tech-stack.md](00-tech-stack.md) | Tech-stack decision record (why single-engine Pixi; why not Three.js / Cocos) |
| [01-rendering.md](01-rendering.md) | Rendering & depth: tilted view, Y-sort, height/shadow separation, layers, fake-3D techniques and limits |
| [02-entity-model.md](02-entity-model.md) | Entity model: Actor / Skin / Weapon three-layer split |
| [03-weapon-system.md](03-weapon-system.md) | Weapon system: ranged, melee, block/deflect, extensibility |
| [04-wechat.md](04-wechat.md) | WeChat mini-game adaptation, base-library version notes, verification checklist |
| [05-gameplay.md](05-gameplay.md) | Gameplay: core loop, PvE search-fight-extract (floors + extraction checkpoints) / PvPvE arena, HP+shield survivability, material economy, parry positioning, landscape controls |
| [06-netcode-determinism.md](06-netcode-determinism.md) | Netcode & determinism: server frame-broadcast lockstep + client prediction, deterministic `@dd/engine` core, migration plan (mirrors sibling project `funny`) |
| [07-collision-combat.md](07-collision-combat.md) | Collision & combat: circle/wall collision, uniform-grid broad phase, swept directional bullets, block/deflect & melee arcs (brad/fp-trig), damage pipeline, death & drops — bodies of `08`'s step 4–9 |
| [08-simulation-core.md](08-simulation-core.md) | Simulation core: `GameState` schema, fixed `step()` system order, per-tick twin-stick `PlayerCommand`, `InputSource`/replay/headless (concrete form of `06`'s principles) |
| [09-content-data.md](09-content-data.md) | Content & data model: `@dd/engine` config layout, weapon/enemy/skin/rarity/run-buff schemas, room-piece & seeded-dungeon formats, PvP fairness build-wall, human-units→fp/brad conversion & versioning |
| [10-ui-hud.md](10-ui-hud.md) | UI, HUD & screen flow: all-Pixi UI, the menu→loadout→match→result state machine, in-match HUD read from `state`/`events`, twin-stick input → `PlayerCommand` quantization boundary, landscape/safe-area layout, WeChat text constraints |
| [11-audio.md](11-audio.md) | Audio: SFX/music driven by the engine `events` queue (`08`) on the render clock, the event→sound cue map, WeChat `InnerAudioContext` constraints (`04`), determinism/audio decoupling (prediction-replay dedupe + catch-up coalescing), settings/buses (`10`), and an audio-sourcing note (AI + CC0 libraries) |
| [12-art-animation.md](12-art-animation.md) | Art & animation pipeline: character = shared orb-core rig + own atlas (`02`), own rig defs (editor rewritten, not funny's humanoid), orbiting-socket weapon mounting, twin-stick facing model, Pixi `Assets` loading (web + WeChat adapter), tilted-view authoring rules (`01`), art-is-presentation-only determinism rule |
| [13-worldview-art-direction.md](13-worldview-art-direction.md) | Worldview & art direction (art-first): floating orb-core hero + universal-mount weapons + crystal-mirror enemies, the Blight setting reverse-engineered from the art, flat-cel style, the element=colour dual-channel (colour + icon) law, desaturated-environment rule, tone |
| [14-meta-forging.md](14-meta-forging.md) | Meta & forging: blueprint unlock + per-run material crafting (5 elemental materials), intrinsic weapon rarity (no upgrades, no affixes — Soul-Knight route), characters-are-skins side-grade roster, PvP fairness (weapons walled structurally / characters by discipline), bounded no-gacha monetization |
| [15-pvp-arena.md](15-pvp-arena.md) | PvP arena: 8-player solo-or-squad battle royale, room-graph shrinking zone, `ArenaMap`/`CellTrait` map-editor schema, team/hostility model, PvP HP/weapon scaling, periodic cross-client anti-cheat checkpoints, sparse held-input net sync |
| [16-accounts.md](16-accounts.md) | Accounts: username/password login (SQLite + scrypt + opaque bearer sessions), never required to play, and the two things bound to an account — PvP ladder rating and forge blueprints/materials/loadout |
| [17-i18n.md](17-i18n.md) | Internationalization: English-canonical `t()` with compile-time key checking, the locale files, what is deliberately left untranslated, and the repo's English-only rule for code/comments/docs |
| [18-test-strategy.md](18-test-strategy.md) | Test strategy: the two meanings of "out of sync" — replay divergence, and systems disagreeing inside one build — the six gaps that were measured, and the four layers that closed them (contract gates incl. the committed golden hash, unit tests, parity sweeps, invariant smoke runs) |

## Where the plan lives

[ROADMAP.md](ROADMAP.md) is the ordered implementation plan and the running record of what
actually shipped, phase by phase, with dates. The docs above answer *what was decided and
why*; ROADMAP answers *what is built right now*. When a milestone closes, both get written
back to — a decision doc that still describes a shipped system as unbuilt is a bug.

## Decision format

Record each important decision as a one-line conclusion + rationale + impact, so it is easy to revisit "why we chose this" later.
