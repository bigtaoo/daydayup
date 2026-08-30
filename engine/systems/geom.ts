/**
 * Integer geometry helpers shared by the collision-touching systems. All compares
 * are squared-distance so nothing calls isqrt/Math.sqrt (design/06 banned list).
 * Fp arithmetic on plain `+`/`-`/`*` is fine here: we only compare, never store.
 */
import type { Fp } from '../math/fixed';
import { pushOutOfObstacle, pushOutOfWall, queryRadiusFor, type Point } from './solidBounds';
import type { AABB } from '../state/entities';
import type { GameState } from '../state/GameState';

/** True if two circles overlap: (ax,ay,ar) vs (bx,by,br). */
export function circlesOverlap(ax: Fp, ay: Fp, ar: Fp, bx: Fp, by: Fp, br: Fp): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/**
 * True if a circle (cx,cy,cr) overlaps a static AABB (design/07/09, ROADMAP 1.2).
 * Closest-point test: clamp the circle centre onto the rect, then compare the
 * squared distance to that point against the radius — the standard circle-vs-rect
 * overlap check, no isqrt needed (squared compare only, matching circlesOverlap).
 */
export function circleOverlapsAabb(cx: Fp, cy: Fp, cr: Fp, rect: AABB): boolean {
  const closestX = Math.max(rect.x, Math.min(cx, (rect.x + rect.w) as Fp));
  const closestY = Math.max(rect.y, Math.min(cy, (rect.y + rect.h) as Fp));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy <= cr * cr;
}

/**
 * Push a point out of any wall/obstacle it overlaps and clamp it inside the world
 * bounds — keeps a drop/pickup spawn point inside the walkable room instead of
 * landing on/behind a wall or past the world edge. Same push-out shape as
 * MovementSystem's resolveWalls/resolveObstacles, just against a bare point +
 * radius instead of a live Actor (a pickup has no Actor record to push). One
 * deterministic pass over walls then obstacles, fixed spatial-index iteration
 * order (design/06) — no Prng draw, so callers don't need a seeded stream for
 * this. Good enough for this game's sparse, mostly axis-aligned room geometry; a
 * point wedged in a deep concave corner could in principle still want a second
 * pass, not worth the complexity until content actually produces one.
 */
export function clampToWalkable(gx: Fp, gy: Fp, radius: Fp, state: GameState): { gx: Fp; gy: Fp } {
  const p: Point = { x: gx, y: gy };

  // World bounds FIRST, solids second (ENGINE_VERSION 49). The order used to be the other way
  // round, and the clamp won: it ran last and could park a point back inside the very wall the
  // push had just cleared. In dungeon mode that is not a corner case — the world bounds ARE the
  // floor extent (`buildFloorGeometry`), whose edge is the perimeter ring, one grid cell
  // (1000 fp) thick, while the clamp parks the point at exactly `radius` (500 fp) from the
  // edge. Measured on shipped floor 1 before the fix: 247 of 23,509 standable samples came back
  // unstandable. Clamping first cannot have that effect, because the solid push is the last
  // word — and it only ever moves a point AWAY from the perimeter, i.e. further inside the
  // world, so it cannot undo the clamp either. `boundaryParity.test.ts` pins both directions.
  // Walls, obstacles, then the world bounds — ALL THREE inside one loop, repeated to a fixed
  // point (ENGINE_VERSION 49).
  //
  // Two things are going on here, and both were found by measurement rather than reasoning.
  //
  // **The world clamp has to be part of the iteration, not a step before or after it.** It used
  // to run last, and it won: it could park a point back inside the very wall the push had just
  // cleared. In dungeon mode that is not a corner case — the world bounds ARE the floor extent
  // (`buildFloorGeometry`), whose edge is the perimeter ring, one grid cell (1000 fp) thick,
  // while the clamp parks the point at exactly `radius` (500 fp) from the edge. Measured on
  // shipped floor 1: 247 of 23,509 standable samples came back unstandable.
  //
  // Simply moving the clamp FIRST does not work either, and the reason is worth keeping: a
  // point inside the perimeter ring is pushed out by its NEAREST edge, and for a wall lying on
  // the world's own boundary the nearest edge is the OUTER one — so the push escorts the point
  // straight out of the map. Measured the same way: hundreds of samples per floor landed at
  // `worldW + radius`. Neither order works alone because the two constraints genuinely
  // conflict at the map edge; the fix is to alternate until they agree.
  //
  // **The pass has to repeat at all.** A single pass was this function's own documented
  // limitation — "a point wedged in a deep concave corner could in principle still want a
  // second pass, not worth the complexity until content actually produces one". Content did:
  // shipped floor 1 had results still a full `radius` deep, because being pushed clear of wall
  // A can land a point inside wall B and nothing looked again. A drop resting inside stone is
  // the exact v48 report, so that trade no longer holds.
  //
  // Bounded and deterministic: at most `MAX_SEPARATION_PASSES`, exiting early only on an EXACT
  // no-movement comparison, so every client runs the same number of passes and reaches the same
  // answer. The clamp is deliberately LAST within each pass, so if a genuinely degenerate
  // pocket exhausts the cap the point ends up in-world and touching stone rather than outside
  // the map entirely — the safer of the two failure modes, since a pickup outside the floor is
  // unreachable by construction.
  for (let pass = 0; pass < MAX_SEPARATION_PASSES; pass++) {
    const beforeX = p.x;
    const beforeY = p.y;
    for (const idx of state.spatialIndex.queryWalls(p.x, p.y, queryRadiusFor(radius))) {
      pushOutOfWall(p, radius, state.walls[idx]!);
    }
    for (const idx of state.spatialIndex.queryObstacles(p.x, p.y, radius)) {
      pushOutOfObstacle(p, radius, state.obstacles[idx]!);
    }
    clampToWorldBounds(p, radius, state);
    if (p.x === beforeX && p.y === beforeY) break;
  }

  return { gx: p.x, gy: p.y };
}

/**
 * How many times `clampToWalkable` re-runs its separation pass before giving up.
 *
 * Four is not a tuning knob to fiddle with — it is a determinism constant. Every client must
 * run the same bound, so changing it moves outcomes and bumps `ENGINE_VERSION`. Measured on the
 * five shipped ember floors and the launch arena: every sample converges within three passes,
 * so four is one clear of the worst real case rather than an arbitrary round number.
 */
const MAX_SEPARATION_PASSES = 4;

/** Pull a point inside the world by its own radius. Mutates `p`. */
function clampToWorldBounds(p: Point, radius: Fp, state: GameState): void {
  p.x = Math.max(radius, Math.min(state.worldW - radius, p.x)) as Fp;
  p.y = Math.max(radius, Math.min(state.worldH - radius, p.y)) as Fp;
}

/**
 * Remove dead entries in place, preserving order (push order = iteration order,
 * design/08). Arrays on GameState are readonly fields, so systems compact in
 * place rather than reassigning. Deterministic: a stable front-to-back compaction.
 */
export function retainAlive<T extends { alive: boolean }>(arr: T[]): void {
  let w = 0;
  for (let r = 0; r < arr.length; r++) {
    const item = arr[r]!;
    if (item.alive) arr[w++] = item;
  }
  arr.length = w;
}
