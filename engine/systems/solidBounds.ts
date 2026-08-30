/**
 * Where a static solid blocks an actor — the ONE definition (design/18-test-strategy.md, G3).
 *
 * ## Why this file exists
 *
 * `MovementSystem.resolveWalls`/`resolveObstacles` and `geom.clampToWalkable` used to implement
 * this independently, line for line: the brim-widened broadphase, the brimmed top edge, the
 * closest-point push, the inside-the-rect `Math.min(pushLeft, pushRight, pushTop, pushBottom)`
 * tie-break, and the concentric-pillar `+x` nudge. `geom.ts`'s comment even said so — *"Same
 * push-out shape as MovementSystem's resolveWalls/resolveObstacles"* — which is an admission,
 * not a call.
 *
 * That duplication was two thirds of every `WALL_NORTH_BRIM` and `freeStanding` read site in
 * the engine, and it had already drifted once in the direction that matters: a pickup could
 * settle inside the brimmed band an actor may never stand in, which shipped as *"角色根本无法
 * 拾取掉落的物品"* and was fixed by copying the rule across a second time rather than sharing it.
 * The third copy of the same expression currently lives in `launchArena.test.ts`'s flood fill.
 *
 * ## The contract this file owns
 *
 * Every rule below is a DETERMINISM contract, not an implementation detail — two clients that
 * resolve the same overlap differently desync, so the tie-breaks are as load-bearing as the
 * arithmetic:
 *
 *   - the brim applies to the NORTH edge of a `freeStanding` rect and to nothing else;
 *   - a centre outside the rect pushes along the normal to the closest point (`isqrt`, never
 *     `Math.sqrt` — design/06);
 *   - a centre INSIDE the rect pushes out along the single nearest edge, ties resolving in a
 *     fixed right → left → bottom → top order;
 *   - a centre exactly concentric with a pillar nudges `+x` by the full clearance.
 *
 * ## Why the cursor
 *
 * Both callers mutate the position as they iterate, so wall N+1 is tested against the position
 * wall N pushed the actor to. `Point` is a caller-owned cursor rather than a returned object so
 * that behaviour is preserved exactly, with one allocation per resolve pass instead of one per
 * wall — and without a module-scope scratch buffer, which this repo has a standing rule against
 * introducing on reasoning alone.
 */
import { isqrt, type Fp } from '../math/fixed';
import { WALL_NORTH_BRIM } from '../config';
import type { AABB, Obstacle } from '../state/entities';

/** A mutable position cursor, owned by the caller and threaded through a resolve pass. */
export interface Point {
  x: Fp;
  y: Fp;
}

/** The four edges of the rect an actor is actually kept out of. */
export interface Bounds {
  left: Fp;
  top: Fp;
  right: Fp;
  bottom: Fp;
}

/**
 * The wall's COLLISION rect: its authored rect, with the north edge pulled out by
 * `WALL_NORTH_BRIM` when the block is free-standing (v47).
 *
 * Such a block's art rises a full wall height north of `w.y`, so without the brim an actor
 * standing there is drawn entirely inside stone. Inflating the EDGE rather than special-casing
 * a north approach keeps the whole thing one rect-vs-circle test, which is why sliding along
 * the east face past its north end, and being pushed out of an overlap, need no extra cases.
 *
 * Perimeter rings and kerbs are never `freeStanding` and so keep exact-footprint collision —
 * see `WALL_NORTH_BRIM`'s own "Only free-standing blocks" note for why that must stay true.
 */
export function blockingRect(w: AABB): Bounds {
  return {
    left: w.x,
    top: (w.freeStanding ? w.y - WALL_NORTH_BRIM : w.y) as Fp,
    right: (w.x + w.w) as Fp,
    bottom: (w.y + w.h) as Fp,
  };
}

/**
 * The radius a broadphase query must use to see every wall an actor of clearance `r` can be
 * blocked by.
 *
 * The brim is added to the QUERY, never to the stored rects: the spatial index is built over
 * authored footprints and is shared with the projectile queries, which must keep hitting the
 * real stone. Over-querying costs one rejected narrowphase test; under-querying silently drops
 * the push, which is a desync.
 */
export function queryRadiusFor(r: Fp): Fp {
  return (r + WALL_NORTH_BRIM) as Fp;
}

/**
 * Push `p` out of one wall if its `r` circle overlaps that wall's blocking rect. Mutates `p`;
 * leaves it untouched when clear.
 */
export function pushOutOfWall(p: Point, r: Fp, w: AABB): void {
  const b = blockingRect(w);
  const closestX = Math.max(b.left, Math.min(p.x, b.right)) as Fp;
  const closestY = Math.max(b.top, Math.min(p.y, b.bottom)) as Fp;
  const dx = p.x - closestX;
  const dy = p.y - closestY;
  const distSq = dx * dx + dy * dy;
  if (distSq > 0) {
    if (distSq >= r * r) return; // no overlap
    const dist = isqrt(distSq);
    const pen = r - dist;
    // (dx,dy)/dist is the unit outward normal; x pen gives the fp displacement.
    p.x = (p.x + Math.trunc((dx * pen) / dist)) as Fp;
    p.y = (p.y + Math.trunc((dy * pen) / dist)) as Fp;
    return;
  }
  // Centre is inside the rect (fully engulfed): axis-separation — out along whichever single
  // edge reaches open air soonest. The comparison ORDER is the tie-break, and it is a
  // determinism contract: every client must pick the same edge for an equidistant centre.
  const pushLeft = (p.x - b.left) as number;
  const pushRight = (b.right - p.x) as number;
  const pushTop = (p.y - b.top) as number;
  const pushBottom = (b.bottom - p.y) as number;
  const min = Math.min(pushLeft, pushRight, pushTop, pushBottom);
  if (min === pushRight) p.x = (b.right + r) as Fp;
  else if (min === pushLeft) p.x = (b.left - r) as Fp;
  else if (min === pushBottom) p.y = (b.bottom + r) as Fp;
  else p.y = (b.top - r) as Fp;
}

/**
 * Push `p` out of one round solid (pillar) if its `r` circle overlaps. Mutates `p`.
 *
 * Obstacles are static, so the mover absorbs the full push — design/07's half-each split is for
 * actor-vs-actor only.
 */
export function pushOutOfObstacle(p: Point, r: Fp, o: Obstacle): void {
  const dx = p.x - o.gx;
  const dy = p.y - o.gy;
  const minDist = r + o.radius;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist) return; // no overlap
  const dist = isqrt(distSq);
  if (dist === 0) {
    // Exactly concentric — no defined push direction. Nudge +x by the full clearance so the
    // choice is identical on every client.
    p.x = (p.x + minDist) as Fp;
    return;
  }
  const pen = minDist - dist;
  p.x = (p.x + Math.trunc((dx * pen) / dist)) as Fp;
  p.y = (p.y + Math.trunc((dy * pen) / dist)) as Fp;
}
