// New 2026-08-27: which parts of a wall block's EAST/WEST sides look out onto nothing at
// all — no floor, no other stone — and how much room there is out there. Pure geometry,
// Pixi-free, sibling to `wallGeometry.ts` (how tall a wall stands) and `wallRuns.ts` (which
// footprints are one mass); `wallVoidReturn.ts` owns the drawing that follows from it.
//
// **WHY.** `screen.y = gy - z` has no horizontal component, so a block's east and west
// sides project to exactly zero width — the art simply stops at the footprint's edge.
// Wherever the next thing along is another room's floor or more stone that is correct: the
// neighbour carries the picture on. Where it is the VOID it is not, and the difference is
// measurable rather than a matter of taste. Beside `arena_launch`'s empty slot r1c5, a
// horizontal luma scan across the boundary reads 53 (cap) -> 26 (the cap's own dark bevel)
// -> 6 (the backdrop) in three pixels: the stone does not end, it is cut off. A void to the
// SOUTH never reads that way, because the block's FACE — a whole wall height of lit
// elevation — stands between the floor and it. That asymmetry is the entire finding
// ROADMAP's camera list recorded as "the twelve empty cells are holes with no rim", and it
// is a property of the PROJECTION, not of those twelve cells: the map's outer silhouette
// has it too, and so does every PvE floor's.
//
// This file answers the precondition — where does a wall end at nothing — and answers it in
// SPANS rather than as a boolean, because a run's side is routinely part void and part
// neighbour. `arena_launch`'s east-west runs meet the empty slots END-ON: 32 px of a 64 px
// side is void and the rest abuts stone (13 such spans on that map, swept in
// `arenaWallCoverage.test.ts`). A boolean would either paint a return over that neighbour or
// drop the case, and dropping it drops exactly the "end head" the finding is about.
import type { RectPx } from './wallGeometry';
import { unjoinedSpans } from './wallRuns';

/**
 * One run of a block's side that faces the void.
 *
 * `from`/`to` are FOOTPRINT-local y (`0` at the rect's north edge, `rect.h` at its south) —
 * not the block's own art-local y, which `WallJoins`' spans use. This is a fact about the
 * footprint; the art's y depends on the height and on whatever clip (`blockCapTop`) applies,
 * so `wallVoidReturn.ts` does that mapping at draw time where both are in hand.
 */
export interface VoidSpan {
  from: number;
  to: number;
  /**
   * World px of empty space beyond the edge over this span, or `Infinity` where nothing
   * bounds it at all (the map's outer silhouette, where the void runs off the world).
   *
   * Carried rather than left to the renderer to re-derive because it is the bound on how far
   * a return may reach: two walls facing each other across a gap may each take half of it and
   * no more, or they paint over each other's stone. That is not hypothetical headroom —
   * `ember_l1` floor 2's narrowest void is 32 px, exactly twice `VOID_RETURN_PX`, so today's
   * content sits ON the limit with none to spare and the next authored room could cross it
   * silently. The sweeps assert both halves: that no shipped gap forces the clamp, and that
   * the clamp is there when one does.
   */
  gap: number;
}

/** The spans of a block's east and west sides that face the void. */
export interface VoidEdges {
  east: readonly VoidSpan[];
  west: readonly VoidSpan[];
}

/** No free edge at all — the default for callers with no floor model (tests, flat modes). */
export const NO_VOID_EDGES: VoidEdges = { east: [], west: [] };

/**
 * How far past the block's own edge the question "is anything there?" is asked, in world px.
 *
 * Any strictly positive value works and the value does not matter: content is authored on a
 * 32 px grid and converted through fixed point, so a neighbour either shares the edge exactly
 * (to conversion noise) or is a whole cell away. Being strictly positive is what makes the
 * block exclude ITSELF without a reference comparison, which in turn lets the caller pass one
 * flat list of every wall rect on the floor.
 */
const PROBE_PX = 1;

/**
 * Which parts of `rect`'s east/west sides look out onto nothing, and how far out that goes.
 *
 * `floors` is what the ground layer actually PAINTS (`groundLayer.floorRegionsPx`), not the
 * room rects — the two differ in the fallback case, where a mode with no usable room model
 * paints the whole world box and therefore has no interior void at all. Feeding room rects
 * there would report void across a floor the player is standing on. `stone` is every wall run
 * on the floor; passing the whole list including `rect` itself is fine and intended.
 */
export function voidEdges(
  rect: RectPx,
  stone: readonly RectPx[],
  floors: readonly RectPx[],
): VoidEdges {
  return {
    east: freeSpans(rect, 'east', stone, floors),
    west: freeSpans(rect, 'west', stone, floors),
  };
}

/** The parts of `rect`'s y extent at which nothing covers the ground just off `side`. */
function freeSpans(
  rect: RectPx,
  side: 'east' | 'west',
  stone: readonly RectPx[],
  floors: readonly RectPx[],
): VoidSpan[] {
  const edge = side === 'east' ? rect.x + rect.w : rect.x;
  const probe = side === 'east' ? edge + PROBE_PX : edge - PROBE_PX;
  const covered: Array<readonly [number, number]> = [];
  for (const list of [floors, stone]) {
    for (const o of list) {
      if (probe < o.x || probe > o.x + o.w) continue;
      const a = Math.max(rect.y, o.y);
      const b = Math.min(rect.y + rect.h, o.y + o.h);
      if (b > a) covered.push([a - rect.y, b - rect.y]);
    }
  }
  // `unjoinedSpans` walks its input in order and carries the furthest end seen, so it
  // tolerates overlap but not disorder.
  covered.sort((p, q) => p[0] - q[0]);
  return unjoinedSpans(rect.h, covered).map(([from, to]) => ({
    from,
    to,
    gap: gapAt(rect, side, edge, (from + to) / 2, stone, floors),
  }));
}

/**
 * Distance from `edge` to the nearest solid or floor directly off `side`, sampled at
 * footprint-local y `t`.
 *
 * One sample rather than a scan along the span because a span is by construction uniform in
 * what covers it: `freeSpans` cut it at every y where coverage changes, so its midpoint sees
 * the same neighbours its ends do. `Infinity` when nothing is out there.
 */
function gapAt(
  rect: RectPx,
  side: 'east' | 'west',
  edge: number,
  t: number,
  stone: readonly RectPx[],
  floors: readonly RectPx[],
): number {
  const y = rect.y + t;
  let nearest = Infinity;
  for (const list of [floors, stone]) {
    for (const o of list) {
      if (y < o.y || y > o.y + o.h) continue;
      const d = side === 'east' ? o.x - edge : edge - (o.x + o.w);
      if (d > 0) nearest = Math.min(nearest, d);
    }
  }
  return nearest;
}
