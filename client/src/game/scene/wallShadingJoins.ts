// Split out of wallRender.ts (2026-08-20, 500-line convention — CLAUDE.md form ①,
// "independent function modules"): the shading cues that only exist BECAUSE of a specific
// neighbouring wall mass — the re-entrant corner a tucked run makes with the wall it runs
// into, and the crease a join casts on this wall's own face. Sibling of
// `wallShadingSurfaces.ts` (this block's own surface cues, no neighbour involved); both are
// called from `wallRender.drawBlockShading` in the same order the `wallTone.ts` numbers were
// measured against, onto one shared Graphics. `clampSpan` lives in `wallGeometry.ts` rather
// than in `wallRender.ts` so both this file and that one can import it without either
// depending on the other.
import { Graphics } from 'pixi.js';
import { clampSpan, type RectPx } from './wallGeometry';
import { blockCapTop, type WallJoins } from './wallRuns';
import {
  CORNER_AO_ALPHA,
  CORNER_AO_BANDS,
  CORNER_AO_PX,
  CORNER_AO_WEST_SCALE,
  TUCK_CAP_ALPHA,
  TUCK_CAP_BANDS,
  TUCK_CAP_PX,
  TUCK_FACE_ALPHA,
  TUCK_FACE_BANDS,
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
  const tuckStep = tuckReach / TUCK_CAP_BANDS;
  for (let i = 0; i < TUCK_CAP_BANDS; i++) {
    const t = (i + 0.5) / TUCK_CAP_BANDS; // 0 at the wall → 1 at the crease's south end
    g.rect(0, capTop + i * tuckStep, r.w, tuckStep)
      .fill({ color: 0x000000, alpha: (1 - t) * TUCK_CAP_ALPHA });
  }
}

/**
 * The other half of that corner, on THIS block's CROWN, where a tucked run arrives just
 * under it. Only the crown is left to shade — the run's own cap covers every brick course
 * below it — and the crown is also the brightest band on the wall, so this is the one band
 * where the alpha is visible at all. Darkest at the crown's underside, where the contact is.
 */
export function drawTuckFaceCrease(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const crownH = height * joins.crownFraction;
  const crownStep = crownH / TUCK_FACE_BANDS;
  for (const [a, b] of joins.tuckedSouth) {
    for (let i = 0; i < TUCK_FACE_BANDS; i++) {
      const t = (i + 0.5) / TUCK_FACE_BANDS; // 0 at the wall's top → 1 at the crown's underside
      const alpha = (TUCK_FACE_TOP_SCALE + (1 - TUCK_FACE_TOP_SCALE) * t) * TUCK_FACE_ALPHA;
      const core = clampSpan(a - TUCK_FACE_SPILL_PX * 0.5, b - a + TUCK_FACE_SPILL_PX * 1.5, r.w);
      if (core) {
        g.rect(core[0], -height + i * crownStep, core[1], crownStep)
          .fill({ color: 0x000000, alpha });
      }
    }
  }
}

/**
 * The crease a corner casts on THIS wall's face, where another run stands in front of it.
 * Only the parts of the face flanking a join are exposed at all (the join itself is behind
 * that run's cap), so this is drawn outward from each interval's ends — see `CORNER_AO_PX`.
 */
export function drawCornerAO(g: Graphics, r: RectPx, height: number, joins: WallJoins): void {
  const cornerStep = CORNER_AO_PX / CORNER_AO_BANDS;
  for (const [a, b] of joins.south) {
    for (let i = 0; i < CORNER_AO_BANDS; i++) {
      const t = (i + 0.5) / CORNER_AO_BANDS; // 0 at the contact → 1 at the crease's outer end
      const alpha = (1 - t) * CORNER_AO_ALPHA;
      // Clamped to the block's own width: like the east band, this is INSET, never extruded, so
      // a join sitting at the very end of a wall cannot paint over the next block along the run.
      const east = clampSpan(b + i * cornerStep, cornerStep, r.w);
      if (east) g.rect(east[0], -height, east[1], height).fill({ color: 0x000000, alpha });
      const west = clampSpan(a - (i + 1) * cornerStep, cornerStep, r.w);
      if (west) {
        g.rect(west[0], -height, west[1], height)
          .fill({ color: 0x000000, alpha: alpha * CORNER_AO_WEST_SCALE });
      }
    }
  }
}
