/**
 * `wallRuns` — merging the engine's wall AABBs into the runs they visually form (2026-08-19
 * volume pass). Pure geometry, so this file can be exact rather than approximate.
 *
 * The two properties that matter are opposites of each other, and both are load-bearing:
 * adjacent same-tier rects MUST merge (that is the whole point — a room boundary is two
 * parallel walls, one per room, and drawing them separately puts a lit/dark seam down the
 * middle of one stone mass), and anything else must NOT (a merge that invents stone where the
 * content has none would put a block across a doorway, and a merge across TIERS would give a
 * room's low south kerb the height of its neighbour's perimeter wall — reintroducing the exact
 * bug the kerb exists to prevent).
 */
import { describe, it, expect } from 'vitest';
import { joinRects, mergeWallRuns, type WallRun } from './wallRuns';
import type { RectPx } from './wallGeometry';

const r = (x: number, y: number, w: number, h: number): RectPx => ({ x, y, w, h });
const run = (rect: RectPx, tier: WallRun['tier'] = 'perimeter'): WallRun => ({ rect, tier });

describe('joinRects — only an exact rectangle union', () => {
  it('joins two side-by-side rects of the same height into one', () => {
    // The shipped case: `ember_l1_gallery`'s room boundary, two 32 px north-south runs at
    // x = 184 and x = 188 in grid units, one per adjoining room.
    expect(joinRects(r(184, 8, 4, 27), r(188, 8, 4, 27))).toEqual(r(184, 8, 8, 27));
  });

  it('joins two stacked rects of the same width into one', () => {
    expect(joinRects(r(0, 0, 64, 4), r(0, 4, 64, 4))).toEqual(r(0, 0, 64, 8));
  });

  it('joins in either argument order, with the same result', () => {
    expect(joinRects(r(188, 8, 4, 27), r(184, 8, 4, 27))).toEqual(joinRects(r(184, 8, 4, 27), r(188, 8, 4, 27)));
  });

  it('collapses two identical rects to one, rather than doubling their extent', () => {
    expect(joinRects(r(10, 10, 4, 20), r(10, 10, 4, 20))).toEqual(r(10, 10, 4, 20));
  });

  it('joins across sub-pixel slack, since a grid wall goes through fixed point', () => {
    expect(joinRects(r(0, 0, 32, 32.4), r(32.5, 0, 32, 32))).not.toBeNull();
  });

  it('refuses a real gap — a doorway must never be bridged with stone', () => {
    expect(joinRects(r(0, 0, 32, 32), r(96, 0, 32, 32))).toBeNull();
  });

  it('refuses an L: the union of two perpendicular runs is not a rectangle', () => {
    expect(joinRects(r(0, 0, 200, 32), r(0, 0, 32, 200))).toBeNull();
  });

  it('refuses a T, and a partial overlap of unequal depth', () => {
    expect(joinRects(r(0, 0, 200, 32), r(80, 32, 32, 100))).toBeNull();
    expect(joinRects(r(0, 0, 32, 100), r(32, 20, 32, 100))).toBeNull();
  });
});

describe('mergeWallRuns — over a whole room, to a fixed point', () => {
  it('merges a chain of three, not just the first pair', () => {
    // Iterating to a fixed point matters: a 3-cell-thick boundary would otherwise come out as
    // one merged pair plus a leftover slab, i.e. still seamed, just less often.
    const merged = mergeWallRuns([run(r(0, 0, 4, 40)), run(r(4, 0, 4, 40)), run(r(8, 0, 4, 40))]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.rect).toEqual(r(0, 0, 12, 40));
  });

  it('NEVER merges across tiers — a kerb must not inherit a perimeter wall\'s height', () => {
    // A room's south boundary and its southern neighbour's north boundary are stacked adjacent
    // rects of different tiers. `WALL_H_KERB` exists so the south one cannot stand between the
    // camera and the player it frames; one merge here and it stands 104 px tall instead of 22.
    const merged = mergeWallRuns([run(r(0, 60, 64, 4), 'kerb'), run(r(0, 64, 64, 4), 'perimeter')]);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.tier).sort()).toEqual(['kerb', 'perimeter']);
  });

  it('keeps the tier of what it merged', () => {
    const merged = mergeWallRuns([run(r(0, 0, 4, 40), 'interior'), run(r(4, 0, 4, 40), 'interior')]);
    expect(merged[0]!.tier).toBe('interior');
  });

  it('leaves an unmergeable room untouched, rect for rect', () => {
    const input = [run(r(0, 0, 200, 32)), run(r(0, 400, 200, 32), 'kerb'), run(r(0, 32, 32, 368))];
    const merged = mergeWallRuns(input);
    expect(merged).toHaveLength(3);
    expect(merged.map((m) => m.rect)).toEqual(input.map((i) => i.rect));
  });

  it('does not mutate its input — RoomBuilder rebuilds from `s.walls` every room', () => {
    const original = r(0, 0, 4, 40);
    const input = [run({ ...original }), run(r(4, 0, 4, 40))];
    mergeWallRuns(input);
    expect(input[0]!.rect).toEqual(original);
    expect(input).toHaveLength(2);
  });

  it('handles the empty and single-wall cases', () => {
    expect(mergeWallRuns([])).toEqual([]);
    expect(mergeWallRuns([run(r(1, 2, 3, 4))])).toHaveLength(1);
  });

  it('conserves total area for a mergeable pair, and never invents any', () => {
    // The strongest single guard against a bad union rule: merging two 4x27 rects into anything
    // other than 8x27 either loses stone or invents it, and both are visible.
    const merged = mergeWallRuns([run(r(184, 8, 4, 27)), run(r(188, 8, 4, 27))]);
    const area = merged.reduce((a, m) => a + m.rect.w * m.rect.h, 0);
    expect(area).toBe(2 * 4 * 27);
  });
});
