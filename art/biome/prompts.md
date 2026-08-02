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
