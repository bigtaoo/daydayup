# Gameplay: core loop, modes, parry

What the player actually does. This is the single source of truth for the **core loop**, the **two modes** (PvE dungeon / PvP arena), the **hybrid-gear economy**, and how **parry (block/deflect)** sits inside all of it. It builds on the weapon system (`03-weapon-system.md`), the entity model (`02-entity-model.md`), and must stay consistent with the netcode decisions already locked in `06-netcode-determinism.md` — especially **casual-first PvP** and **hybrid gear (persistent base loadout + in-run temporary drops)**.

## The decisions (locked)

- **Two separate modes, not one blended activity.** PvE is a **co-op dungeon run**; PvP is an **independent arena**. They do **not** share a map (no extraction-shooter intrusion).
- **PvP normalizes gear via unified presets.** The arena offers a **fixed, balanced set of preset loadouts** everyone picks from — players do **not** bring or clamp their own gear. Matches are decided by skill and in-match choices, not by who has ground more. This is the concrete meaning of `06`'s "casual-first."
- **Meta gear is horizontal / marginal.** Persistent progression grants **build breadth, cosmetics, and small stat deltas** — never a raw power ladder. In-run drops are the real power axis.
- **Parry is melee-category-limited.** Only melee weapons can deflect, and deflect is part of the swing itself — not a separate block (`03`). Choosing a ranged loadout means giving up parry — it is a genuine trade-off, not a universal skill everyone owns.
- **Landscape-primary.** The game ships **landscape only**; portrait is dropped. Twin-stick + corner buttons (`04`) need the horizontal space, and WeChat supports `deviceOrientation: "landscape"` in `game.json`.

### Why separate modes and not extraction

| Model | Verdict |
|-------|---------|
| **Separate PvE dungeon + PvP arena** | ✓ Cleanest to build and balance. PvE tunes difficulty/loot freely; PvP tunes fairness freely; neither constrains the other. Matches `06`'s casual-first and the frame-broadcast netcode. |
| Extraction (shared dungeon, PvP intrusion, lose gear on death) | ✗ Maximal tension but head-on collision with casual-first; "lose your gear" is the opposite of casual. Heaviest netcode load (open-world player state), and the maphack weakness of client-held full state (`06`) hurts most exactly here. |
| PvP carries full meta gear (RPG PvP) | ✗ Vertical meta would leak straight into PvP → veterans crush newcomers / pay-to-win. Rejected together with the "horizontal meta" decision. |

## Core loop (PvE dungeon run)

One run, roguelite-shaped:

```
Loadout (persistent gear)
   → enter dungeon (seeded) 
      → clear rooms: fight, pick up in-run drops, build up power
      → choose paths / rewards between rooms
      → boss
   → run ends (clear or death)
   → in-run power is wiped; persistent meta advances a little
   → back to loadout
```

- **In-run temporary drops are the power fantasy.** Weapons, affixes, and combo effects (`03` "rarity, affixes, combo effects") found *this run* stack into a build that resets at run end. This is `06`'s "in-run resources/drops are engine state, wiped each match."
- **Persistent gear is the base loadout** carried in as initial config (`06` "persistent gear is server-authoritative meta, loaded into the engine at match start"). Horizontal: it widens what builds you *can* start, not how strong you *are*.
- **Co-op:** same dungeon, cooperative, latency-tolerant. Starts single-player on `LocalInputSource` to validate feel, then the same `NetInputSource` broadcast for co-op (`06`). Enemy/boss AI runs inside the deterministic engine off injected PRNG, identical on every client.

### Dungeon generation

- **Hybrid: hand-authored room pieces stitched by a seeded procedural layout.** Reuse funny's PRNG roomgen for the layout/selection; keep encounter quality controlled by curating the room pieces. Standard roguelite answer — full-procedural risks uneven quality, fully hand-built kills replayability.
- Generation is driven by an **injected `Prng` seeded per run** (`06`), so a run is fully reproducible from `seed + input stream` (needed for co-op determinism and headless re-judge).

## PvP (arena)

