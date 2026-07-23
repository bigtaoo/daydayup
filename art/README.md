# Art

> **Direction locked (2026-07-23):** flat-cel orb-core hero + universal-mount weapons + crystal-mirror enemies. See `design/13-worldview-art-direction.md` for the direction and `concept/prompts.md` for the generation prompts. Production assets are not built yet; the client demo still uses Pixi Graphics placeholders (no external textures).

## Plan (to refine)

- `sprites/` character, weapon, enemy texture atlases (exported via TexturePacker or a free atlas tool).
- `anim/` animation data (frame timing, anchors, events), **separate from textures** (see the skin-decoupling principle in `design/02-entity-model.md`).
- `tiles/` floor / wall tiles.
- `normal/` normal maps (for the dynamic-lighting milestone).
- `fx/` particle textures.

## Convention notes

- Tilted view: assets are drawn in 3/4 view (with a front face), not pure top-down.
- Each sprite defines a **ground anchor** (the orb's base) for Y-sort and shadows, and **two orbiting weapon-socket anchors** for weapon mounting (`13`; no hand — the socket is a universal, arm-agnostic mount).
- A new **character** = a new part atlas on the shared orb-core rig (+ its `SkinDef` stats); animation data is shared. There is no cosmetic reskin layer.
