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
 * 39%, 39% and 56% of the old floor was painted where no room exists at all.
 *
 * **2026-08-26: the PvP half of that sentence stopped being a fixed answer.** It used to read
 * "the shipped `arena_prototype_60` fails the same test by 5240 cells (45% of its non-wall
 * cells), which is why an arena keeps the whole-world floor" — true of that map, false of the
 * map that replaced it. `floorRegionsPx` now DERIVES it per map rather than branching on map
 * kind, and the second half of this file sweeps every catalog map against what the client
 * actually paints.
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
import { createGameState } from '@dd/engine';
import { buildArenaGeometry, buildArenaRoomRects, type ArenaMap } from '@dd/engine/content/arenas';
import { ARENA_CATALOG, ARENA_IDS, type ArenaId } from '../match/arenaCatalog';
import { fpToPx, PX_PER_GRID } from '../coords';
import { floorRegionsPx } from './groundLayer';
import type { RectPx } from './wallGeometry';

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

describe("and the arena's floor now follows the same rule — per map, not per map KIND", () => {
  // Until 2026-08-26 this described the opposite: `arena_prototype_60`'s rooms were NOT a
  // partition of its walkable space (5240 of 11,524 non-wall cells reachable and outside every
  // room, because that map had `solids: []` everywhere), so `floorRegionsPx` hardcoded a
  // whole-world floor for every arena. `arena_launch` walls every room, which made the premise
  // false while the branch went on answering the same way — so the branch now MEASURES it
  // (`floorPartition.roomsCoverReachableSpace`) and this sweep checks the result the client
  // actually paints, for every map in the catalog.
  //
  // `reachOutside` above is the independent oracle: a different implementation (rect list, cell
  // centres, explicit queue) from `floorPartition`'s rasterized bitmap BFS, so the two agreeing
  // is evidence rather than a tautology.
  const cells = (r: RectPx): GridRect => ({
    x: r.x / PX_PER_GRID,
    y: r.y / PX_PER_GRID,
    w: r.w / PX_PER_GRID,
    h: r.h / PX_PER_GRID,
  });

  const painted = (id: ArenaId): { regions: GridRect[]; perRoom: boolean; map: ArenaMap } => {
    const map = ARENA_CATALOG[id];
    const state = createGameState({ seed: 1, worldW: 1, worldH: 1, waves: [], arena: map });
    const regions = floorRegionsPx(state, fpToPx(state.worldW), fpToPx(state.worldH)).map(cells);
    const whole = regions.length === 1 && regions[0]!.x === 0 && regions[0]!.y === 0;
    return { regions, perRoom: !whole, map };
  };

  it.each(ARENA_IDS)('%s: what the client paints agrees with what the map actually is', (id) => {
    const { regions, perRoom, map } = painted(id);
    const geo = buildArenaGeometry(map);
    const rooms = buildArenaRoomRects(map).map(({ rect }) =>
      cells({ x: fpToPx(rect.x), y: fpToPx(rect.y), w: fpToPx(rect.w), h: fpToPx(rect.h) }),
    );
    // Seed from every room, not from one spawn: a room the door graph strands, or one an
    // interior kit splits into pockets, still has to have a floor under it.
    const starts = rooms.map((r) => ({ x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) }));
    const { reached, outside } = reachOutside(map.sizeGrid, geo.walls, regions, starts);
    expect(outside).toBe(0);
    expect(reached).toBeGreaterThan(0);

    // ...and the check above is only half of it. A whole-world floor covers EVERYTHING, so for a
    // map that took the fallback the assertion above passes no matter what the map is — the sweep
    // would look total while testing one branch. So the branch itself is checked against the map:
    // per-room demands the rooms really are a partition, and whole-world demands they really are
    // not. Being needlessly conservative is only wasted floor rather than a player on the backdrop,
    // which is why the derivation errs that way — but an untested "safe" answer is how a branch
    // stops meaning anything, so it is pinned in both directions.
    const outsideRooms = reachOutside(map.sizeGrid, geo.walls, rooms, starts).outside;
    if (perRoom) expect(outsideRooms).toBe(0);
    else expect(outsideRooms).toBeGreaterThan(0);
  });

  // Both answers have to actually occur, or the derivation is a constant wearing a function's
  // clothes — the failure mode `doorStandCoverage.test.ts`'s header names and this repo has
  // shipped once (`wallGeometry`'s old `w > h` guard matched 1 run where 32 should have).
  it('stops at the rooms on the walled launch map, and covers the world on the wall-less fixture', () => {
    const launch = painted('arena_launch');
    expect(launch.perRoom).toBe(true);
    expect(launch.regions).toHaveLength(launch.map.rooms.length);

    // `landing_basic` is three rooms with `solids: []` and nothing between them: its whole
    // 50x50 world is walkable, so stopping the floor at its rooms would put the player on the
    // backdrop between them. This is the case that makes the derivation load-bearing.
    const fixture = painted('landing_basic');
    expect(fixture.perRoom).toBe(false);
    expect(fixture.regions).toEqual([{ x: 0, y: 0, w: 50, h: 50 }]);
  });

  it("the launch arena's floor really did shrink — the world box is bigger than its rooms", () => {
    const { regions, map } = painted('arena_launch');
    const paintedArea = regions.reduce((a, r) => a + r.w * r.h, 0);
    const boxArea = map.sizeGrid.w * map.sizeGrid.h;
    // Measured 2026-08-26: 9030 cells of rooms against an 11,495-cell box — the 2465 cells of
    // deliberately-empty slots and outer margin that used to be stamped and gridded over.
    expect(paintedArea).toBeLessThan(boxArea);
    expect(boxArea - paintedArea).toBeGreaterThan(2000);
  });
});
