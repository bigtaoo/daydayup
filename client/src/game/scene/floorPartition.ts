// Split out of `groundLayer.ts` 2026-08-26 (CLAUDE.md form ① — one independent function over
// rects, no shared state): the question "may the floor stop at the rooms, or must it cover the
// whole world?", answered by MEASURING the map in hand rather than by a constant.
//
// **Why this is derived and not a flag.** `floorRegionsPx` used to answer it with a branch on
// map KIND — dungeon floors per room, arenas whole-world — resting on one number measured once
// against `arena_prototype_60`: 5240 of its 11,524 non-wall cells (45%) were reachable and
// outside every room, because that map had `solids: []` everywhere and so no walls at all. The
// launch map (`arena_launch`, 2026-08-25) walls every room, which made the branch's premise
// false while the branch went on being true-by-default. A constant measured against content
// goes stale the moment the content is replaced; the sweep that produced it is cheap enough to
// simply run, so it runs.
//
// Cost: one rasterize + one 4-connected BFS over the map's grid lattice, at room-build time
// (once per floor/arena build, never per frame). `arena_launch` is 121x95 = 11,495 cells.
import type { AABB } from '@dd/engine';
import { toFpGrid } from '@dd/engine';

/** A grid-lattice rect, in whole cells. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Are `rooms` a partition of everywhere a player standing in one of them can walk to?
 *
 * The test is REACHABILITY, not "not inside a wall" — a map's bounding box contains enclosed
 * regions that no room occupies and nothing walls off (the launch arena's twelve deliberately
 * empty slots and its outer margin are 2465 such cells), and painting those is exactly the waste
 * a per-room floor exists to avoid. Seeds from every non-solid cell inside any room, so a room
 * whose interior kit splits it into disconnected pockets is still fully covered, and so is a room
 * the door graph happens to strand.
 *
 * Cells are tested at their CENTRE against the wall rects, matching how the engine's own
 * collision sees a cell; a cell straddling a wall edge counts as solid.
 */
export function roomsCoverReachableSpace(
  sizeCells: { w: number; h: number },
  walls: readonly AABB[],
  rooms: readonly AABB[],
): boolean {
  const { w, h } = sizeCells;
  if (w <= 0 || h <= 0) return false;

  const cell = toFpGrid(1);
  const half = cell / 2;

  // Rasterize once: `walls.some(...)` per cell is O(cells x walls), which is 5.6M rect tests on
  // the launch arena and the reason this is a grid and not a predicate.
  const solid = new Uint8Array(w * h);
  for (const wall of walls) {
    const x0 = Math.max(0, Math.ceil((wall.x - half) / cell));
    const x1 = Math.min(w - 1, Math.floor((wall.x + wall.w - half) / cell));
    const y0 = Math.max(0, Math.ceil((wall.y - half) / cell));
    const y1 = Math.min(h - 1, Math.floor((wall.y + wall.h - half) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) solid[y * w + x] = 1;
  }

  const inRoom = new Uint8Array(w * h);
  for (const r of rooms) {
    const x0 = Math.max(0, Math.ceil((r.x - half) / cell));
    const x1 = Math.min(w - 1, Math.floor((r.x + r.w - half) / cell));
    const y0 = Math.max(0, Math.ceil((r.y - half) / cell));
    const y1 = Math.min(h - 1, Math.floor((r.y + r.h - half) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) inRoom[y * w + x] = 1;
  }

  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let i = 0; i < inRoom.length; i++) {
    if (inRoom[i] === 1 && solid[i] === 0) {
      seen[i] = 1;
      queue.push(i);
    }
  }
  // No seed: no rooms at all, or every cell inside them is solid. Both are content bugs rather
  // than a licence to stop painting a floor, so the safe (whole-world) answer is the right one.
  if (queue.length === 0) return false;

  while (queue.length > 0) {
    const i = queue.pop()!;
    if (inRoom[i] === 0) return false; // reachable, outside every room — the floor must cover it
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return true;

  function push(j: number): void {
    if (seen[j] === 1 || solid[j] === 1) return;
    seen[j] = 1;
    queue.push(j);
  }
}

/** Grid-cell extent of a world whose size is known in fp. */
export function cellExtent(worldW: number, worldH: number): { w: number; h: number } {
  const cell = toFpGrid(1);
  return { w: Math.round(worldW / cell), h: Math.round(worldH / cell) };
}
