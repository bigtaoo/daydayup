// Split out of wallRender.ts (2026-08-20, 500-line convention — CLAUDE.md form ①,
// "independent function modules"): the shading cues drawn on a standing block's OWN
// surfaces — the cap's depth gradient and long-edge bevel, the face art's coping
// correction, the west/east edge bands, the cap/face fold, and the base contact crease.
// Each of these reads only THIS block's own geometry, plus (where a cue must stop at a
// buried edge) `joins.south` as a mask — never a neighbour's own shape or height. That is
// the dividing line from the sibling `wallShadingJoins.ts`, whose cues exist only BECAUSE
// of a specific neighbouring wall mass (a tuck, a corner). `wallRender.drawBlockShading`
// calls every function in both files, in the same order the `wallTone.ts` numbers were
// measured against, onto one shared Graphics — order matters, since Pixi paints fills in
// call order and a later one draws over an earlier one.
//
// **Every ramp here is one quad sampling a shared ramp texture** (`render/shadeRamp.ts`,
// 2026-08-24 draw-call pass), where it used to be 5-20 adjacent constant-alpha rects. Two
// reasons, and the visual one came first: a stepped ramp has steps, and the counts that hid
// them (`CAP_GRADIENT_BANDS` = 14, `FACE_COPING_BANDS` = 18, `SIDE_STEPS` = 5) were each
// tuned by hand against one surface's brightness — `SIDE_STEPS`' own doc records the 5-step
// version of the coping correction showing "five hard horizontal stripes" in a 3x render.
// Sampling with the GPU's linear filter has no steps to tune. The second reason is that it
// took this block's shading from 520-2010 floats of geometry to about 150, i.e. from over
// Pixi's 400-float auto-batch line to well under it: 31 wall/door blocks were costing 50 of
// the level-1 start room's 107 draw calls, and each one a program switch either way.
//
// The ramps are anchored to explicit SEGMENTS rather than to the rect being filled — see
// `rampFill`'s doc for why (a cue clipped by `clampSpan` must truncate, not compress).
import { Graphics } from 'pixi.js';
import { alphaRamp, linearRamp, rampFill } from '../../render/shadeRamp';
import type { RectPx } from './wallGeometry';
import { blockCapTop, unjoinedSpans, type WallJoins } from './wallRuns';
import {
  BASE_AO_FRACTION,
  BASE_AO_MAX,
  CAP_EDGE_ALPHA,
  CAP_EDGE_MAX_FRACTION,
  CAP_EDGE_PX,
  CAP_EDGE_WEST_SCALE,
  CAP_GRADIENT_MAX,
  CAP_GRADIENT_REACH_PX,
  EDGE_COLOR,
  FACE_COPING_FRACTION,
  FACE_COPING_SUPPRESS,
  FOLD_ALPHA,
  FOLD_WIDTH,
  LIT_EDGE_ALPHA,
  LIT_EDGE_COLOR,
  LIT_EDGE_PX,
  SIDE_ALPHA,
  SIDE_BAND_INNER_SCALE,
  SIDE_BAND_MAX_FRACTION,
  SIDE_BAND_PX,
  SIDE_CAP_SOLID_PX,
  SIDE_CAP_TAPER_PX,
  SIDE_COLOR,
  SIDE_REACH_TAPER,
} from './wallTone';

/**
 * Cap depth gradient, falling from the far edge toward the fold and bounded to
 * `CAP_GRADIENT_REACH_PX` of it (a north-south run's cap depth is its whole LENGTH).
 * Masked out over `joins.south`: there the cap does not approach a fold at all, it
 * continues into the neighbouring mass's cap, and shading it toward a fold that isn't
 * there is what put a measured 66 -> 79 luma step down the middle of one continuous
 * stone top.
 */
export function drawCapDepthGradient(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const capTop = blockCapTop(r, height, joins);
  const capDepth = -height - capTop;
  // A capless block (`WallJoins.capless` — a door standing taller than the wall it is cut into)
  // has no top surface for a depth gradient to fall across. Returning early rather than filling
  // zero-height rects keeps the degenerate case out of the geometry buffer entirely.
  if (capDepth <= 0) return;
  const openSouth = unjoinedSpans(r.w, joins.south);
  const capReach = Math.min(capDepth, CAP_GRADIENT_REACH_PX);
  const far = -height - capReach;
  for (const [a, b] of openSouth) {
    // Nothing at the far edge, ramping to `CAP_GRADIENT_MAX` at the fold.
    g.rect(a, far, b - a, capReach)
      .fill(rampFill(linearRamp(), a, far, a, -height, { color: 0x000000, alpha: CAP_GRADIENT_MAX }));
  }
}

/** The face swatch's own coping course, pulled back under the cap's value — see
 *  `FACE_COPING_SUPPRESS` for why the art needs this and a uniform tint cannot do it. */
export function drawFaceCopingSuppress(g: Graphics, r: RectPx, height: number): void {
  const copingH = height * FACE_COPING_FRACTION;
  // Strongest right under the fold, gone by the band's lower edge — so the ramp runs UP the
  // face, from its lower edge to the fold.
  g.rect(0, -height, r.w, copingH)
    .fill(rampFill(linearRamp(), 0, -height + copingH, 0, -height, { color: 0x000000, alpha: FACE_COPING_SUPPRESS }));
}

