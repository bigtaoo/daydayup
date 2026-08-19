// New 2026-08-19 (volume pass): the tonal constants every standing thing in a room is drawn
// with. Its own module so `wallRender.ts` (blocks) and `pillarRender.ts` (cylinders) can both
// depend on it without depending on each other — a wall importing the pillar module and the
// pillar module importing the wall back would be exactly the cycle CLAUDE.md's split rules
// forbid.
//
// This file has no Pixi dependency and no geometry in it: only numbers, and the measurement
// that justifies them.

/**
 * **The tonal hierarchy, and the one thing in this pass worth getting right.**
 *
 * Measured off a live frame of the shipped floor on 2026-08-19 (luma 0-255, from a full-floor
 * `renderer.extract` so the camera cannot skew it), the room read like this:
 *
 * | surface                    | was | target |
 * |----------------------------|-----|--------|
 * | pillar top                 | 105 |     90 |
 * | **floor**                  |  53 |     53 |
 * | wall cap (east-west run)   |  44 |     90 |
 * | wall cap (north-south run) |  33 |     90 |
 * | wall face, upper           |  23 |     36 |
 * | wall face, at the base     |  14 |     17 |
 *
 * A top surface raised 104 px above the ground was DARKER THAN THE GROUND it stands on. That
 * single inversion is the physical cause of the user's *"就像一张图贴在地上"*: the most basic
 * reading anyone has for height — higher surfaces catch more light — was running backwards, and
 * no amount of silhouette, side band or cast shadow can outvote it. It also explains why a
 * north-south run was the worst case of all: 100% of what you see of one IS its cap (its face
 * only shows at the run's south end), so such a run was a floor-value ribbon lying on a
 * floor-value floor.
 *
 * The previous tuning got there honestly, for a reason that measurement removed. It was written
 * against the belief that `wall_<element>.png` is "a LIGHT grey stone" and the face swatch dark
 * charcoal, so all of its work went into separating the two from EACH OTHER — cap 0.95, face
 * pulled hard down to 0.5. In fact the two swatches have almost the same own-value (~46), and
 * the pair was being separated around the wrong midpoint: correct relative to one another, both
 * far too dark relative to the floor.
 *
 * Pixi tints only MULTIPLY, so a cap cannot be lifted above its swatch's own value by tinting
 * at all. `CAP_LIGHT` is an additive key light over the cap that does it instead — see its own
 * doc below for why additive rather than a translucent wash.
 */
export const CAP_TINT = 0xffffff; // no multiply at all — the key light below does the work

/**
 * The cap's key light, drawn as an ADDITIVE overlay rather than a translucent white wash
 * (2026-08-19, second look at the render).
 *
 * The wash version hit the target value and still looked wrong: a 0.21 white wash is a lerp
 * toward white, so it also compresses the swatch's own contrast by 21% — and a wall cap is
 * nothing BUT stone detail at that scale, so the cap came out as smooth brushed concrete. An
 * additive term adds the same constant to every pixel instead, lifting the surface while keeping
 * the mortar-to-stone amplitude intact. Warm, because the key light is warm (`NormalLitFilter`'s
 * 0xfff2e0) and because a warm top against a cool floor is a second, redundant channel carrying
 * the same "this is raised".
 */
export const CAP_LIGHT = 0x35312a; // ≈ +47 luma, taking the ~46 swatch to ~93
export const CAP_LIGHT_BLEND = 'add' as const;

export const FACE_TINT = 0xc2c8d6; // ~0.78 — a vertical surface catches less light, but not none

/**
 * How hard to suppress the face swatch's own lit COPING course, and over what share of the
 * face's height (measured from its top).
 *
 * `wallface_<element>.png` is a whole wall elevation — a bright coping course at the top, brick
 * below, a dark base at the bottom — used once at the wall's full height. Measured on the
 * shipped art, that coping lands at luma ~78-84 after `FACE_TINT`, i.e. AS BRIGHT AS the cap
 * above it. A vertical surface cannot out-shine the horizontal one it meets under an overhead
 * light, and when it does the eye stops believing the fold: the wall's brightest band ends up
 * halfway down its front. Tinting the whole face down instead is not an option — the art's own
 * internal range is ~5:1 (coping 230, brick 46), so any uniform multiply that tames the coping
 * crushes the brick to black. Hence a local correction on the coping band alone.
 */
export const FACE_COPING_FRACTION = 0.22;
export const FACE_COPING_SUPPRESS = 0.55;
/** Bands the suppression ramp is built from. 18, not the 5 the side bands use: the coping is the
 *  BRIGHTEST thing on the face, so an alpha step of 0.11 across it (which 5 bands gives) shows as
 *  five hard horizontal stripes — clearly visible in a 3x render, and the loudest artifact the
 *  first version of this correction introduced. At 18 the step is 0.03, i.e. ~5/255 on a coping
 *  that bright. Same reasoning as `rigShading`'s band count: the count follows from the largest
 *  step the eye may not see, and the brighter the surface underneath, the more bands it needs. */
