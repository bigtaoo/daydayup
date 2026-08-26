/**
 * `roomsCoverReachableSpace`: may the floor stop at the rooms? Fixtures for the mechanism here;
 * `floorCoverage.test.ts` runs the same question over the REAL shipped content (five PvE floors,
 * every arena in the catalog) with an independently-written flood fill as its oracle.
 *
 * The cases below are chosen around the two ways this can be wrong in a way that ships: saying
 * "partition" for a map with a leak (the player walks onto the backdrop), and saying "not a
 * partition" for a map that is one (the floor keeps painting 27% of a world nobody can reach).
 */
import { describe, it, expect } from 'vitest';
import { toFpGrid, type AABB } from '@dd/engine';
import { cellExtent, roomsCoverReachableSpace } from './floorPartition';

const g = (x: number, y: number, w: number, h: number): AABB => ({
  x: toFpGrid(x),
  y: toFpGrid(y),
  w: toFpGrid(w),
  h: toFpGrid(h),
});

/** A 1-cell-thick perimeter around `rect`, i.e. what a walled room's own edges look like. */
function perimeter(x: number, y: number, w: number, h: number): AABB[] {
  return [g(x, y, w, 1), g(x, y + h - 1, w, 1), g(x, y, 1, h), g(x + w - 1, y, 1, h)];
}

const SIZE = { w: 20, h: 20 };

