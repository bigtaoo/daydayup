# Art

> Placeholder. Not addressed this round; the client demo uses Pixi Graphics placeholders (no external textures).

## Plan (to refine)

- `sprites/` character, weapon, enemy texture atlases (exported via TexturePacker or a free atlas tool).
- `anim/` animation data (frame timing, anchors, events), **separate from textures** (see the skin-decoupling principle in `design/02-entity-model.md`).
- `tiles/` floor / wall tiles.
- `normal/` normal maps (for the dynamic-lighting milestone).
- `fx/` particle textures.

## Convention notes

- Tilted view: assets are drawn in 3/4 view (with a front face), not pure top-down.
- Each sprite defines a **ground anchor** (feet) for Y-sort and shadows, and a **hand anchor** for weapon mounting.
- Swapping a skin = swapping a same-structure atlas; animation data is shared.
