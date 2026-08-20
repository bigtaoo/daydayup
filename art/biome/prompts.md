# Biome art prompts (archive) — floor/wall swatches, and the pillar sprite

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

## Pillar SPRITE (1) — the pillar pass, 2026-08-20

A third kind of asset in this file: not a swatch at all, but one whole OBJECT. `design/ROADMAP`'s
"pillars read as smooth cans next to the walls" item — their cap was a flat hand-toned gradient
where a wall cap is a real swatch, and `pillarRender.ts` records an earlier attempt at texturing
them FROM the wall swatches that came out worse (a ~35 px cap window onto a 256 px swatch lands on
one arbitrary dark patch; the brick elevation on the shaft read as an open-topped well).

**One file for every biome, not one per element.** A pillar is a fixed-size object (`radius: 1` in
every shipped room, drawn 84x98), so the fix is art authored AT pillar scale; the biome's hue
arrives as a `Sprite.tint` (`pillarRender.pillarTint`), which is also how the hand-toned version
got it. `pillar_fire_alt.png` is a real per-element attempt that was NOT taken — see the rejects
below.

### The accepted prompt

> A single game SPRITE of one short round stone PILLAR (a squat stone column drum), drawn as a
> standalone object on a fully TRANSPARENT background. Output the image at 768 x 896 pixels. Leave
> a 4-pixel fully transparent margin on all four sides — no part of the pillar may touch the image
> edge, and the top ellipse must not be cut flat by the frame.
>
> This is NOT a scene, NOT a room, NOT isometric, NOT a texture swatch and NOT a tileable pattern.
> There is no floor or ground under it, no other objects, no characters, no background of any kind,
> and NO cast shadow on the ground — the game draws the shadow itself on a separate layer, so a
> baked shadow would double up.
>
> Camera: fixed, looking slightly down at the pillar from the FRONT. The top of the pillar is a
> shallow ellipse whose height is about 42% of its width; the shaft is seen straight-on below it.
> No perspective convergence, no vanishing point, no rotation, no tilt.
>
> Proportions, which matter because the game draws this at a fixed size: the whole object is about
> 0.86 as wide as it is tall. The top ellipse spans the full width of the object and occupies the
> top 36% of its height. The shaft runs from the middle of that ellipse straight down to the bottom
> of the object, with straight vertical sides all the way — no taper.
>
> Construction: a squat round stone drum of THREE courses of stone, each course separated by a
> single joint line, and every joint line must CURVE downward following the same ellipse as the top
> surface — never a straight horizontal line, because a straight line makes a cylinder read as a
> flat board. Nothing is carved or ornamented on it; no capital, no fluting, no runes, no cracks.
>
> IMPORTANT — the top is a SOLID CLOSED disc of stone. This is not a well, not a hollow tube, not a
> barrel, not a drum you could open, not an urn, vase, jar, pot, cauldron or basin. There is no
> opening, no hole, no inner rim and no lip on top. The top surface must stay the BRIGHTEST plane in
> the whole image, clearly brighter than any part of the shaft, because it is the surface facing the
> sky; if any part of the shaft out-shines it, the object reads as an open-topped well instead of a
> solid column.
>
> Lighting: one consistent light from the UPPER LEFT, baked in as flat cel-shaded bands, in this
> order from the left edge of the shaft: a lit band at approximately #4E555F ending about 36% of the
> way across, a mid band at approximately #424954 out to about 74%, and a dark limb at approximately
> #141720 for the remaining right-hand strip. The top surface sits at approximately #5B6472. Keep
> those relationships — a top clearly brighter than the lit band, and a dark right limb doing the
> work of the curve.
>
> Do NOT put a white or light-grey rim highlight anywhere on the top edge or the silhouette: a
> bright rim reads as polished metal or chrome, and this is dull, unpolished dungeon stone. Do NOT
> add a base plinth, a wider flared foot, or a darkened band at the very bottom — the game draws the
> pillar's ground contact itself.
>
> Style: flat cel-shaded 2D mobile-game art, bold clean thin dark outline on the object's silhouette
> and on the stone joints only, flat solid colour fills, minimal gradient. Dark charcoal-navy stone
> throughout, desaturated — this is the same stone as a dark dungeon wall, not concrete, not marble,
> not sandstone, and not grey. COARSE detail only: three courses on the whole shaft and no fine
> speckle, grain or noise, because the sprite is displayed at about 84 x 98 pixels in game and any
> fine pattern turns to colour mush at that size.
>
> No element tint at all in this version — plain dark charcoal-navy stone. This is the default,
> un-themed pillar.