/**
 * West chamfer catches the key light, east side turns away from it. Both ramped across
 * their width rather than drawn as one flat rect: a single alpha reads as a translucent
 * panel laid over the art, a ramp reads as a surface curving away.
 *
 * Over the FACE and one wall thickness of cap they run at full strength, then fade out
 * over `SIDE_CAP_TAPER_PX` more — see `SIDE_CAP_SOLID_PX`: on a deep north-south run the
 * un-bounded version was a hard-edged grey panel painted down the whole length of the
 * wall's top. An east-west wall's cap is one thickness deep, so this leaves that case
 * unchanged.
 *
 * The length taper is still stepped (`SIDE_REACH_TAPER`), unlike the across-the-width ramp:
 * those three bands are a reach bound, not a gradient, and each one is a separate rect with
 * its own extent — so each gets its own quad, and the ramp inside it is continuous.
 */
export function drawSideBands(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const capTop = blockCapTop(r, height, joins);
  const capDepth = -height - capTop;
  const band = Math.min(SIDE_BAND_PX, r.w * SIDE_BAND_MAX_FRACTION);
  const litEdge = Math.min(LIT_EDGE_PX, r.w * SIDE_BAND_MAX_FRACTION);
  const solid = Math.min(capDepth, SIDE_CAP_SOLID_PX);
  // `[y, height, alpha multiplier]` bands down the block's east/west edges, fold-ward first.
  const lengthBands: Array<readonly [number, number, number]> = [[-height - solid, height + solid, 1]];
  const taperStep = Math.min(capDepth - solid, SIDE_CAP_TAPER_PX) / SIDE_REACH_TAPER.length;
  SIDE_REACH_TAPER.forEach((k, i) => {
    if (taperStep > 0) lengthBands.push([-height - solid - taperStep * (i + 1), taperStep, k]);
  });
  // The east band never reaches zero at its inner edge — it is a SIDE, and a side that fades
  // out entirely stops reading as one. `SIDE_BAND_INNER_SCALE` is where it starts.
  const eastRamp = alphaRamp(SIDE_BAND_INNER_SCALE, 1);
  for (const [y, h, k] of lengthBands) {
    // West: brightest on the outer (west) edge, gone by the chamfer's inner edge.
    g.rect(0, y, litEdge, h)
      .fill(rampFill(linearRamp(), litEdge, y, 0, y, { color: LIT_EDGE_COLOR, alpha: LIT_EDGE_ALPHA * k }));
    // East: weakest at the inner edge, full strength at the block's outer one.
    g.rect(r.w - band, y, band, h)
      .fill(rampFill(eastRamp, r.w - band, y, r.w, y, { color: SIDE_COLOR, alpha: SIDE_ALPHA * k }));
  }
}

/** The cap's own long edges: a narrow dark bevel along their FULL depth, which is what
 *  still separates a north-south run's top from the floor once `drawSideBands`'s band has
 *  stopped. */
export function drawCapEdgeBevel(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const capTop = blockCapTop(r, height, joins);
  const capDepth = -height - capTop;
  if (capDepth <= 0) return; // No cap, no cap edges — see `drawCapDepthGradient`.
  const capEdge = Math.min(CAP_EDGE_PX, r.w * CAP_EDGE_MAX_FRACTION);
  // East edge: darkest at the block's own east side, which is the one turned away from the key
  // light — hence full `CAP_EDGE_ALPHA` here and `CAP_EDGE_WEST_SCALE` of it on the west.
  g.rect(r.w - capEdge, capTop, capEdge, capDepth)
    .fill(rampFill(linearRamp(), r.w - capEdge, capTop, r.w, capTop, { color: 0x000000, alpha: CAP_EDGE_ALPHA }));
  g.rect(0, capTop, capEdge, capDepth)
    .fill(
      rampFill(linearRamp(), capEdge, capTop, 0, capTop, {
        color: 0x000000,
        alpha: CAP_EDGE_ALPHA * CAP_EDGE_WEST_SCALE,
      }),
    );
}

/** The cap/face fold — masked by `joins.south`: no fold where the block's south edge is
 *  buried in a corner (`wallRuns.wallJoins`). */
export function drawCapFold(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const openSouth = unjoinedSpans(r.w, joins.south);
  if (openSouth.length === 0) return;
  for (const [a, b] of openSouth) g.moveTo(a, -height).lineTo(b, -height);
  g.stroke({ color: EDGE_COLOR, width: FOLD_WIDTH, alpha: FOLD_ALPHA });
}

/** Contact crease along the base of the front face. */
export function drawBaseContactCrease(g: Graphics, r: RectPx, height: number): void {
  const aoH = height * BASE_AO_FRACTION;
  g.rect(0, -aoH, r.w, aoH)
    .fill(rampFill(linearRamp(), 0, -aoH, 0, 0, { color: 0x000000, alpha: BASE_AO_MAX }));
}
