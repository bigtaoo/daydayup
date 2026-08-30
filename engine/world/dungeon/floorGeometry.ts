/**
 * Stitching placed rooms' collision geometry into one co-resident floor, split
 * out of dungeon.ts (CLAUDE.md "500-line file convention", form ①) — independent
 * of which placement function (`placeFloor`/`placeFloorGraph2d`/`placeAuthoredFloor`)
 * produced the `PlacedRoom[]`/`Door[]` it consumes.
 */
import { roomGeometry, type AabbGrid } from '../../content/rooms';
import type { Door } from '../../content/arenas';
import { toFpGrid } from '../../content/convert';
import type { AABB, Obstacle } from '../../state/entities';
import { addFp, subFp, type Fp } from '../../math/fixed';
import type { PlacedRoom } from './types';

/**
 * Subtract every door's passage rect from a floor's stitched wall list — the
 * ONLY place any gap is ever cut (design/05, 2026-08-04): hand-authored pieces
 * (`world/rooms/ember.ts perimeterWalls`) now always emit a full, uncut wall per
 * edge, regardless of `exits`. A generic axis-aligned rect-minus-rect split (up to
 * 4 residual pieces per wall the passage overlaps) — it doesn't matter whether the
 * overlapped solid IS the perimeter wall or an incidental interior solid (e.g.
 * `ember_cross`'s stub walls near its west/east openings): either way, whatever a
 * door's rect overlaps gets cleanly carved through. Operates in Fp (post-
 * conversion) space, same as `roomGeometry`'s own output.
 */
export function carveDoorGaps(walls: readonly AABB[], passages: readonly AABB[]): AABB[] {
  let result: AABB[] = walls.slice();
  for (const passage of passages) {
    const next: AABB[] = [];
    for (const wall of result) next.push(...subtractRect(wall, passage));
    result = next;
  }
  return result;
}

/** `wall` minus `hole`, as 0-4 residual AABBs (a standard rect-difference: left
 * strip, right strip, then top/bottom strips clipped to the hole's own X-range so
 * the four pieces never overlap each other). Returns `[wall]` unchanged if the two
 * don't overlap at all. */
function subtractRect(wall: AABB, hole: AABB): AABB[] {
  const wx0 = wall.x;
  const wx1 = addFp(wall.x, wall.w);
  const wy0 = wall.y;
  const wy1 = addFp(wall.y, wall.h);
  const hx0 = hole.x;
  const hx1 = addFp(hole.x, hole.w);
  const hy0 = hole.y;
  const hy1 = addFp(hole.y, hole.h);
  if (hx1 <= wx0 || hx0 >= wx1 || hy1 <= wy0 || hy0 >= wy1) return [wall];

  // A residual piece is still the same object it was carved out of, so it keeps `freeStanding`
  // (v47). In practice a door only ever cuts a perimeter ring, which carries no flag — but a
  // piece that silently LOST the flag would be a block whose north brim disappeared the moment
  // a passage happened to clip its corner, which is exactly the kind of one-room-in-sixty
  // inconsistency this map has been bitten by before.
  const keep = wall.freeStanding ? { freeStanding: true as const } : {};
  const out: AABB[] = [];
  if (hx0 > wx0) out.push({ x: wx0, y: wy0, w: subFp(hx0, wx0), h: wall.h, ...keep });
  if (hx1 < wx1) out.push({ x: hx1, y: wy0, w: subFp(wx1, hx1), h: wall.h, ...keep });
  const midX0 = (wx0 > hx0 ? wx0 : hx0) as Fp; // Math.max would drop the Fp brand
  const midX1 = (wx1 < hx1 ? wx1 : hx1) as Fp; // Math.min, same reason
  if (hy0 > wy0 && midX1 > midX0) out.push({ x: midX0, y: wy0, w: subFp(midX1, midX0), h: subFp(hy0, wy0), ...keep });
  if (hy1 < wy1 && midX1 > midX0) out.push({ x: midX0, y: hy1, w: subFp(midX1, midX0), h: subFp(wy1, hy1), ...keep });
  return out;
}

/**
 * Stitch every placed room's collision geometry into one co-resident floor
 * (mirrors `content/arenas.ts buildArenaGeometry`, reusing the same
 * `roomGeometry` converter per room) and carve every door's gap through it.
 * Pure and side-effect-free — produces the arrays `state.walls`/`state.obstacles`
 * are built from, plus the floor's overall bounds, exactly like
 * `buildArenaGeometry`'s own contract.
 */
export function buildFloorGeometry(
  placed: readonly PlacedRoom[],
  doors: readonly Door[],
): { walls: AABB[]; obstacles: Obstacle[]; worldW: Fp; worldH: Fp } {
  const obstacles: Obstacle[] = [];
  let walls: AABB[] = [];
  let maxXGrid = 0;
  let maxYGrid = 0;
  for (const room of placed) {
    const geo = roomGeometry(room.piece, room.offsetXGrid, room.offsetYGrid);
    walls.push(...geo.walls);
    obstacles.push(...geo.obstacles);
    maxXGrid = Math.max(maxXGrid, room.offsetXGrid + room.piece.sizeGrid.w);
    maxYGrid = Math.max(maxYGrid, room.offsetYGrid + room.piece.sizeGrid.h);
  }
  const passages = doors.map((d) => toFpAabbGrid(d.passageGrid));
  walls = carveDoorGaps(walls, passages);
  return { walls, obstacles, worldW: toFpGrid(maxXGrid), worldH: toFpGrid(maxYGrid) };
}

/** `AabbGrid` (human grid units) → `AABB` (Fp) — same per-field `toFpGrid` shape as
 * `roomGeometry`'s own conversion. Exported so `SpawnSystem` can pre-convert a
 * `Door.passageGrid` into a `DoorRuntime.passageAabb` ONCE, at floor-placement time,
 * rather than duplicating this conversion. */
export function toFpAabbGrid(g: AabbGrid): AABB {
  return { x: toFpGrid(g.x), y: toFpGrid(g.y), w: toFpGrid(g.w), h: toFpGrid(g.h) };
}