- **3v3 / 4v4, casual-first** (`06`). Full frame-broadcast lockstep + local-player prediction.
- **Gear normalized via unified presets.** Players pick from a **fixed, balanced set of preset arena loadouts** — they do not bring or clamp their own gear. This is chosen over normalizing self-owned gear because a closed preset set has a bounded, exhaustible balance surface, whereas clamping the open horizontal affix/combo pool (`03`) is a combinatorial balance problem and lets collection *breadth* leak back in as a soft advantage — exactly the fairness risk `06` warns about. In-match pickups/power-ups (dropped on the map, equal for both teams) provide the in-match progression instead of persistent gear.
- Accepted trade-off: a player's meta collection does **not** show up in PvP. That is the point of separate modes — PvP tests execution, PvE tests build. A later, additive option could let a preset slot be filled by any *balance-equivalent* weapon the player owns; not in scope now.
- Separate mode = arena maps are hand-designed for PvP (sightlines, cover, symmetry), not reused dungeon rooms.

## Hybrid-gear economy (summary)

| Axis | Source | Persists? | Affects PvP? |
|------|--------|-----------|--------------|
| **Persistent meta gear** | account progression | Yes (server-authoritative meta) | **No** — normalized out |
| **In-run drops** | this dungeon run | No (wiped at run end) | N/A (PvE only) |
| **Arena preset / in-match pickups** | preset chosen at match start / dropped on map | No | Yes — the only PvP power source |

Keeping meta **horizontal** is what lets the same gear exist in both modes without breaking PvP fairness: in PvE it broadens builds, in PvP it is normalized away, and neither path is a raw power ladder. All balance numbers live in `@dd/engine` config (`06` "numbers live in one place"); this doc only names the shape.

## Parry (block/deflect) positioning

The pivot mechanic from `03`. Its identity across the game:

- **Melee-only, and it lives inside the swing.** There is no `isBlocking`/`blockArc` and no block button: a melee swing's sector (arc + range) deflects any enemy bullet caught in it — flipping faction and redirecting it (`03`). Ranged loadouts have no parry — the core ranged-vs-melee trade-off.
- **In PvE:** parry is a skill-expression tool against bullet-hell enemies/bosses — swing through the incoming pattern to bat it back. High skill ceiling, optional (ranged builds route around it with mobility/DPS).
- **In PvP:** deflecting an opponent's bullets back is powerful, but it is **already a commitment, not a free toggle** — parrying costs you a swing (its arc window, its cooldown, and facing the threat), and the melee-only restriction bounds it to players who gave up ranged pressure. Further costs (perfect-swing window, extra recovery) are engine-config balance, decided against real play.

## Controls & orientation

- **Landscape only.** Dropped portrait (see locked decisions).
- **Twin-stick** (`04`): left stick moves, right stick aims + fires; corner buttons for weapon 1 / weapon 2. There is no block or jump button — parry is the melee swing (right stick), so *timing the attack* is the deliberate act. (A future dodge, if added, will be a planar blink, not a jump.)
- Aim is abstracted as a screen `point` (mouse, web) or a `dir` (joystick, touch) driving the same loop (`04`), and is **quantized to an integer brad angle** on input for determinism (`06`).

## Relationship to the other docs

- **Weapons** (`03`): the loop's moment-to-moment depth is weapon variety + parry; this doc says *when/where* you acquire and swap them (drops in PvE, normalized loadout in PvP).
- **Entity model** (`02`): "characters are only skins, weapons carry gameplay" — so a run's power comes from the weapon/affix stack, not the character.
- **Netcode** (`06`): modes, gear split, casual-first, and determinism constraints all originate there; this doc must not contradict it.

## To design

- Run length / room count / difficulty curve (biomes? escalating floors?).
- Reward-choice structure between rooms (branching paths, shop, curse/blessing).
- Persistent meta content: what horizontal unlocks actually are (starting-loadout options, cosmetic skins per `02`, small stat trinkets).
- The PvP **preset loadout set** itself (how many presets, their archetypes/roles) and the in-match pickup table; win condition (elimination / score / objective).
- Death/penalty in PvE co-op (revive? run-over on team wipe?).

## Open questions

- Is co-op PvE **matchmade** or **friends/party only** at launch? (Affects `06` room/relay transport.)
- PvP in-match pickups: symmetric spawns only, or can they be contested map objectives?
- Parry vs PvP balance: does deflected player-damage get scaled down to avoid one-shot swings? Decide against real matches.
- Meta "horizontal" boundary: where exactly does a "small stat delta" stop being horizontal and become a ladder? Needs a numeric cap, set in engine config.