export const FACE_COPING_BANDS = 18;

/** Depth gradient across the cap, north (far, lit) to south (near, folding into the face):
 *  band count and the alpha the ramp reaches at the fold. A deep cap — level 1's north-south
 *  runs are up to 6 grid cells, ~190 px — is otherwise a completely flat slab of one value,
 *  which is what a printed texture looks like and not what a lit surface looks like.
 *  Non-overlapping bands, so each band's alpha IS its ramp value and the steps never compound
 *  (the pillar shaft's first attempt stacked translucent bands and showed hard seams). */
export const CAP_GRADIENT_BANDS = 14;
export const CAP_GRADIENT_MAX = 0.2;
/** ...and how far in from the fold it reaches, in world px. Bounded (2026-08-19) because a
 *  north-south run's cap depth IS its length: spreading the ramp over a 450 px run turned it
 *  into a long gradient painted down a beam, which reads as a lighting artifact rather than as a
 *  surface receding. The physical cue is local to the fold — ambient occlusion in the crease and
 *  the top surface turning away right at its near edge — so bounding it is also the honest
 *  version. A shallow cap (a 32 px east-west wall) is shorter than the reach and keeps the full
 *  ramp across its whole depth, exactly as before. */
export const CAP_GRADIENT_REACH_PX = 90;

/** The fold where the cap meets the face — the block's own top-front corner. One hard dark
 *  line, because that is the sharpest tonal event on a real stone block and the eye uses it to
 *  separate "top" from "front". */
export const FOLD_ALPHA = 0.42;
export const FOLD_WIDTH = 1.5;

/** Vertical ramp down the front face into the floor crease, as a fraction of the face's height
 *  and the alpha it reaches at the very bottom. Ambient occlusion — the crease a vertical
 *  surface makes with a horizontal one is the darkest place in any room, and its absence is
 *  why a wall face can look like a poster. Was three discrete bands at 0.14/0.18/0.22; now a
 *  smooth ramp, for the same non-overlapping-band reason as the cap. Shared with the pillar's
 *  base, so a cylinder and a block meet the floor the same way. */
export const BASE_AO_FRACTION = 0.42;
export const BASE_AO_BANDS = 12;
export const BASE_AO_MAX = 0.3;

/** The block's silhouette outline. Was `palette.wallEdge` until 2026-08-18, which is a LIGHT
 *  salmon/steel for every biome — authored to be the highlight edge of a wall lying FLAT on
 *  the floor, where a light rim is right. On a standing block, stroked 2 px and then magnified
 *  by the room camera, it read as a bright wireframe box drawn over the art: in the first live
 *  render it was the single loudest thing in the frame, louder than any of the shading.
 *  design/13 asks for a flat-cel silhouette, and a silhouette is DARK. */
export const EDGE_COLOR = 0x0a0c12;
export const EDGE_ALPHA = 0.62;
export const EDGE_WIDTH = 1.5;

/** A lit coping along the cap's far (north) and west edges — the two edges of a top surface
 *  that turn toward the key light. */
export const COPING_ALPHA = 0.3;

/** The faked east-side band: a fixed dark COLOUR at high alpha rather than black-over-whatever,
 *  so it lands on roughly one value (~20) across both the now-bright cap and the mid-value face
 *  instead of drifting with whatever is underneath it. Widths in world px, capped at a share of
 *  the wall's own width so a thin stub isn't entirely side. */
export const SIDE_COLOR = 0x141821;
export const SIDE_ALPHA = 0.86;
export const SIDE_BAND_PX = 13;
export const SIDE_BAND_MAX_FRACTION = 0.34;
/** Sub-bands across both the east shade and the west chamfer. One flat rect at one alpha reads
 *  as a smoked-glass panel laid over the art — you can see the brick continuing underneath it,
 *  dimmed, with a hard edge where the panel stops (2026-08-19 render). Stepping the alpha across
 *  the band, strongest at the block's outer edge and fading inward, is what turns the same pixels
 *  into a surface curving away. `SIDE_STEPS` bands, alpha scaled by `(1 - t)` from the outer edge
 *  for the east side and by `t` for the west. */
export const SIDE_STEPS = 5;
/** The lit west chamfer. Warm rather than pure white — it is the same key light the cap gets, and
 *  a neutral-white stripe beside a warm-lit top reads as two light sources. */
export const LIT_EDGE_PX = 6;
export const LIT_EDGE_COLOR = 0xfff2e0;
export const LIT_EDGE_ALPHA = 0.2;
