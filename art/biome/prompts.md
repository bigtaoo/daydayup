# Biome floor/wall swatch prompts (archive)

`design/13`'s still-open "other biomes' looks" — the room ground/walls were a code-only
palette tint (`game/theme.ts`'s `biomePalette()`) until now. This batch is the first real
ART pass: **tileable swatches**, not illustrated rooms — `RoomBuilder.ts` now lays these
down as a `TilingSprite` covering the whole room/wall rect (see `render/biomeTiles.ts`).

**Two prior prompt attempts for this exact asset failed the same way** (noted in
`design/13`'s "To design" list before this file existed): they came back as painterly
isometric ROOM ILLUSTRATIONS — a complete drawn scene with a camera angle and composed
lighting — instead of a small repeatable material swatch. That art is unusable here no
matter how good it looks, because `TilingSprite` repeats the image edge-to-edge; a scene
with perspective and baked shadows creates an obvious seam and a fake sense of a "room
within a room" when tiled. Every prompt below is written to avoid that failure mode
explicitly, not just by omission.

Generated with **GPT Image 2**.

## Locked swatch style, in one paragraph (paste as context, EVERY time)

A small SQUARE TEXTURE SWATCH ONLY — a flat material sample meant to be repeated
edge-to-edge in a tiling grid, like a game texture atlas tile. This is NOT an illustration
of a room, NOT a scene, NOT a camera view, NOT isometric, has NO characters, NO furniture,
NO horizon, NO perspective, NO vanishing point, NO directional lighting or cast shadows —
just a flat, straight-down orthographic view of a small patch of ground/wall material,
lit evenly. The four edges of the image must match up so the pattern repeats seamlessly
when placed in a grid next to copies of itself. Style: flat cel-shaded 2D mobile-game
texture, bold clean thin outlines on individual stone/tile seams only (not a border around
the whole image), flat solid colour fills, minimal gradient, matching a dark charcoal-navy
stone dungeon floor base (hex approximately #161A24 for floor, #2A3140 for wall) with only
a SMALL, SUBTLE tint of the biome's element colour mixed in — the environment stays
desaturated and dark (`design/13`'s "environment desaturated, hazards saturated" rule); the
raw saturated element hue is reserved for bullets/status FX/loot, not the floor itself.

## Floor swatches (4)

### `floor_neutral` — entry-zone / default floor
> [paste style paragraph above] The floor is dark charcoal-navy stone flagstone, cut into
> roughly even rectangular slabs with thin dark seam lines between them, no colour tint at
> all — this is the game's default, un-themed floor.

### `floor_fire` — ember biome floor
> [paste style paragraph above] The same dark charcoal-navy stone flagstone base, but with
> a subtle warm orange-red undertone (a small tint only, the stone should still read as
> dark grey-navy first) and a few thin cracked seams with a faint warm ember glow inside
> the cracks, like heat-baked stone near a fire source.

### `floor_ice` — ice biome floor
> [paste style paragraph above] The same dark charcoal-navy stone flagstone base, but with
> a subtle pale cyan-blue undertone (a small tint only, the stone should still read as dark
> grey-navy first) and a faint thin frost/rime pattern dusted across the seams, like cold
> stone in a frozen zone.

### `floor_lightning` — lightning biome floor
> [paste style paragraph above] The same dark charcoal-navy stone flagstone base, but with
> a subtle pale yellow undertone (a small tint only, the stone should still read as dark
> grey-navy first) and a few thin hairline cracks with a faint yellow static-charge glow
> inside them, like stone charged with latent electricity.

## Wall swatches (4)

### `wall_neutral` — entry-zone / default wall
> [paste style paragraph above] A dark slate-grey vertical wall panel texture, blocky
> rectangular masonry blocks stacked in a simple running-bond pattern, thin dark mortar
> seams, no colour tint at all — this is the game's default, un-themed wall.

### `wall_fire` — ember biome wall
> [paste style paragraph above] The same dark slate-grey blocky masonry wall base, but with
> a subtle warm orange-red undertone (a small tint only) and a couple of the mortar seams
> showing a faint warm ember glow, like heat-scorched masonry.

### `wall_ice` — ice biome wall
> [paste style paragraph above] The same dark slate-grey blocky masonry wall base, but with
> a subtle pale cyan-blue undertone (a small tint only) and a faint frost rime dusted along
> the top edge of each block, like cold masonry in a frozen zone.

### `wall_lightning` — lightning biome wall
> [paste style paragraph above] The same dark slate-grey blocky masonry wall base, but with
> a subtle pale yellow undertone (a small tint only) and a couple of the mortar seams
> showing a faint yellow static-charge glow, like masonry charged with latent electricity.

## Wall FRONT ELEVATION swatches (4) — the standing-wall pass, 2026-08-18

A second, separate wall asset. The `wall_*` swatches above are the wall's TOP surface, seen
straight down; these are the wall's **front face**, seen straight on. Both are used at once:
`RoomBuilder` draws a standing wall as `wallface_<element>` rising `WALL_HEIGHT` px from the
wall's south edge, with `wall_<element>` as the top cap lifted above it (`scene/wallGeometry.ts`
decides which walls stand). Only the south face and the top are ever visible — the camera is
fixed and never rotates (`design/01`) — so there is no side/end-cap art to generate, one image
per element covers it.

**The seam rule is DIFFERENT from every other swatch in this file, and saying so explicitly is
what made these come back usable on the first try:** an elevation tiles **left-right only**, and
its top and bottom must NOT match — the top is a lit coping edge, the bottom meets the floor.

### The elevation style paragraph (paste as context, EVERY time)

> A single SQUARE TEXTURE SWATCH of a dungeon wall's FRONT ELEVATION — the vertical face of a
> low stone wall seen straight-on, orthographic, no perspective and no vanishing point. This is
> NOT a room, NOT a scene, NOT isometric, NOT a top-down floor tile; no characters, no props,
> no floor, no sky, no cast shadows on the ground. IMPORTANT — seam rule differs from a normal
> tile: the LEFT and RIGHT edges must match so the image repeats seamlessly side-by-side, but
> the TOP and BOTTOM must NOT match. The top ~12% is a brighter lit coping/cap edge (the wall's
> top rim catching light from the upper left); the bottom ~15% is a darker band where the wall
> meets the floor. Vertically this image is used exactly once, never tiled. Style: flat
> cel-shaded 2D mobile-game texture, bold clean thin outlines on individual stone-block seams
> only (no border around the whole image), flat solid colour fills, minimal gradient, one
> consistent light direction from the UPPER LEFT. Base colour is dark charcoal-navy stone (hex
> approximately #2A3140) with only a SMALL, SUBTLE tint of the biome element colour mixed in.

### Per-element line

- **`wallface_neutral`** — no element tint at all, plain dark charcoal-navy blocks.
- **`wallface_fire`** — a faint warm orange-red tint (`#FF7043`) in the mortar seams and a few
  cracked blocks, as if heat-scorched; no visible flame, no lava, no glow.
- **`wallface_ice`** — a faint pale-blue tint (`#81D4FA`), a thin frost rime along the coping
  edge only.
- **`wallface_lightning`** — a faint yellow tint (`#FFF176`) in the seams, a few blocks with
  hairline fracture lines; no arcs, no sparks, no glow.

### What the accepted batch needed on top of the prompt

All four came back on-style and genuinely seamless left-to-right (measured, not eyeballed:
mean per-channel difference between the wrap columns was 1.6–7.2 vs. an adjacent-column
baseline of 0.6–1.9). Two mechanical fixes were still needed, both done at import time rather
than by regenerating:

1. **Crop the band above the coping.** Each image had a strip of flat background above the
   wall's top edge (9–48 px of 1920). Found by scanning for the first row with real horizontal
   variance — a uniform band has near-zero row std-dev — not by eye.
2. **Crop to the top ~50% and re-darken its new bottom edge.** The full image is ~9 courses of
   brick; squashed into a 70 px wall those read far finer than the floor stones next to them.
   Keeping the top half puts coping + ~4 courses in the same 70 px, which matches the floor's
   scale, and a linear darkening ramp over the bottom 20% of the crop restores the base shadow
   the crop threw away. **This is the step to redo if `WALL_HEIGHT` ever changes.**

Note the three generations delivered as `.webp`, which this repo's pure-Node PNG pipeline
cannot decode; they were converted at import (Pillow, outside the repo's own tooling — a
one-time boundary step, not a new dependency) and archived as `wallface_*_raw.png`.

## Not generated this pass

`poison` has no floor/wall swatch yet — `design/13` already flags poison as not-floor-1 and
still without a dedicated enemy critter either, so it stays on the code-only palette tint
(`RoomBuilder.ts`'s existing fallback) until a poison biome is actually scheduled.

## Workflow reminder

Save accepted generations as `art/biome/<name>_raw.png`, rejects as `art/biome/<name>_alt.png`
(same convention as `art/weapon`/`art/ui`). **Verify tileability, not just style**, before
accepting: decode with `tools/png-pipeline/pngCodec.mjs`, and eyeball whether the left/right
and top/bottom edges roughly match — GPT Image 2 has no native "seamless tile" mode, so
some edge mismatch is likely even on an otherwise on-style result and may need a manual
edge-blend pass (`png-pipeline` doesn't have one yet — flag it if this becomes a recurring
problem, don't build one preemptively). After judging, run through
`node tools/png-pipeline/compress.mjs --long-axis=256 <file>` and drop the result into
`client/public/biome/<name>.png`. `render/biomeTiles.ts`'s asset table already has all 8
keys wired, and `RoomBuilder.ts` already renders via `TilingSprite` when a texture exists —
no code change needed once a file lands at its expected path.
