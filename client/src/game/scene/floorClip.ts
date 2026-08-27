// New 2026-08-27 (CLAUDE.md form (1) — independent functions over rects and points, no shared
// state): fill a floor blob so that it CANNOT paint outside the room that seeded it.
//
// **WHY.** `floorRender.drawFloorMottle` centres its blobs inside a room and draws them up to 1.8
// tiles across, so a 448x384 room's dark pass measured 838x446 px — 460 world px of spill, which at
// the arena's shipped zoom of 4.29 is ~1970 SCREEN px, wider than the viewport itself. Standing in
// one room of `arena_launch`, four dark and four light halves were therefore legitimately on screen,
// and the three neighbours painted 1.31 and 1.91 extra viewports of pure spill. Measured on a real
// GPU (`perf/README.md`'s sixth measurement): hiding just those six pieces took the ground layer
// from 4.07 to 3.32 ms, i.e. **45% of the floor's cost was rooms the camera is not in.**
//
// `groundCulling.ts` cannot fix that, and its header says why: the cull is an exact intersection
// against the rect a piece really PAINTS, and shrinking that rect would pop blobs off at the screen
// edge. The cost is the painting, not the keeping. So the fix is upstream, here — a blob is clipped
// as it is built, which both stops it reaching the neighbour's screen and shrinks the rect
// `groundLayer.mountPainted` reads back, so the existing cull then drops the neighbour pieces on its
// own and stays exact while doing it.
//
// **THE CUT HAS TO LAND SOMEWHERE, and that is the whole design question.** Truncating a smooth
// field leaves a step of the field's own local value, and a straight step on a floor is exactly what
// `floorRender`'s header rejected the per-tile tint for. Two measurements decide where it may land
// (both swept over shipped content by `floorClipCoverage.test.ts`, both reproducible offline):
//
//  1. **A room rect includes its own perimeter wall, exactly one grid cell deep.** Sampled 2 / 16 /
//     30 px inside every room edge of `arena_launch` and all five PvE floors: **100% of it is wall
//     footprint or authored passage, 0% bare floor**, and at 34 px in it is floor. So anything cut
//     away inside `PX_PER_GRID` of a room's edge is cut away under stone. (The one exception is the
//     wall-less `?arenaDemo=1` fixture `landing_basic`, which authors no solids at all.)
//  2. **The passages are the exception, and they are 8-17% of that band.** A doorway is floor on
//     both sides by definition, so no depth of clip is hidden there.
//
// Hence the shape: a HARD clip would be free at (1) and would leave a **29.98 luma** straight edge
// across a doorway at (2), median 7.24, on a floor whose base is 25.9 — measured, not feared. So the
// clip RAMPS instead (`floorRender.CLIP_FEATHER_PX`). Each of a blob's five nested bands is clipped
// at its own inset, faintest band at the room's edge and strongest a full grid cell inside, with a
// hashed sub-band offset per blob so two blobs never cut on the same line. The largest step any one
// cut can make is then one band's own alpha — which is the step that band's own rim already makes in
// the shipped art, so the clip cannot introduce an edge the blob did not already have. Re-measured
// with the ramp in place: **2.59 luma** worst, 0.48 median, against a 4.90 bound derived from the
// mottle itself (`floorClipCoverage.test.ts` gates both).
//
// What it bought, on a real GPU (three counterbalanced sessions, twin controls, `perf/README.md`'s
// seventh measurement): **0.53-0.93 ms** of a ~4.4 ms arena frame, visible ground pieces 13 -> 7,
// and 19.9% fewer floats on the layer. And in a live frame the clipped doorway is SMOOTHER than the
// unclipped one — worst per-pixel step across all 74 passage floors 36.16 -> 18.51 — because what
// used to be roughest there was a neighbour room's rubble speck, which the clip drops whole rather
// than cutting.
//
// Nothing here changes what a room's floor looks like INSIDE its own walls: the clip only removes
// geometry painted beyond the room, which on a PvE floor was painted over the backdrop void (the
// floor stops at the rooms — `groundLayer.floorRegionsPx`) and in the arena over a neighbour that
// paints its own.
import type { Graphics } from 'pixi.js';
import type { RectPx } from './wallGeometry';

/** The fill a blob is painted with — `Graphics.fill`'s object form, narrowed to what this file uses. */
export interface BlobFill {
  color: number;
  alpha: number;
}

