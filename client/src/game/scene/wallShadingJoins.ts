// Split out of wallRender.ts (2026-08-20, 500-line convention — CLAUDE.md form ①,
// "independent function modules"): the shading cues that only exist BECAUSE of a specific
// neighbouring wall mass — the re-entrant corner a tucked run makes with the wall it runs
// into, and the crease a join casts on this wall's own face. Sibling of
// `wallShadingSurfaces.ts` (this block's own surface cues, no neighbour involved); both are
// called from `wallRender.drawBlockShading` in the same order the `wallTone.ts` numbers were
// measured against, onto one shared Graphics. `clampSpan` lives in `wallGeometry.ts` rather
// than in `wallRender.ts` so both this file and that one can import it without either
// depending on the other.
//
// Every crease here is one quad sampling a shared ramp texture — see
// `wallShadingSurfaces.ts`'s header and `render/shadeRamp.ts` for the whole argument. The
// clipping case that made `rampFill` anchor its ramp to a SEGMENT rather than to the filled
// shape is `drawCornerAO`'s, right at the bottom of this file.
import { Graphics } from 'pixi.js';
import { alphaRamp, linearRamp, rampFill } from '../../render/shadeRamp';
import { clampSpan, type RectPx } from './wallGeometry';
import { blockCapTop, type WallJoins } from './wallRuns';
import {
  CORNER_AO_ALPHA,
  CORNER_AO_PX,
  CORNER_AO_WEST_SCALE,
  TUCK_CAP_ALPHA,
  TUCK_CAP_PX,
  TUCK_FACE_ALPHA,
  TUCK_FACE_SPILL_PX,
  TUCK_FACE_TOP_SCALE,
} from './wallTone';

/**
 * The re-entrant corner a tucked run makes with the wall it runs into: an inside corner on
 * the run's own cap, ramping north into the wall. See `TUCK_CAP_PX` — this is the
 * *"相交的部分进行立体化处理"* half, and without it the clipped cap just stops dead at the brick.
 */
export function drawTuckCapCrease(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  if (!joins.tuckNorth) return;
  const capTop = blockCapTop(r, height, joins);
  const capDepth = -height - capTop;
  const tuckReach = Math.min(capDepth, TUCK_CAP_PX);
  // Darkest against the wall (the crease's north end), gone by its south end.
  g.rect(0, capTop, r.w, tuckReach)
    .fill(rampFill(linearRamp(), 0, capTop + tuckReach, 0, capTop, { color: 0x000000, alpha: TUCK_CAP_ALPHA }));
}

/**
 * The other half of that corner, on THIS block's CROWN, where a tucked run arrives just
 * under it. Only the crown is left to shade — the run's own cap covers every brick course
 * below it — and the crown is also the brightest band on the wall, so this is the one band
 * where the alpha is visible at all. Darkest at the crown's underside, where the contact is.
 */
export function drawTuckFaceCrease(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const crownH = height * joins.crownFraction;
  // Never fades to nothing at the wall's top: the contact is close enough that the whole crown
  // is in its shade, `TUCK_FACE_TOP_SCALE` of it at the furthest point.
  const ramp = alphaRamp(TUCK_FACE_TOP_SCALE, 1);
  for (const [a, b] of joins.tuckedSouth) {
    const core = clampSpan(a - TUCK_FACE_SPILL_PX * 0.5, b - a + TUCK_FACE_SPILL_PX * 1.5, r.w);
    if (!core) continue;
    g.rect(core[0], -height, core[1], crownH)
      .fill(rampFill(ramp, 0, -height, 0, -height + crownH, { color: 0x000000, alpha: TUCK_FACE_ALPHA }));
  }
}

/**
 * The crease a corner casts on THIS wall's face, where another run stands in front of it.
 * Only the parts of the face flanking a join are exposed at all (the join itself is behind
 * that run's cap), so this is drawn outward from each interval's ends — see `CORNER_AO_PX`.
 *
 * **The `clampSpan` here is why `rampFill` takes a segment.** Like the east band, this cue is
 * INSET, never extruded, so a join sitting at the very end of a wall cannot paint over the
 * next block along the run — and a clip therefore makes the drawn rect NARROWER than the
 * crease. The ramp still has to run over the crease's full `CORNER_AO_PX`, with the clip
 * cutting its outer end off; a ramp normalised to the rect would instead squeeze the whole
 * falloff into whatever slice survived, so a crease clipped to 2 px would show the same full
 * contact-to-nothing gradient as an unclipped 13 px one.
 */
export function drawCornerAO(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  for (const [a, b] of joins.south) {
    // Strongest at the contact, gone `CORNER_AO_PX` out from it, on both sides of the join.
    const east = clampSpan(b, CORNER_AO_PX, r.w);
    if (east) {
      g.rect(east[0], -height, east[1], height)
        .fill(rampFill(linearRamp(), b + CORNER_AO_PX, -height, b, -height, { color: 0x000000, alpha: CORNER_AO_ALPHA }));
    }
    const west = clampSpan(a - CORNER_AO_PX, CORNER_AO_PX, r.w);
    if (west) {
      g.rect(west[0], -height, west[1], height).fill(
        rampFill(linearRamp(), a - CORNER_AO_PX, -height, a, -height, {
          color: 0x000000,
          alpha: CORNER_AO_ALPHA * CORNER_AO_WEST_SCALE,
        }),
      );
    }
  }
}