describe('roomsCoverReachableSpace', () => {
  it('says yes for a single fully-walled room', () => {
    expect(roomsCoverReachableSpace(SIZE, perimeter(2, 2, 8, 8), [g(2, 2, 8, 8)])).toBe(true);
  });

  it('says no when the room has a hole and open world beyond it', () => {
    // Same room, minus the middle of its east wall: the player steps out into the void.
    const walls = [g(2, 2, 8, 1), g(2, 9, 8, 1), g(2, 2, 1, 8), g(9, 2, 1, 3), g(9, 7, 1, 3)];
    expect(roomsCoverReachableSpace(SIZE, walls, [g(2, 2, 8, 8)])).toBe(false);
  });

  it('says no for rooms with no walls at all — the `landing_basic` shape', () => {
    expect(roomsCoverReachableSpace(SIZE, [], [g(2, 2, 5, 5), g(12, 2, 5, 5)])).toBe(false);
  });

  it('says yes for two flush walled rooms joined by a door hole in their shared wall', () => {
    // Flush at x=10: room A's east wall and room B's west wall are back to back, and the door
    // is a hole in BOTH — the launch arena's own construction (`slotGrid.ts`).
    const a = [g(2, 2, 9, 1), g(2, 9, 9, 1), g(2, 2, 1, 8), g(10, 2, 1, 3), g(10, 6, 1, 4)];
    const b = [g(11, 2, 7, 1), g(11, 9, 7, 1), g(17, 2, 1, 8), g(11, 2, 1, 3), g(11, 6, 1, 4)];
    expect(roomsCoverReachableSpace(SIZE, [...a, ...b], [g(2, 2, 9, 8), g(11, 2, 7, 8)])).toBe(true);
  });

  it('says no when that door opens into the gap between two rooms that are NOT flush', () => {
    // The defect `arena_prototype_60` had at map scale: a door graph over rooms with space
    // between them, so "through the door" means "into the void".
    const a = [g(2, 2, 8, 1), g(2, 9, 8, 1), g(2, 2, 1, 8), g(9, 2, 1, 3), g(9, 6, 1, 4)];
    const b = [g(13, 2, 5, 1), g(13, 9, 5, 1), g(17, 2, 1, 8), g(13, 2, 1, 3), g(13, 6, 1, 4)];
    expect(roomsCoverReachableSpace(SIZE, [...a, ...b], [g(2, 2, 8, 8), g(13, 2, 5, 8)])).toBe(false);
  });

  it('covers a room whose own centre is solid — the seed is every cell, not one per room', () => {
    // One of the launch arena's 60 rooms has an interior kit standing on its centre point, which
    // is why this does not seed from room centres. A pillar block filling the middle must not
    // make the room unseedable.
    const walls = [...perimeter(2, 2, 8, 8), g(4, 4, 4, 4)];
    expect(roomsCoverReachableSpace(SIZE, walls, [g(2, 2, 8, 8)])).toBe(true);
  });

  it('covers a room an interior kit splits into two disconnected pockets', () => {
    const walls = [...perimeter(2, 2, 8, 8), g(5, 3, 1, 6)];
    expect(roomsCoverReachableSpace(SIZE, walls, [g(2, 2, 8, 8)])).toBe(true);
  });

  it('reports no for a map with no rooms, and for rooms with nothing walkable in them', () => {
    expect(roomsCoverReachableSpace(SIZE, [], [])).toBe(false);
    // A room filled solid: no seed exists, which is a bug in the content rather than a licence
    // to stop painting the floor.
    expect(roomsCoverReachableSpace(SIZE, [g(2, 2, 8, 8)], [g(2, 2, 8, 8)])).toBe(false);
  });

  it('rejects a degenerate world extent rather than answering yes for it', () => {
    // A zero extent would answer `false` anyway (nothing to seed), so the guard's only
    // non-equivalent trigger is a NEGATIVE one, where `new Uint8Array(w * h)` throws. Without a
    // negative case here the guard survives its own mutant while looking covered — so the case
    // exists rather than the guard being trimmed to what the fixtures happen to reach.
    expect(roomsCoverReachableSpace({ w: 0, h: 20 }, [], [g(2, 2, 5, 5)])).toBe(false);
    expect(roomsCoverReachableSpace({ w: 20, h: 0 }, [], [g(2, 2, 5, 5)])).toBe(false);
    expect(roomsCoverReachableSpace({ w: -20, h: 20 }, [], [g(2, 2, 5, 5)])).toBe(false);
    expect(roomsCoverReachableSpace({ w: 20, h: -20 }, [], [g(2, 2, 5, 5)])).toBe(false);
  });

  it('a one-cell gap in a wall is still a leak — walls are rasterized to their exact cells', () => {
    // The north wall in two runs with a single open cell at x=5 between them. A rasterizer that
    // rounds a wall's start DOWN or its end UP by one cell seals this gap and reports a partition,
    // which ships as a player walking out through a hole the floor was told did not exist.
    const walls = [g(2, 2, 3, 1), g(6, 2, 4, 1), g(2, 9, 8, 1), g(2, 2, 1, 8), g(9, 2, 1, 8)];
    expect(roomsCoverReachableSpace(SIZE, walls, [g(2, 2, 8, 8)])).toBe(false);
    // ...and closing exactly that one cell is the whole difference.
    expect(roomsCoverReachableSpace(SIZE, [...walls, g(5, 2, 1, 1)], [g(2, 2, 8, 8)])).toBe(true);
  });

  it('treats the map edge as solid, so a room flush into the corner is still enclosed', () => {
    // Walled on the east and south only: rows and columns 0 are OPEN floor inside the room, so
    // the flood fill really does step to the world boundary on both axes and has to stop there.
    const walls = [g(5, 0, 1, 6), g(0, 5, 6, 1)];
    expect(roomsCoverReachableSpace({ w: 20, h: 20 }, walls, [g(0, 0, 6, 6)])).toBe(true);
    // The control for it: the same room one cell in from the corner leaks around its open sides.
    expect(roomsCoverReachableSpace({ w: 20, h: 20 }, [g(6, 1, 1, 6), g(1, 6, 6, 1)], [g(1, 1, 6, 6)])).toBe(false);
  });

  it('...and the FAR corner too, where an unguarded step wraps into the next row', () => {
    // The mirror of the case above, and it catches a different bug: a 1-D cell index steps east
    // by +1 and south by +width, so at the last column `+1` silently lands on column 0 of the
    // next row and at the last row `+width` runs off the end. Only a room whose floor actually
    // touches x = w-1 / y = h-1 exercises those two guards; the near corner does not.
    const walls = [g(14, 14, 6, 1), g(14, 14, 1, 6)];
    expect(roomsCoverReachableSpace({ w: 20, h: 20 }, walls, [g(14, 14, 6, 6)])).toBe(true);
    expect(roomsCoverReachableSpace({ w: 20, h: 20 }, [g(13, 13, 6, 1), g(13, 13, 1, 6)], [g(13, 13, 6, 6)])).toBe(false);
  });
});

describe('cellExtent', () => {
  it('converts a world size in fp back to whole grid cells', () => {
    expect(cellExtent(toFpGrid(121), toFpGrid(95))).toEqual({ w: 121, h: 95 });
  });

  it('rounds to the nearest cell rather than truncating — it is undoing noise, not measuring', () => {
    // Its input is always a whole number of cells by construction (`ArenaMap.sizeGrid` is integers
    // and `GameState.worldW` is `toFpGrid` of one), so the division is exact and `Math.round`,
    // `Math.floor` and `Math.ceil` all agree — which is exactly why swapping round for floor
    // survives the rest of the suite while being wrong. What it is actually for is fixed-point
    // noise: one fp unit short of a whole cell must still be that cell, not the one below it.
    expect(cellExtent(toFpGrid(121) - 1, toFpGrid(95) - 1)).toEqual({ w: 121, h: 95 });
    expect(cellExtent(toFpGrid(121) + 1, toFpGrid(95) + 1)).toEqual({ w: 121, h: 95 });
  });
});