/** `r` shrunk by `d` on all four sides, never past its own centre. */
export function insetRect(r: RectPx, d: number): RectPx {
  const dx = Math.min(d, r.w / 2);
  const dy = Math.min(d, r.h / 2);
  return { x: r.x + dx, y: r.y + dy, w: r.w - 2 * dx, h: r.h - 2 * dy };
}

/**
 * Points around an ellipse, at the density Pixi's own shape builder would have used.
 *
 * `Math.ceil(2.3 * Math.sqrt(rx + ry)) * 8` is `buildCircle`'s formula verbatim (pixi.js v8,
 * `scene/graphics/shared/buildCommands/buildCircle.mjs`). Matching it rather than picking a number
 * is what keeps a clipped blob's silhouette and its float cost the same as an unclipped one's — a
 * coarser polygon would show its own facets on a 460 px blob, and a finer one would pay for
 * smoothness the renderer never asked for.
 */
function ellipsePolygon(cx: number, cy: number, rx: number, ry: number): number[] {
  const n = Math.ceil(2.3 * Math.sqrt(rx + ry)) * 8;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  return pts;
}

/** Keep the part of `pts` where `dist` is non-negative (Sutherland-Hodgman, one half-plane). */
function clipHalfPlane(pts: readonly number[], dist: (x: number, y: number) => number): number[] {
  const out: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 2) {
    const ax = pts[i]!;
    const ay = pts[i + 1]!;
    const bx = pts[(i + 2) % n]!;
    const by = pts[(i + 3) % n]!;
    const da = dist(ax, ay);
    const db = dist(bx, by);
    if (da >= 0) out.push(ax, ay);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

/**
 * `pts` clipped to `clip`. Convex in, convex out — four half-planes, no polygon library.
 *
 * Degenerate `clip` needs no special case, which was checked rather than assumed: on a room narrower
 * than twice `CLIP_FEATHER_PX` (none ship — the smallest is 288 px, nine grid cells) `insetRect`
 * clamps an inner band's clip to zero width, and this returns four coincident points, i.e. a
 * zero-area polygon that draws nothing. An early return for it was written, measured, and REMOVED:
 * it changed no output, and `0 / (da - db)` cannot go 0/0 here because `clipHalfPlane` only divides
 * when the two distances have different signs. See `floorClipCoverage.test.ts`'s small-room case,
 * which pins the finite, inside-the-room result.
 */
export function clipPolygonToRect(pts: readonly number[], clip: RectPx): number[] {
  const x1 = clip.x + clip.w;
  const y1 = clip.y + clip.h;
  let out = clipHalfPlane(pts, (x) => x - clip.x);
  out = clipHalfPlane(out, (x) => x1 - x);
  out = clipHalfPlane(out, (_x, y) => y - clip.y);
  return clipHalfPlane(out, (_x, y) => y1 - y);
}

/** Whether the box `[x0,x1] x [y0,y1]` lies wholly inside `clip`. */
export function boxInsideRect(clip: RectPx, x0: number, y0: number, x1: number, y1: number): boolean {
  return x0 >= clip.x && x1 <= clip.x + clip.w && y0 >= clip.y && y1 <= clip.y + clip.h;
}

/**
 * Fill an ellipse, but never outside `clip`.
 *
 * Three cases, and the first is the common one: a blob that already fits is drawn as an `ellipse`
 * exactly as before, so the interior of a large room is geometrically unchanged to the float. A blob
 * that misses `clip` entirely draws nothing — that is the spill this file exists to remove. Only a
 * blob that straddles the boundary becomes a polygon.
 */
export function fillClippedEllipse(
  g: Graphics,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  clip: RectPx,
  fill: BlobFill,
): void {
  if (boxInsideRect(clip, cx - rx, cy - ry, cx + rx, cy + ry)) {
    g.ellipse(cx, cy, rx, ry).fill(fill);
    return;
  }
  if (cx - rx >= clip.x + clip.w || cx + rx <= clip.x || cy - ry >= clip.y + clip.h || cy + ry <= clip.y) return;
  const poly = clipPolygonToRect(ellipsePolygon(cx, cy, rx, ry), clip);
  // Fewer than three points is a degenerate sliver with no area — a blob tangent to the boundary.
  if (poly.length >= 6) g.poly(poly).fill(fill);
}
