// New 2026-08-19 (volume pass): merge the engine's wall AABBs into the RUNS they visually
// form, before any of them is drawn as a block. Pure geometry, Pixi-free, sibling to
// `wallGeometry.ts` (which decides how tall a wall stands) and `wallRender.ts` (which draws
// one).
//
// WHY. Measured in a live frame: a horizontal luminance scan across what looks like one thick
// north-south wall in `ember_l1_gallery` crosses TWO 32 px segments — 216..268 and 268..320 —
// each with its own lit west edge (luma 43 and 45) and its own dark east band (luma 4-6). The
// cause is content, not rendering: adjacent rooms each author their own perimeter wall, so the
// boundary between two rooms is two parallel walls one against the other (`[184,8,4,27]` and
// `[188,8,4,27]` in grid units, and four more pairs on that floor). Drawing each as an
// independent extruded block puts a bright/dark seam down the middle of a single stone mass,
// so a thick wall reads as two thin slabs standing back to back — one of the reasons the walls
// still looked like a printed ribbon after they were standing.
//
// Render-only: `s.walls` itself is untouched, so collision is unaffected. The engine is right
// to keep two rects (they belong to two different rooms); it is the drawing that has to see
// one mass.
import type { RectPx } from './wallGeometry';
import type { WallTier } from './wallGeometry';

/** A wall about to be drawn: its footprint and the tier that sets its height. */
export interface WallRun {
  rect: RectPx;
  tier: WallTier;
}

/** Slack (world px) for "these two edges are the same edge" / "these two rects touch". A wall
 *  is authored on a grid and converted through fixed point, so sub-pixel differences are
 *  conversion noise; anything larger is a real gap that must stay a gap. */
const JOIN_TOLERANCE = 0.75;

const near = (a: number, b: number): boolean => Math.abs(a - b) <= JOIN_TOLERANCE;

/**
 * The union of `a` and `b` if the two form an exact rectangle, else null.
 *
 * Exact means: they share a full edge — identical y and height with x ranges that touch or
 * overlap, or identical x and width with y ranges that touch or overlap. An L, a T or a
 * partial overlap all return null, because their union is not a rectangle and drawing it as
 * one would invent stone where the content has none.
 */
export function joinRects(a: RectPx, b: RectPx): RectPx | null {
  if (near(a.y, b.y) && near(a.h, b.h)) {
    const touch = a.x <= b.x + b.w + JOIN_TOLERANCE && b.x <= a.x + a.w + JOIN_TOLERANCE;
    if (!touch) return null;
    const x = Math.min(a.x, b.x);
    const right = Math.max(a.x + a.w, b.x + b.w);
    return { x, y: Math.min(a.y, b.y), w: right - x, h: Math.max(a.h, b.h) };
  }
  if (near(a.x, b.x) && near(a.w, b.w)) {
    const touch = a.y <= b.y + b.h + JOIN_TOLERANCE && b.y <= a.y + a.h + JOIN_TOLERANCE;
    if (!touch) return null;
    const y = Math.min(a.y, b.y);
    const bottom = Math.max(a.y + a.h, b.y + b.h);
    return { x: Math.min(a.x, b.x), y, w: Math.max(a.w, b.w), h: bottom - y };
  }
  return null;
}

/**
 * Merge every mergeable pair, repeatedly, until nothing more merges.
 *
 * **Only same-tier walls are ever merged**, and that restriction is load-bearing rather than
 * conservatism: a room's own south boundary is a low kerb (`WALL_H_KERB`) precisely so it
 * cannot stand between the camera and the player it frames, while the room on the far side of
 * that same boundary sees a full-height perimeter wall. Those two are stacked adjacent rects
 * of DIFFERENT tiers; merging them would give the pair one height and reintroduce exactly the
 * bug the kerb exists to prevent. Same-tier merging is the only kind that is purely visual.
 *
 * O(n²) per pass over a couple of dozen rects, run once per room build.
 */
export function mergeWallRuns(runs: readonly WallRun[]): WallRun[] {
  const out = runs.map((r) => ({ rect: { ...r.rect }, tier: r.tier }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        if (a.tier !== b.tier) continue;
        const union = joinRects(a.rect, b.rect);
        if (!union) continue;
        a.rect = union;
        out.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return out;
}
