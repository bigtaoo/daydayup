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
export const CAP_LIGHT_BLEND = 'add' as const;

/**
 * ...and the correction to *that* (2026-08-19, fourth volume pass, user report on a north-south
 * run: *"那段墙体看起来很奇怪"*).
 *
 * A FLAT additive constant hits the target luma and destroys the stone anyway, because contrast
 * is perceived as a RATIO, not as a difference. The swatch's stone-to-mortar range is about
 * 30..60, i.e. 2:1; adding a constant 47 to both ends gives 77..107, which is 1.4:1. The
 * amplitude the previous doc set out to protect survives in absolute terms and the *look* does
 * not: at play scale the cap became featureless pale concrete. On an east-west wall the cap is a
 * 32 px band under a lit coping and nobody notices; on a north-south run the cap is 100% of what
 * you see of the wall (224 px deep on level 1's shortest one), so the whole wall read as a pale
 * concrete beam laid across the floor.
 *
 * The fix is to lift the cap MULTIPLICATIVELY, which Pixi cannot do with a tint (tints only
 * multiply *down*) but can do by drawing the cap swatch A SECOND TIME in `add` mode: the result
 * is `value × (1 + alpha)`, so 30..60 becomes 59..117 — the same target value with the 2:1
 * ratio intact. `CAP_BOOST_TINT` carries the key light's warmth on that second copy instead of a
 * separate wash, so the top is still warm against a cool floor for one draw call, not two.
 *
 * Measured on the shipped floor after the change: north-south cap 80, east-west cap 72, floor 45,
 * face 43/16 — the same hierarchy the flat version reached (89/78/45), with the stone visible.
 */
export const CAP_BOOST_ALPHA = 0.95;
export const CAP_BOOST_TINT = 0xfff2e0; // NormalLitFilter's key-light colour

/** The flat additive is kept for the NO-SWATCH fallback only: that cap is a single palette fill,
 *  so it has no contrast to preserve and nothing to draw a second copy of. */
export const CAP_LIGHT = 0x35312a; // ≈ +47 luma, taking the ~46 swatch to ~93

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

/**
 * Where each face swatch's CROWN course ends — `[row, total rows]` **straight off the shipped PNG**,
 * one entry per element, not derived from `FACE_COPING_FRACTION` above (which is a shading reach,
 * tuned by eye).
 *
 * The row is the **darkest row in the swatch's top third**: its mortar line, the joint between the
 * coping course and the first brick course. That line is where a tucked run's art stops
 * (`WallJoins.tuckLiftPx`), and it is where the user's marked rectangle began — the crown is the
 * longest unbroken horizontal in a room, so it is the line the eye identifies a back wall by. Break
 * it and the wall stops being one wall; keep it and every brick course below is fair game for
 * whatever stands in front.
 *
 * **Per element, because the swatches genuinely disagree** — and nothing in the renderer would ever
 * have said so. `wallComposition.test.ts` measures all four on every run: fire and lightning put
 * their mortar line at row 27 of 127, neutral at 25 of 125, and **ice at 17 of 125** — its coping
 * band is a third shorter than the others'. A single constant taken from fire would have sliced
 * straight through an ice room's crown, which is the exact defect this whole corner treatment
 * exists to prevent, shipped invisibly on two biomes out of four.
 *
 * Row-luma scans behind the numbers (256-wide swatches, mean per row):
 *   - fire 127 rows: coping 0-20 at 97-173, mortar 21-30 (76 -> 7 -> 22), brick 31+ at ~50
 *   - ice 125 rows: coping 0-13 at 75-186, mortar 14-19 (58 -> 10 -> 25), brick 20+ at ~44
 *   - lightning 127 rows: coping 0-24 at 62-180, mortar 25-30 (51 -> 22 -> 37), brick 31+ at ~48
 *   - neutral 125 rows: coping 0-22 at 62-142, mortar 23-29 (51 -> 15 -> 35), brick 31+ at ~52
 */
export const FACE_CROWN_ROWS: Readonly<Record<string, readonly [number, number]>> = {
  fire: [27, 127],
  ice: [17, 125],
  lightning: [27, 127],
  neutral: [25, 125],
};

/** The SHALLOWEST crown of any shipped swatch, and therefore the safe default for an element with
 *  no art of its own (`poison` ships none, so its walls are on the Graphics fallback): clipping to
 *  the shallowest crown can never cross a deeper one. */
export const FACE_CROWN_FRACTION_MIN = 17 / 125;

