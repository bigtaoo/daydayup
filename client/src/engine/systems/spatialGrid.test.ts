/**
 * UniformGrid broadphase (ROADMAP 4.2b) — cell math, the padding safety margin,
 * and the "ascending original-index order" contract MovementSystem's cumulative
 * wall push-out relies on (see MovementSystem.resolveWalls).
 */
import { describe, it, expect } from 'vitest';
import { toFpGrid } from '@dd/engine/content/convert';
import type { AABB, Obstacle } from '@dd/engine/state/entities';
import { UniformGrid, CELL_SIZE_GRID, QUERY_PADDING_GRID } from '@dd/engine/systems/spatialGrid';

function wall(x: number, y: number, w: number, h: number): AABB {
  return { x: toFpGrid(x), y: toFpGrid(y), w: toFpGrid(w), h: toFpGrid(h) };
}

function obstacle(gx: number, gy: number, radius: number): Obstacle {
  return { gx: toFpGrid(gx), gy: toFpGrid(gy), radius: toFpGrid(radius) };
}

describe('UniformGrid — walls', () => {
  it('finds a wall directly under the query point', () => {
    const walls = [wall(10, 10, 2, 2)];
    const grid = new UniformGrid(walls, []);
    expect(grid.queryWalls(toFpGrid(11), toFpGrid(11), toFpGrid(0.2))).toEqual([0]);
  });

  it('does not return a wall many cells away', () => {
    const walls = [wall(10, 10, 2, 2)];
    const grid = new UniformGrid(walls, []);
    // Far enough that even the padded query rect can't reach the wall's cell.
    const far = toFpGrid(10 + (CELL_SIZE_GRID + QUERY_PADDING_GRID) * 5);
    expect(grid.queryWalls(far, far, toFpGrid(0.2))).toEqual([]);
  });

  it('returns a long wall exactly once, from either end of its span', () => {
    // Spans many cells (CELL_SIZE_GRID = 4 grid units per cell).
    const walls = [wall(0, 0, CELL_SIZE_GRID * 6, 1)];
    const grid = new UniformGrid(walls, []);
    const nearStart = grid.queryWalls(toFpGrid(0.5), toFpGrid(0.5), toFpGrid(0.1));
    const nearEnd = grid.queryWalls(toFpGrid(CELL_SIZE_GRID * 6 - 0.5), toFpGrid(0.5), toFpGrid(0.1));
    expect(nearStart).toEqual([0]);
    expect(nearEnd).toEqual([0]);
  });

  it('returns candidates sorted by original array index, not insertion/bucket order', () => {
    // Three walls sharing the same cell region, inserted out of the order we
    // expect back — resolveWalls depends on ascending original-index iteration
    // when solids overlap (design/07/09 fixed-array-order determinism).
    const walls = [wall(9, 9, 1, 1), wall(11, 9, 1, 1), wall(10, 10, 1, 1)];
    const grid = new UniformGrid(walls, []);
    const found = grid.queryWalls(toFpGrid(10.5), toFpGrid(10.5), toFpGrid(2));
    expect(found).toEqual([0, 1, 2]);
  });

  it('the query padding is generous enough to catch a wall just across a cell boundary', () => {
    // Wall sits at the start of the next cell over from the query point; a
    // same-tick cumulative push (obstacles resolved before walls) can move an
    // actor this far — the padding exists precisely so that isn't missed.
    const cellEdge = CELL_SIZE_GRID; // boundary between cell 0 and cell 1
    const walls = [wall(cellEdge + 0.1, 0, 1, 1)];
    const grid = new UniformGrid(walls, []);
    const found = grid.queryWalls(toFpGrid(cellEdge - 0.1), toFpGrid(0.5), toFpGrid(0.2));
    expect(found).toContain(0);
  });

  it('a query far from every wall in a large scattered set returns few or no candidates', () => {
    // Shape of the eventual PvP-arena regime: many co-resident walls, one point
    // query should only touch its own neighborhood, not the whole array.
    const walls: AABB[] = [];
    for (let i = 0; i < 100; i++) walls.push(wall(i * 20, 0, 1, 1)); // spread far apart
    const grid = new UniformGrid(walls, []);
    const found = grid.queryWalls(toFpGrid(1000.5), toFpGrid(0.5), toFpGrid(0.2));
    expect(found.length).toBeLessThan(walls.length);
  });
});

describe('UniformGrid — obstacles', () => {
  it('finds an obstacle overlapping the query circle', () => {
    const obstacles = [obstacle(5, 5, 1)];
    const grid = new UniformGrid([], obstacles);
    expect(grid.queryObstacles(toFpGrid(5), toFpGrid(5), toFpGrid(0.5))).toEqual([0]);
  });

  it('does not return an obstacle many cells away', () => {
    const obstacles = [obstacle(5, 5, 1)];
    const grid = new UniformGrid([], obstacles);
    const far = toFpGrid(5 + (CELL_SIZE_GRID + QUERY_PADDING_GRID) * 5);
    expect(grid.queryObstacles(far, far, toFpGrid(0.5))).toEqual([]);
  });

  it('returns candidates sorted by original array index', () => {
    const obstacles = [obstacle(11, 9, 1), obstacle(9, 9, 1), obstacle(10, 10, 1)];
    const grid = new UniformGrid([], obstacles);
    const found = grid.queryObstacles(toFpGrid(10), toFpGrid(10), toFpGrid(2));
    expect(found).toEqual([0, 1, 2]);
  });
});

describe('UniformGrid — empty inputs', () => {
  it('an empty grid returns no candidates for either query', () => {
    const grid = new UniformGrid([], []);
    expect(grid.queryWalls(toFpGrid(0), toFpGrid(0), toFpGrid(1))).toEqual([]);
    expect(grid.queryObstacles(toFpGrid(0), toFpGrid(0), toFpGrid(1))).toEqual([]);
  });
});
