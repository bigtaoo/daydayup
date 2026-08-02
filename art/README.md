# Art

> **Direction locked (2026-07-23):** flat-cel orb-core hero + universal-mount weapons +
> crystal-mirror enemies. See `design/13-worldview-art-direction.md` for the direction and
> the per-subject `prompts.md` files below for the generation prompts.
>
> **Status (2026-08-02):** production assets exist and the game loads them — the client is
> no longer Graphics-only. This directory holds the **source** art (full-resolution
> generator output, `.xcf` edits, rejected attempts kept for reference); what the game
> actually ships is the alpha-trimmed, downsampled, re-encoded copy under `client/public/`.
> Nothing in `art/` is loaded at runtime.

## Layout

| Directory | Contents | Shipped copy |
|-----------|----------|--------------|
| `concept/` | Direction/exploration pieces, named after the `prompts.md` prompt that produced them (`01_…`–`05_…`, plus the `retired_…` first direction) | — (reference only) |
| `units/` | Every character and enemy part: the three orb-cores (`shell`/`belly`/`eye_front`/`eye_back`, prefixed `skirmisher_`/`juggernaut_`, unprefixed = the default vanguard), the boss, and the enemy bodies (`enemy_critter`/`enemy_brute`/`enemy_floater`) | `client/public/skins/*/` |
| `weapon/` | Per-weapon-id business-end sprites (`<weaponId>_raw.png`) | `client/public/weapons/` |
| `biome/` | Floor/wall tiles per element + `prompts.md` | `client/public/biome/` |
| `ui/` | Hub background, button icons, result badges + `prompts.md` | `client/public/ui/` |
| `npc/` | Outpost NPCs (the Forger) + `prompts.md` | `client/public/ui/npc_forger.png` |
| `map/` | The rejected painterly-isometric room backgrounds (`room_*_painterly_rejected`) — kept only as a record of the approach that did not work; the biome look that shipped is the tile art in `biome/` | — (nothing bound) |

Animation data is **not** here: it lives with the rigs (`tools/animator/projects/*.editortao`
and the `RigDef`s in `client/src/render/`), separate from textures, per the skin-decoupling
principle in `design/02-entity-model.md`.

## Pipeline

Source PNG → alpha-trim → box-downsample to a ~320px long axis → re-encode with
`tools/png-pipeline` (a dependency-free pure-Node PNG codec — no image library is available
on the Node side) → commit under `client/public/`. Roughly 20–30× smaller files,
round-trip-verified byte-identical after encode.

Two traps this pipeline exists to catch, both hit for real:

- **Alpha.** A generator that returns an opaque background produces art that looks fine in a
  viewer and wrong in game. Verify the alpha channel by decoding pixels, not by looking.
- **Chroma-key fringe.** Keying out a background leaves a halo of near-background pixels;
  defringe it without eroding genuine glow edges.

## Convention notes

- Tilted view: assets are drawn in 3/4 view (with a front face), not pure top-down.
- Each sprite defines a **ground anchor** (the orb's base) for Y-sort and shadows, and **two
  orbiting weapon-socket anchors** for weapon mounting (`13`; no hand — the socket is a
  universal, arm-agnostic mount).
- A new **character** = a new part atlas on the shared orb-core rig (+ its `SkinDef` stats);
  animation data is shared. There is no cosmetic reskin layer.
- Weapon art is composed **socket upper-left, tip lower-right**; `render/weaponSkins.ts`
  carries a per-weapon `rotationOffsetRad` that cancels whatever pointing direction a texture
  actually baked in, measured from real alpha-pixel data rather than eyeballed.
- Source files are named after what they are (`<weaponId>_raw.png`, `belly.png`), never left
  as generator UUIDs. A rejected or superseded attempt keeps the same stem plus `_alt`
  (`_alt2`, …) so it stays next to the version that won.

## Still to come

- Real **authored** art to replace the AI-generated placeholders (`ROADMAP.md` 5.3).
- `normal/` normal maps for the dynamic-lighting milestone and `fx/` particle textures — both
  blocked on 5.4, neither started.