### What the accepted generation needed on top of the prompt

`pillar_neutral_raw.png` is the KEYED result, not the generator's own bytes — the two mechanical
steps below were both necessary, and neither is visible by looking at the image:

1. **It came back with a painted transparency CHECKERBOARD.** 1664x2080, 3.46M opaque pixels,
   **zero** transparent ones: the generator drew the grey-and-white "this is transparent" pattern as
   real pixels. Keyed out by luma (background 233-255 against an object whose brightest plane is
   101 — a huge gap), then one erosion pass over light pixels bordering transparency (972 px), then
   cropped to the object (1307x1541, aspect 0.848 against the 0.857 asked for). Verified with a
   flood fill from the border: **0 interior holes**, and `alpha-audit.mjs` reports the shipped file
   as the only clean PNG in `client/public/biome`.
2. **Its SHAFT was twice as bright as the wall face beside it** — measured live in level 1's gallery
   room at zoom 1: lit limb 71.6 against a wall face's 27.3-27.5, while its top surface was already
   on target (87.3 against wall caps of 72-81). A pillar and a wall are the same stone under the
   same light, and a uniform multiply could not fix it: darkening the shaft would drag the top down
   with it. `tools/png-pipeline/lumaCurve.mjs` (new, and the reason it exists) scales RGB by a factor
   keyed off each pixel's own luma — `--lo=85 --hi=95 --lo-gain=0.68 --hi-gain=1` leaves the top
   surface untouched and pulls the three shaft bands from 84/59/30 down to 57/40/20. On screen after
   `pillarTint`'s own ~0.887 multiply: top **87.3**, lit limb **50.4**, mid **35.8**, dark limb
   **16.7**, foot **25.0**, against a floor of 48.5. **Redo this step if the art is regenerated** —
   `client/src/game/scene/pillarArt.test.ts` measures the shipped file and fails if it is skipped.

Pipeline, in order: `art/biome/pillar_neutral_raw.png` (keyed source of truth, untouched by the
curve) → copy to `client/public/biome/pillar_neutral.png` → `lumaCurve.mjs` → `compress.mjs
--long-axis=384` (326x384 shipped). 384 rather than 256 because `FxController.MAX_ZOOM` is 4.5 and
the renderer runs at up to 2x device pixel ratio: level 1's gallery room actually renders at zoom 4,
so the sprite is MAGNIFIED, not minified, in real play.

### The rejects, and what each one cost

Seven generations, six rejected — all six kept as `pillar_*_alt*.png`. Measured, not judged by eye:

| file | why it was rejected |
|---|---|
| `pillar_neutral_alt.png`, `pillar_neutral_alt2.png`, `pillar_fire_alt2.png`, `pillar_ice_alt.png`, `pillar_lightning_alt.png` | **all generated at exactly 84x98** — the game size, so zero headroom against a 4x camera zoom. This is why the accepted prompt states an output resolution. |
| `pillar_lightning_alt.png` | reads as an **open-topped barrel** — the exact drift the prompt's negative constraint is aimed at, and it still happened at 84x98. |
| `pillar_ice_alt.png` | top surface at luma **125**, the brightest thing in the room by a wide margin — a repeat of the defect design/01's "Volume, measured" pass fixed on 2026-08-19. |
| `pillar_fire_alt2.png` | no warm tint at all (R−B = −14.9 against the neutral's −18.5, i.e. inside the noise), cap only 23% of the height, and the art touched all four frame edges. |
| `pillar_fire_alt.png` | the one real near-miss, and the reason there is no per-element pillar art: it followed the canvas/margin/aspect spec exactly, but its course joints came back **straight** (centre-vs-edge sag of −2 px against the accepted file's +53) and its top surface occupies **21%** of the height against the accepted file's 30% — two files that would ship as two different camera angles. A `Sprite.tint` gets the warmth without either defect. |

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