/** The measured crown fraction for `element`, or the conservative default. */
export function faceCrownFraction(element: string): number {
  const rows = FACE_CROWN_ROWS[element];
  return rows ? rows[0] / rows[1] : FACE_CROWN_FRACTION_MIN;
}
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
/**
 * How far the east band and the west chamfer reach NORTH of the cap/face fold, in world px.
 * Bounded 2026-08-19 for the same reason `CAP_GRADIENT_REACH_PX` is, and it is the second half of
 * the *"那段墙体看起来很奇怪"* fix.
 *
 * Both bands used to span the block's whole art, `capTop .. 0`. On an east-west wall that is
 * 32 + 104 px and correct — it is the block's east END, and this projection stacks the end's cap
 * and face rows on top of each other. On a north-south run the SAME rects are 224 px long and run
 * down the block's LENGTH, which is not an end at all: a 13 px stripe at alpha 0.86 painted along
 * the top of a wall reads as a flat grey panel laid over the stone, hard-edged, with the swatch
 * visibly continuing underneath it. In a 3x render it was the single loudest artifact on the
 * wall the user circled.
 *
 * So the band stays at full strength over `SIDE_CAP_SOLID_PX` of cap — one wall thickness, which
 * is exactly the whole cap of an east-west wall, leaving that case pixel-identical to before —
 * then fades out over `SIDE_CAP_TAPER_PX` more (`SIDE_REACH_TAPER`, so there is no hard horizontal
 * cut where it stops), and the rest of a deep run's length gets `CAP_EDGE_*` instead.
 */
export const SIDE_CAP_SOLID_PX = 32;
export const SIDE_CAP_TAPER_PX = 48;
/** Alpha multipliers for the taper's length-bands, nearest the fold first. */
export const SIDE_REACH_TAPER: readonly number[] = [0.7, 0.4, 0.15];

/**
 * The cap's own long edges — the crease where a top surface turns down into a side plane this
 * projection draws at zero width. A NARROW dark bevel (not the face's 13 px band), ramped, along
 * the full depth of the cap on both sides: it is what keeps a north-south run's top reading as a
 * raised mass with edges once `SIDE_CAP_REACH_PX` stops the flat panel. East side stronger than
 * west, which is where the key light is.
 */
export const CAP_EDGE_PX = 5;
export const CAP_EDGE_MAX_FRACTION = 0.3;
export const CAP_EDGE_ALPHA = 0.5;
export const CAP_EDGE_WEST_SCALE = 0.55;
export const CAP_EDGE_STEPS = 5;

/**
 * The crease a corner makes on the wall it stands in front of.
 *
 * At an L/T corner the near run's mass occludes the far wall's front face, and after `WallJoins`
 * removed the false edges from the two caps that occlusion was the last thing still reading as
 * "pasted on": a hard vertical texture boundary between stone and brick with nothing to say which
 * is nearer. A mass standing against a vertical surface darkens it along the contact, and under
 * this project's upper-left key light it darkens the DOWN-LIGHT (east) side more — the same
 * asymmetry `SIDE_*` and `CAP_EDGE_*` already use. Drawn on the far wall's own face, since that is
 * the surface receiving it, from the join interval's edges outward.
 */
export const CORNER_AO_PX = 13;
export const CORNER_AO_ALPHA = 0.42;
export const CORNER_AO_WEST_SCALE = 0.45;
export const CORNER_AO_BANDS = 6;

/**
 * The re-entrant corner a TUCKED run makes — `WallJoins.tuckNorth`, the *"相交的部分进行立体化处理"*
 * half of that report.
 *
 * Once a deep run stops at its own footprint edge instead of climbing the far wall's face, the
 * junction is no longer an overlap: it is an inside corner between the run's top surface and the
 * wall's front face, and an inside corner is the darkest place on either of them. Two creases, both
 * needed — one on each surface, or the run reads as sliding under a curtain rather than meeting
 * stone:
 *
 *   - `TUCK_CAP_*` — on the run's own cap, ramping north into the wall. Deeper than `CAP_EDGE_*`
 *     because this corner is enclosed on three sides, not one.
 *   - `TUCK_FACE_*` — on the far wall's CROWN, over the run's width: the contact shadow a mass
 *     standing right under an overhanging course throws onto its underside. Everything of that face
 *     below the crown is covered by the run's own cap, so the crown is the only part left to shade —
 *     and it is the brightest band on the wall (luma ~80 after `FACE_TINT`), i.e. the one place
 *     where alpha spent here is actually visible.
 *
 * A previous round put this crease over the face's whole height at `TUCK_FACE_FRACTION = 0.5` and
 * then 1.0, back when a tucked run stopped at the wall's FOOT and the whole face was exposed. Both
 * are recorded because the first one is the instructive failure: confined to the contact it measured
 * 9 vs 13, arithmetically present and invisible, because the bottom 42% of that face is already
 * crushed by `BASE_AO_*`. Same trap as the pre-2026-08-19 contact shadow — always check what value
 * a surface still HAS where you are about to darken it.
 */
export const TUCK_CAP_PX = 14;
export const TUCK_CAP_ALPHA = 0.5;
export const TUCK_CAP_BANDS = 7;
export const TUCK_FACE_ALPHA = 0.5;
/** Share of `TUCK_FACE_ALPHA` at the TOP of the crown, where the contact is furthest away. */
export const TUCK_FACE_TOP_SCALE = 0.25;
export const TUCK_FACE_BANDS = 8;
/** How far the face crease spills past the run's own width, in world px — a contact this hard
 *  never stops at a razor edge, and the down-light (east) side spills further. */
export const TUCK_FACE_SPILL_PX = 7;
/** The lit west chamfer. Warm rather than pure white — it is the same key light the cap gets, and
 *  a neutral-white stripe beside a warm-lit top reads as two light sources. */
export const LIT_EDGE_PX = 6;
export const LIT_EDGE_COLOR = 0xfff2e0;
export const LIT_EDGE_ALPHA = 0.2;
