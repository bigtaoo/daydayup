/// <reference types="node" />
/**
 * The floor stops at the rooms (2026-08-20, `floorRender.stampFloor` + `RoomBuilder.floorRegionsPx`)
 * — and this file is the reason that is safe in PvE and deliberately NOT done in PvP.
 *
 * Painting the floor per room rather than over the world's bounding box is only correct if the room
 * rects cover everywhere a player can actually stand; get that wrong and a player walks out over
 * the backdrop. "Not inside a wall" is not the test, because a PvE floor's bounding box contains
 * large enclosed regions that no room occupies and nothing walls off — they are simply unreachable.
 * So the invariant here is REACHABILITY: flood-fill the grid from every room's centre through
 * non-wall cells, and require every cell reached to be inside a room rect.
 *
 * Measured when written, over the five shipped floors: the reachable set is exactly the rooms
 * (0 cells outside), while the world's bounding box is 1.41-2.26x the rooms' own area — 29%, 35%,
 * 39%, 39% and 56% of the old floor was painted where no room exists at all. The shipped
 * `arena_prototype_60` fails the same test by 5240 cells (45% of its non-wall cells), which is why
 * an arena keeps the whole-world floor.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFloorGeometry,
  EMBER_L1_FLOORS,
  EMBER_L1_ROOMS,
  placeAuthoredFloor,
  toFpGrid,
  type RoomPiece,
} from '@dd/engine';
import { buildArenaGeometry, buildArenaRoomRects } from '@dd/engine/content/arenas';
import { ARENA_CATALOG } from '../match/arenaCatalog';

interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const FLOOR_INDICES = Object.keys(EMBER_L1_FLOORS).map(Number);

const inside = (gx: number, gy: number, r: { x: number; y: number; w: number; h: number }): boolean =>
  gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h;

/**
 * Cells reachable from `starts` through non-wall cells, and how many of them fall outside every
 * rect in `regions`. 4-connected on the 1-grid-cell lattice the content is authored on.
 */
function reachOutside(
  size: { w: number; h: number },
  walls: readonly { x: number; y: number; w: number; h: number }[],
  regions: readonly GridRect[],
  starts: readonly { x: number; y: number }[],
): { reached: number; outside: number } {
  const solid = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= size.w || y >= size.h) return true;
    const gx = toFpGrid(x + 0.5);
    const gy = toFpGrid(y + 0.5);
    return walls.some((w) => inside(gx, gy, w));
  };
  const seen = new Set<number>();
  const queue: Array<[number, number]> = [];
  for (const s of starts) {
    const key = s.y * size.w + s.x;
    if (!solid(s.x, s.y) && !seen.has(key)) {
      seen.add(key);
      queue.push([s.x, s.y]);
    }
  }
  let outside = 0;
  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    if (!regions.some((r) => x + 0.5 >= r.x && x + 0.5 <= r.x + r.w && y + 0.5 >= r.y && y + 0.5 <= r.y + r.h)) {
      outside++;
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      const key = ny * size.w + nx;
      if (seen.has(key) || solid(nx, ny)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  return { reached: seen.size, outside };
}

describe('a PvE floor\'s rooms cover everywhere the player can reach', () => {
  it('leaves no reachable cell outside a room rect, on all five shipped floors', () => {
    let totalReached = 0;
    for (const index of FLOOR_INDICES) {
      const { placed, doors } = placeAuthoredFloor(EMBER_L1_FLOORS[index]!, EMBER_L1_ROOMS as readonly RoomPiece[]);
      const geo = buildFloorGeometry(placed, doors);
      const rooms: GridRect[] = placed.map((r) => ({
        x: r.offsetXGrid,
        y: r.offsetYGrid,
        w: r.piece.sizeGrid.w,
        h: r.piece.sizeGrid.h,
      }));
      const size = {
        w: Math.round(geo.worldW / toFpGrid(1)),
        h: Math.round(geo.worldH / toFpGrid(1)),
      };
      // Start from every room's centre: the rooms are all door-connected by construction, so this
      // is the same reachable set the player's own spawn produces, without depending on where
      // SpawnSystem happens to put them.
      const starts = rooms.map((r) => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) }));
      const { reached, outside } = reachOutside(size, geo.walls, rooms, starts);
      expect(outside).toBe(0);
      expect(reached).toBeGreaterThan(0);
      totalReached += reached;
    }
    expect(totalReached).toBeGreaterThan(1000); // the sweep really walked five floors, not five spawns
  });

  it('...and the world bounding box those rooms sit in is much larger than they are', () => {
    // The measurement that motivated the change: the old floor was one TilingSprite over this box.
    let worst = 0;
    for (const index of FLOOR_INDICES) {
      const { placed, doors } = placeAuthoredFloor(EMBER_L1_FLOORS[index]!, EMBER_L1_ROOMS as readonly RoomPiece[]);
      const geo = buildFloorGeometry(placed, doors);
      const boxArea = (geo.worldW / toFpGrid(1)) * (geo.worldH / toFpGrid(1));
      const roomArea = placed.reduce((a, r) => a + r.piece.sizeGrid.w * r.piece.sizeGrid.h, 0);
      worst = Math.max(worst, boxArea / roomArea);
    }
    expect(worst).toBeGreaterThan(1.3);
  });
});

describe('a PvP arena\'s rooms do NOT — which is why it keeps the whole-world floor', () => {
  it('has reachable space outside every room rect and every door passage', () => {
    const map = ARENA_CATALOG.arena_prototype_60;
    const geo = buildArenaGeometry(map);
    const rooms = buildArenaRoomRects(map).map(({ rect }) => ({
      x: rect.x / toFpGrid(1),
      y: rect.y / toFpGrid(1),
      w: rect.w / toFpGrid(1),
      h: rect.h / toFpGrid(1),
    }));
    const passages: GridRect[] = (map.doors ?? []).map((d) => ({
      x: d.passageGrid.x,
      y: d.passageGrid.y,
      w: d.passageGrid.w,
      h: d.passageGrid.h,
    }));
    const starts = rooms.map((r) => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) }));
    const { outside } = reachOutside(map.sizeGrid, geo.walls, [...rooms, ...passages], starts);
    // If this ever reaches 0, an arena's rooms have become a partition of its walkable space and
    // `RoomBuilder.floorRegionsPx` should stop special-casing it — the per-room floor is the better
    // look and the branch only exists because of this number.
    expect(outside).toBeGreaterThan(0);
  });
});
