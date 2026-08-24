# Room prop prompts (2026-08-24)

Room dressing for `RoomPiece.props` — the last Graphics placeholder left in a level-1 room
(`client/src/game/scene/propRender.ts`'s crate/barrel/rubble silhouettes). Three kinds, four
generations, one reject. Shipped copies live in `client/public/environment/prop_*.png`.

Generated with GPT Image 2. Sizes and tonal targets below are derived from the code that
draws these, not chosen by eye:

| kind | `halfW` | drawn (world px) | shipped file | source |
| --- | --- | --- | --- | --- |
| crate | 9 | 18 x 16.0 | `prop_crate.png` 144x128 | `prop_crate_raw.png` |
| barrel | 8 | 16 x 22.3 | `prop_barrel.png` 128x178 | `prop_barrel_raw.png` |
| rubble | 11 | 22 x 6.0 | `prop_rubble.png` 176x48 | `prop_rubble_raw.png` |

`buildPropBody` scales a prop by WIDTH and lets the art's own aspect set its height, so the
aspect ratio IS the height spec — `propRender.test.ts` re-derives each `PROP_METRICS.height`
from the shipped PNG rather than trusting the table.

**Shipped at 8x the drawn long axis, not the 4x the pillar used.** `MAX_ZOOM` is 4.5 and
`WebPlatform` caps `resolution` at 2, and level 1's rooms measurably render at zoom 4 on a
wide viewport — so the worst realistic magnification is 8x and the files are sized for it.
The pillar's 3.9x means it is the softer asset of the two at high zoom; that is a gap in the
pillar, not a reason to repeat it.

## The shared style paragraph

Repeated **in full** in every one of the three prompts. Stating it once in a preamble does not
hold: later prompts in a batch drift back toward a scene/room rendering, which is what the
`biome/prompts.md` "NOT a scene/room" language exists for too.

```
Flat-cel game art asset for a top-down-tilted 2D dungeon crawler. Orthographic
projection, fixed camera looking down at roughly 60 degrees from horizontal, so the
object shows a large top surface and a small front face. Key light from the UPPER
LEFT; the right and lower-right sides fall into shadow.

Low-chroma, desaturated stone-and-wood palette, overall average colour around
RGB(55, 58, 68). This is background environment scenery, not a collectible: it must
NOT look bright, glossy, saturated, clean, or valuable.

The background must be REAL transparency (alpha = 0). Do NOT draw a grey-and-white
checkerboard or any other pattern to represent transparency — a painted checkerboard
is a defect. No drop shadow, no ground plane, no cast shadow: the game draws the
shadow itself. NO outer glow, bloom, or halo of any kind — the game draws all glow
itself.

A single object, centred, with at least 8% transparent margin on every side. Nothing
else in the frame: no floor, no wall, no room, no scene, no second object.

This is displayed in game at only about 18 pixels wide, so the SILHOUETTE has to
carry it: bold simple shape, strong value contrast between the top surface and the
front face. Do not rely on any detail finer than one sixth of the object's width —
thin lines vanish completely at display size.
```

## crate — `prop_crate_raw.png`, accepted first time

```
[shared style paragraph]

Subject: a battered wooden supply crate, abandoned dungeon scenery.
Proportions: WIDER THAN TALL, width:height = 18:15.
Weathered dark wood planks, one or two slats broken or missing, dull iron corner
brackets gone matte with age. Sitting flat and closed.

CRITICAL: this game already contains a bright, clean, blue-grey LOOT crate that the
player walks over to pick up. This crate is scenery and must be unmistakably NOT
that one — darker, browner, visibly damaged, no metal shine, no rim light, nothing
that reads as openable or worth approaching.
```

The loot-crate constraint worked and is worth keeping in any future scenery prompt: the two
objects share a name and a silhouette, and only VALUE separates them in play
(`pickup_crate.png` medians luma 167, this one 53). Its warm lean (R+10.0/B-9.6) is the one
measurement outside the environment set, which is every-other-asset blue — kept deliberately,
because it is wood and its chroma of 20.0 is still inside the shipped band.

## barrel — `prop_barrel_raw.png`, accepted first time

```
[shared style paragraph]

Subject: a squat sealed wooden barrel, abandoned dungeon scenery.
Proportions: very slightly taller than wide, width:height = 16:17.
Dark weathered staves, two dull iron hoops, a flat lid on top seen at the camera's
tilt so it reads as a shallow ellipse.

CRITICAL: the lid must NOT read as an EYE. Every character, critter and boss in this
game is a single large eye, so a pale disc with a darker centre — or any set of
concentric rings — is a fiction-breaking mistake here. Draw the lid DARK and flat,
the same value as the staves or darker, crossed by two or three straight plank lines
and one straight cross-brace. No concentric circles, no pale centre, no bright rim,
no highlight ring.
```

The anti-eye constraint worked; the aspect request did not. It came back at 0.719 against the
0.94 asked for, so the barrel stands 22.3 px rather than 17. Accepted and `PROP_METRICS` moved
to match, rather than squeezing the art: 22.3 is still a third of the 70 px where the occlusion
x-ray band starts, and `PROP_HEIGHT_CEILING_PX` now pins that reasoning instead of a comment
claiming "under 18". One thing it does NOT do is follow the key light — its lid measures 46-51
against staves at ~48, where the pillar's top cap is 90-98 over a 42 shaft. Not fixable with
`lumaCurve.mjs` (lid and staves share one luma cluster) and only visible beside a pillar, so
it ships. Worth an explicit "the top surface must be the brightest plane in the image" line in
the next barrel-like prompt.

## rubble — `prop_rubble_raw.png` accepted, `prop_rubble_alt.png` REJECTED

First attempt used the same wording as the accepted one below minus the block/value paragraphs.
It came back as long thin diagonal splinters, 23% too wide, and far too bright:

| | rejected `_alt` | shipped | reference |
| --- | --- | --- | --- |
| aspect | 4.53 | 3.67 | 3.67 wanted |
| luma p25/50/75/95 | 43/61/101/130 | 35/48/77/95 | pillar 41/43/66/102 |
| hue lean | R+1.1 / B+0.5 | R-3.9 / B+5.8 | floor R-6.9 / B+8.3 |

At 22 px over the ember floor it read as a heap of pale bone chips — backwards from design/13's
"environment desaturated, hazards saturated", where a light heap reads as loot. The tone half
was fixable offline (`lumaCurve.mjs --lo=35 --hi=110 --lo-gain=0.95 --hi-gain=0.5` plus a cool
tint landed it at 36/45/52/61) and the SILHOUETTE was not, which is what decided the reroll: a
curve cannot turn splinters into masonry.

`propArt.test.ts`'s last describe block re-measures the reject on all three axes, so an
assertion that stops discriminating fails outright instead of passing vacuously. Its chroma was
6.3 — the lowest of any file in the batch — which is pinned there too, as the reminder that
judging art on one number is how a bad file ships.

The reroll, accepted:

```
[shared style paragraph]

Subject: a collapsed section of dungeon masonry — part of a stone wall that has
fallen and heaped on the floor.
Proportions: wide and low, width:height = 22:6.

Draw BLOCKS, not shards. Four to six chunky rectangular ashlar stones the size of
bricks, stacked and leaning against each other in one connected heap, with only a
little fine gravel around the base. Do NOT draw long thin diagonal splinters, spikes,
or a spiky ridge — the result must read as broken WALL, not as a pile of debris or
bone fragments.

Because the camera looks down at 60 degrees, the upward-facing top face of each block
must be clearly visible and must be the BRIGHTEST plane in the image; the vertical
sides fall into shadow at roughly 45% of the top face's brightness.

Value target, important: this is dark dungeon stone, the SAME stone as the floor it
sits on. Overall it must be dark — a median brightness around 45 out of 255, with the
brightest lit tops no higher than about 100. Do NOT draw pale, whitish, or chalky
stone; a light-coloured heap reads as loot in this game and is a defect. Cool
blue-grey, never warm or sandy.
```

Three things in that reroll each fixed a measured failure and are worth reusing: **naming the
primitive** ("BLOCKS, not shards", with a count), **stating the value target numerically**
(median ~45, highlights <=100 — it landed on 48/95), and **naming what a wrong value would be
mistaken for** ("reads as loot in this game and is a defect"). Aspect came back at 3.69 against
3.67 asked, which is the only time in this batch a stated ratio was honoured.

## The import chain, and the defect that made it necessary

```bash
# 1. clamp both alpha plateaus BEFORE the trim
node tools/png-pipeline/alphaClamp.mjs client/public/environment/prop_{crate,barrel,rubble}.png
# 2. trim + downsample (long axis = 8x the drawn long axis)
node tools/png-pipeline/compress.mjs --long-axis=144 client/public/environment/prop_crate.png
node tools/png-pipeline/compress.mjs --long-axis=178 client/public/environment/prop_barrel.png
node tools/png-pipeline/compress.mjs --long-axis=176 client/public/environment/prop_rubble.png
# 3. audit
node tools/png-pipeline/alpha-audit.mjs client/public/environment
```

`alphaClamp.mjs` is new, and step 1 is not optional. All three generations arrived with an
alpha histogram that reads bimodal and is not: a body at 252-253 rather than 255, wrapped in a
veil of alpha 1-10 reaching 50-140 px past the object. Both ends are invisible — 99% and 4%
opacity — and `alpha-audit.mjs` reads the pair as one "suspicious" file with no opaque pixels
at all. Each end breaks something different:

- **The veil wrecks the geometry.** `trimAlphaBoundingBox` keeps any pixel with `alpha !== 0`,
  so the rubble trimmed to aspect 2.95 instead of 3.67 — and since a prop is scaled by width
  with the art's aspect setting its height, it would have stood 25% too tall. The trim also
  kept 123 empty rows under the rubble and 138 under the barrel, and a prop sprite is
  bottom-anchored to its ground point, so both would have hovered off the floor.
- **The 253 plateau retires the audit.** `alpha-audit.mjs` classifies on `alpha == 255`, so a
  clean file reports 0% opaque / 83% partial and the audit stops being a signal anyone reads.

Every file shipped before this pass measures identically at `alpha > 0` and `alpha > 25` — they
were all keyed or thresholded on import, so `trimAlphaBoundingBox`'s `alpha !== 0` had never yet
been handed a file where it mattered. `propArt.test.ts` decodes the shipped copies and asserts
the trim is tight and the body genuinely opaque, so nothing records "was the step run" by
memory.
