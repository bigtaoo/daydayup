/**
 * Integer geometry helpers shared by the collision-touching systems. All compares
 * are squared-distance so nothing calls isqrt/Math.sqrt (design/06 banned list).
 * Fp arithmetic on plain `+`/`-`/`*` is fine here: we only compare, never store.
 */
import { isqrt, type Fp } from '../math/fixed';
import { WALL_NORTH_BRIM } from '../config';
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
  let x = gx;
  let y = gy;

  // Broadphase widened by the brim for the same reason MovementSystem.resolveWalls widens its
  // own query: the index is built over authored footprints, so a point that only overlaps a
  // free-standing block's BRIMMED north face (never the real stone) is invisible to a
  // radius-only query unless we ask a little wider here too.
  for (const idx of state.spatialIndex.queryWalls(x, y, (radius + WALL_NORTH_BRIM) as Fp)) {
    const w = state.walls[idx]!;
    // Same brimmed top edge as resolveWalls: a free-standing block's art rises a full wall
    // height north of `w.y`, and a point clamped only against the bare rect can land inside
    // that art — reachable on screen but, per resolveWalls, physically unreachable by any
    // actor (design/07 pickups: "would otherwise drop the pickup somewhere the player can't
    // reach"). Perimeter/kerb rects are never freeStanding, so they keep exact-footprint
    // clamping, same as their collision.
    const top = (w.freeStanding ? w.y - WALL_NORTH_BRIM : w.y) as Fp;
    const right = (w.x + w.w) as Fp;
    const bottom = (w.y + w.h) as Fp;
    const closestX = Math.max(w.x, Math.min(x, right)) as Fp;
    const closestY = Math.max(top, Math.min(y, bottom)) as Fp;
    const dx = x - closestX;
    const dy = y - closestY;
    const distSq = dx * dx + dy * dy;
    if (distSq > 0) {
      if (distSq >= radius * radius) continue; // no overlap
      const dist = isqrt(distSq);
      const pen = radius - dist;
      x = (x + Math.trunc((dx * pen) / dist)) as Fp;
      y = (y + Math.trunc((dy * pen) / dist)) as Fp;
      continue;
    }
    // Point is inside the rect: push out along the nearest single edge (same
    // deterministic tie-break as MovementSystem.resolveWalls).
    const pushLeft = (x - w.x) as number;
    const pushRight = (right - x) as number;
    const pushTop = (y - top) as number;
    const pushBottom = (bottom - y) as number;
    const min = Math.min(pushLeft, pushRight, pushTop, pushBottom);
    if (min === pushRight) x = (right + radius) as Fp;
    else if (min === pushLeft) x = (w.x - radius) as Fp;
    else if (min === pushBottom) y = (bottom + radius) as Fp;
    else y = (top - radius) as Fp;
  }

  for (const idx of state.spatialIndex.queryObstacles(x, y, radius)) {
    const o = state.obstacles[idx]!;
    const dx = x - o.gx;
    const dy = y - o.gy;
    const minDist = radius + o.radius;
    const distSq = dx * dx + dy * dy;
    if (distSq >= minDist * minDist) continue; // no overlap
    const dist = isqrt(distSq);
    if (dist === 0) {
      // Exactly concentric — no defined push direction; nudge +x by the full
      // clearance, same deterministic tie-break as MovementSystem.resolveObstacles.
      x = (x + minDist) as Fp;
      continue;
    }
    const pen = minDist - dist;
    x = (x + Math.trunc((dx * pen) / dist)) as Fp;
    y = (y + Math.trunc((dy * pen) / dist)) as Fp;
  }

  x = Math.max(radius, Math.min(state.worldW - radius, x)) as Fp;
  y = Math.max(radius, Math.min(state.worldH - radius, y)) as Fp;

  return { gx: x, gy: y };
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
