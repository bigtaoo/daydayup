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
import { Graphics } from 'pixi.js';
import type { RectPx } from './wallGeometry';
import { blockCapTop, unjoinedSpans, type WallJoins } from './wallRuns';
import {
  BASE_AO_BANDS,
  BASE_AO_FRACTION,
  BASE_AO_MAX,
  CAP_EDGE_ALPHA,
  CAP_EDGE_MAX_FRACTION,
  CAP_EDGE_PX,
  CAP_EDGE_STEPS,
  CAP_EDGE_WEST_SCALE,
  CAP_GRADIENT_BANDS,
  CAP_GRADIENT_MAX,
  CAP_GRADIENT_REACH_PX,
  EDGE_COLOR,
  FACE_COPING_BANDS,
  FACE_COPING_FRACTION,
  FACE_COPING_SUPPRESS,
  FOLD_ALPHA,
  FOLD_WIDTH,
  LIT_EDGE_ALPHA,
  LIT_EDGE_COLOR,
  LIT_EDGE_PX,
  SIDE_ALPHA,
  SIDE_BAND_MAX_FRACTION,
  SIDE_BAND_PX,
  SIDE_CAP_SOLID_PX,
  SIDE_CAP_TAPER_PX,
  SIDE_COLOR,
  SIDE_REACH_TAPER,
  SIDE_STEPS,
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
  const openSouth = unjoinedSpans(r.w, joins.south);
  const capReach = Math.min(capDepth, CAP_GRADIENT_REACH_PX);
  const capStep = capReach / CAP_GRADIENT_BANDS;
  for (let i = 0; i < CAP_GRADIENT_BANDS; i++) {
    const t = (i + 0.5) / CAP_GRADIENT_BANDS;
    for (const [a, b] of openSouth) {
      g.rect(a, -height - capReach + i * capStep, b - a, capStep)
        .fill({ color: 0x000000, alpha: t * CAP_GRADIENT_MAX });
    }
  }
}

/** The face swatch's own coping course, pulled back under the cap's value — see
 *  `FACE_COPING_SUPPRESS` for why the art needs this and a uniform tint cannot do it. */
export function drawFaceCopingSuppress(g: Graphics, r: RectPx, height: number): void {
  const copingH = height * FACE_COPING_FRACTION;
  const copingStep = copingH / FACE_COPING_BANDS;
  for (let i = 0; i < FACE_COPING_BANDS; i++) {
    const t = (i + 0.5) / FACE_COPING_BANDS; // 0 at the fold → 1 at the band's lower edge
    g.rect(0, -height + i * copingStep, r.w, copingStep)
      .fill({ color: 0x000000, alpha: (1 - t) * FACE_COPING_SUPPRESS });
  }
}

/**
 * West chamfer catches the key light, east side turns away from it. Both stepped across
 * their width rather than drawn as one flat rect: a single alpha reads as a translucent
 * panel laid over the art, a ramp reads as a surface curving away.
 *
 * Over the FACE and one wall thickness of cap they run at full strength, then fade out
 * over `SIDE_CAP_TAPER_PX` more — see `SIDE_CAP_SOLID_PX`: on a deep north-south run the
 * un-bounded version was a hard-edged grey panel painted down the whole length of the
 * wall's top. An east-west wall's cap is one thickness deep, so this leaves that case
 * unchanged.
 */
export function drawSideBands(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const capTop = blockCapTop(r, height, joins);
  const capDepth = -height - capTop;
  const band = Math.min(SIDE_BAND_PX, r.w * SIDE_BAND_MAX_FRACTION);
  const litEdge = Math.min(LIT_EDGE_PX, r.w * SIDE_BAND_MAX_FRACTION);
  const chamferStep = litEdge / SIDE_STEPS;
  const sideStep = band / SIDE_STEPS;
  const solid = Math.min(capDepth, SIDE_CAP_SOLID_PX);
  // `[y, height, alpha multiplier]` bands down the block's east/west edges, fold-ward first.
  const lengthBands: Array<readonly [number, number, number]> = [[-height - solid, height + solid, 1]];
  const taperStep = Math.min(capDepth - solid, SIDE_CAP_TAPER_PX) / SIDE_REACH_TAPER.length;
  SIDE_REACH_TAPER.forEach((k, i) => {
    if (taperStep > 0) lengthBands.push([-height - solid - taperStep * (i + 1), taperStep, k]);
  });
  for (let i = 0; i < SIDE_STEPS; i++) {
    const t = (i + 0.5) / SIDE_STEPS; // 0 at the outer edge → 1 at the inner one
    for (const [y, h, k] of lengthBands) {
      g.rect(0 + i * chamferStep, y, chamferStep, h)
        .fill({ color: LIT_EDGE_COLOR, alpha: (1 - t) * LIT_EDGE_ALPHA * k });
      g.rect(r.w - band + i * sideStep, y, sideStep, h)
        .fill({ color: SIDE_COLOR, alpha: (0.45 + 0.55 * t) * SIDE_ALPHA * k });
    }
  }
}

/** The cap's own long edges: a narrow dark bevel along their FULL depth, which is what
 *  still separates a north-south run's top from the floor once `drawSideBands`'s band has
 *  stopped. */
export function drawCapEdgeBevel(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const capTop = blockCapTop(r, height, joins);
  const capDepth = -height - capTop;
  const capEdge = Math.min(CAP_EDGE_PX, r.w * CAP_EDGE_MAX_FRACTION);
  const capEdgeStep = capEdge / CAP_EDGE_STEPS;
  for (let i = 0; i < CAP_EDGE_STEPS; i++) {
    const t = (i + 0.5) / CAP_EDGE_STEPS; // 0 at the west edge → 1 at the east one
    g.rect(r.w - capEdge + i * capEdgeStep, capTop, capEdgeStep, capDepth)
      .fill({ color: 0x000000, alpha: t * CAP_EDGE_ALPHA });
    g.rect(i * capEdgeStep, capTop, capEdgeStep, capDepth)
      .fill({ color: 0x000000, alpha: (1 - t) * CAP_EDGE_ALPHA * CAP_EDGE_WEST_SCALE });
  }
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
  const aoStep = aoH / BASE_AO_BANDS;
  for (let i = 0; i < BASE_AO_BANDS; i++) {
    const t = (i + 0.5) / BASE_AO_BANDS;
    g.rect(0, -aoH + i * aoStep, r.w, aoStep).fill({ color: 0x000000, alpha: t * BASE_AO_MAX });
  }
}
