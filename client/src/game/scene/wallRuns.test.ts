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
import {
  blockCapTop,
  bordersDoorNorth,
  effectiveWallHeight,
  joinRects,
  mergeWallRuns,
  NO_JOINS,
  unjoinedSpans,
  wallJoins,
  type WallJoins,
  type WallRun,
} from './wallRuns';
import type { RectPx } from './wallGeometry';
import { FACE_CROWN_FRACTION_MIN, faceCrownFraction } from './wallTone';
import { WALL_H_INTERIOR, WALL_H_PERIMETER } from './wallGeometry';

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

describe('wallJoins — which edges are buried in an L or T corner', () => {
  // The shape from level 1's start room, in world px: a 992-wide east-west perimeter wall at
  // y 32..64, and the north-south run at x 1504..1568 hanging off its south edge, y 64..288.
  // `mergeWallRuns` cannot merge them (an L's union is not a rectangle), so they are two blocks —
  // and each was drawing its own "I end here" cues right in the middle of one continuous top.
  const NS = run(r(1504, 64, 64, 224));
  const EW = run(r(1024, 32, 992, 32));

  it('marks the north-south run\'s NORTH edge as buried, in its own local x', () => {
    const [ns] = wallJoins([NS, EW]);
    expect(ns!.north).toEqual([[0, 64]]); // its whole width butts the east-west wall
    expect(ns!.south).toEqual([]); // its south end is the exposed one
  });

  it('routes the east-west wall\'s SOUTH slice to `tuckedSouth`, since the run tucks', () => {
    // A tucked neighbour stops at this wall's south edge, so this wall's own fold there is REAL:
    // it gets a contact crease instead of the mask a merged corner would get. The two lists are
    // exclusive by construction — see `WallJoins`.
    const [, ew] = wallJoins([NS, EW]);
    expect(ew!.tuckedSouth).toEqual([[480, 544]]); // 1504..1568 in the block's own local x
    expect(ew!.south).toEqual([]);
    expect(ew!.north).toEqual([]); // the room's outer face — genuinely exposed
  });

  it('tucks a DEEP run whose north edge is buried along its whole width', () => {
    const [ns] = wallJoins([NS, EW]);
    expect(ns!.tuckNorth).toBe(true);
  });

  it('lets a tucked run reach north as far as the far wall\'s crown, and no further', () => {
    // Neither of the two answers that were tried and rejected: not a full wall height (the overlap
    // that broke the back wall's crown line) and not zero (stopping at its foot).
    const [ns] = wallJoins([NS, EW]);
    expect(ns!.tuckLiftPx).toBeCloseTo(WALL_H_PERIMETER * (1 - FACE_CROWN_FRACTION_MIN), 6);
    expect(ns!.tuckLiftPx).toBeGreaterThan(0);
    expect(ns!.tuckLiftPx).toBeLessThan(WALL_H_PERIMETER);
    // ...and the crown line is per-ELEMENT, so passing a room's own fraction changes the lift. The
    // shipped swatches disagree (ice's coping band is a third shorter than fire's), and a single
    // constant would have sliced through an ice room's crown on every corner.
    const ice = wallJoins([NS, EW], faceCrownFraction('ice'))[0]!;
    const fire = wallJoins([NS, EW], faceCrownFraction('fire'))[0]!;
    expect(faceCrownFraction('ice')).not.toBeCloseTo(faceCrownFraction('fire'), 3);
    expect(ice.tuckLiftPx).toBeGreaterThan(fire.tuckLiftPx); // a shallower crown lets it reach further
    expect(ice.crownFraction).toBeCloseTo(faceCrownFraction('ice'), 6);
    // An element with no swatch of its own falls back to the shallowest measured crown, which can
    // never cross a deeper one.
    expect(faceCrownFraction('poison')).toBe(FACE_CROWN_FRACTION_MIN);
  });

  it('takes the lift from the SHORTEST northern neighbour, whose crown has to survive', () => {
    // Two walls of different heights along one run's north edge: the run may only reach as far as
    // the LOWER crown, or it would break that wall's line while clearing the other's. An interior
    // run (70) with a perimeter wall (104) over half its north edge and another interior wall over
    // the rest — both qualify to bury it, and the interior one sets the limit.
    const inner = run(r(1504, 64, 64, 224), 'interior');
    const tall = run(r(1504, 32, 32, 32), 'perimeter');
    const equal = run(r(1536, 32, 32, 32), 'interior');
    const [ns] = wallJoins([inner, tall, equal]);
    expect(ns!.tuckNorth).toBe(true);
    expect(ns!.tuckLiftPx).toBeCloseTo(WALL_H_INTERIOR * (1 - FACE_CROWN_FRACTION_MIN), 6);
    expect(ns!.tuckLiftPx).toBeLessThan(WALL_H_PERIMETER * (1 - FACE_CROWN_FRACTION_MIN));
  });

  it('reports no lift at all when nothing tucks', () => {
    const [, ew] = wallJoins([NS, EW]);
    expect(ew!.tuckLiftPx).toBe(0);
  });

  it('refuses the tuck for a block no deeper than it is tall', () => {
    // Two parallel east-west walls stacked north-south are one mass whose top is drawn by the
    // northern one's cap — clipping the southern one's art at its own footprint would leave a hole
    // where its cap and most of its face should be. Only a run with a cap to spare may tuck.
    const shallow = run(r(1024, 64, 992, 32));
    const [s2, ew] = wallJoins([shallow, EW]);
    expect(s2!.north).toEqual([[0, 992]]); // still a merged corner...
    expect(s2!.tuckNorth).toBe(false); // ...but never a tucked one
    expect(ew!.south).toEqual([[0, 992]]);
    expect(ew!.tuckedSouth).toEqual([]);
  });

  it('refuses the tuck when only part of the run\'s width is buried', () => {
    const short = run(r(1504, 32, 32, 32)); // covers half of a 64-wide run's north edge
    const wide = run(r(1504, 64, 64, 224));
    const [, w2] = wallJoins([short, wide]);
    expect(w2!.north).toEqual([[0, 32]]);
    expect(w2!.tuckNorth).toBe(false);
  });

  it('ignores a SHORTER neighbour, because that leaves a real step', () => {
    // A room's south boundary is a 22 px kerb; the room beyond it sees a 104 px perimeter wall.
    // The perimeter wall's cap really does end above the kerb, so its coping and its depth
    // gradient have to stay — this is the same tier asymmetry `mergeWallRuns` refuses to merge.
    const kerb = run(r(1504, 288, 64, 32), 'kerb');
    const [ns] = wallJoins([NS, kerb]);
    expect(ns!.south).toEqual([]);
    // ...and from the kerb's side the tall neighbour DOES bury its north edge.
    const [, k] = wallJoins([NS, kerb]);
    expect(k!.north).toEqual([[0, 64]]);
    // ...and it tucks, which is SAFE for any block: the clip only ever removes the band
    // `[r.y - height, r.y]`, and the neighbour that authorised the tuck is by definition at least
    // that tall, so its own art always covers exactly that band. A kerb is 32 deep and 22 tall, so
    // it qualifies as "deep" — it simply stops intruding over the run standing north of it.
    expect(k!.tuckNorth).toBe(true);
  });

  it('coalesces two neighbours that meet, so a masked stroke has no hairline gap', () => {
    const a = run(r(1504, 64, 32, 224));
    const b = run(r(1536, 64, 32, 224));
    const [, , ew] = wallJoins([a, b, EW]);
    expect(ew!.tuckedSouth).toEqual([[480, 544]]);
  });

  it('finds nothing when the two rects do not actually touch', () => {
    const gap = run(r(1504, 96, 64, 224)); // 32 px south of the east-west wall
    const [ns, ew] = wallJoins([gap, EW]);
    expect(ns!.north).toEqual([]);
    expect(ns!.tuckNorth).toBe(false);
    expect(ew!.south).toEqual([]);
    expect(ew!.tuckedSouth).toEqual([]);
  });
});

describe('unjoinedSpans — the parts of an edge that still get an edge cue', () => {
  it('is the complement of the joins', () => {
    expect(unjoinedSpans(992, [[480, 544]])).toEqual([[0, 480], [544, 992]]);
  });

  it('is the whole edge when nothing joins it', () => {
    expect(unjoinedSpans(64, [])).toEqual([[0, 64]]);
  });

  it('is EMPTY when the whole edge is buried — the north-south run at a corner', () => {
    // This is the case that has to produce no stroke at all, not a zero-length one: a coping
    // highlight drawn across a continuous stone top is what made the run look pasted on.
    expect(unjoinedSpans(64, [[0, 64]])).toEqual([]);
  });
});

describe('bordersDoorNorth — a run whose north end is a door passage, not open floor', () => {
  // Live report: a door "应该是随时清晰可见" (should be clearly visible at all times) sitting
  // at the north end of a deep north-south run was half swallowed by that run's cap — exactly
  // the "door passage between two rooms" case design/01 already named without fixing.
  it('is true when a door rect sits flush against the run\'s north edge with any x-overlap', () => {
    expect(bordersDoorNorth(r(0, 64, 32, 96), [r(0, 0, 32, 64)])).toBe(true);
    // Partial x-overlap is enough — unlike a corner join, a door is a discrete fixture, not
    // another wall course whose crown must read as one continuous line.
    expect(bordersDoorNorth(r(0, 64, 32, 96), [r(16, 0, 32, 64)])).toBe(true);
  });

  it('is false when the door is elsewhere: south of the run, or not touching its north edge', () => {
    expect(bordersDoorNorth(r(0, 64, 32, 96), [r(0, 160, 32, 64)])).toBe(false); // south, not north
    expect(bordersDoorNorth(r(0, 64, 32, 96), [r(0, 0, 32, 60)])).toBe(false); // 4 px short — a gap
    expect(bordersDoorNorth(r(0, 64, 32, 96), [r(64, 0, 32, 64)])).toBe(false); // no x-overlap at all
  });

  it('is false with no doors in the room at all', () => {
    expect(bordersDoorNorth(r(0, 64, 32, 96), [])).toBe(false);
  });
});

describe('blockCapTop — doorClip', () => {
  const DOOR: WallJoins = { ...NO_JOINS, doorClip: true };

  it('clips a DEEP run\'s cap to its own footprint edge, spilling nothing onto the door', () => {
    const rect = r(0, 0, 32, 200); // deep: 200 px footprint depth, well past any wall height
    const height = WALL_H_PERIMETER;
    expect(blockCapTop(rect, height, DOOR)).toBe(-rect.h); // -200: the run's own north edge
    expect(blockCapTop(rect, height)).toBeLessThan(-rect.h); // unclipped, it would spill past it
  });

  it('clips a SHALLOW run to ZERO cap rather than leaving it unclipped (doorSpillCoverage.test.ts '
    + 'found this firing 12 times across the shipped floors, not a hypothetical case)', () => {
    const rect = r(0, 0, 32, 32); // shallower than it is tall: an ordinary wall thickness
    const height = WALL_H_PERIMETER;
    expect(blockCapTop(rect, height, DOOR)).toBe(-height); // exactly at the fold: no cap band left
    expect(blockCapTop(rect, height, DOOR)).toBeGreaterThan(blockCapTop(rect, height, NO_JOINS));
  });

  it('composes with tuckNorth by taking whichever clip spills less', () => {
    const rect = r(0, 0, 32, 200);
    const height = WALL_H_PERIMETER;
    const tuckedAndDoored: WallJoins = { ...NO_JOINS, tuckNorth: true, tuckLiftPx: 10, doorClip: true };
    // doorClip (lift 0) is the tighter of the two, so it wins over the tuck's lift-10 reach.
    expect(blockCapTop(rect, height, tuckedAndDoored)).toBe(-rect.h);
  });
});

describe('effectiveWallHeight — the FACE half of the doorClip fix (doorSpillCoverage.test.ts)', () => {
  const DOOR: WallJoins = { ...NO_JOINS, doorClip: true };

  it('shrinks a SHALLOW run\'s height to its own footprint depth, so the face stops spilling too', () => {
    const rect = r(0, 0, 32, 32); // shallower than PERIMETER: an ordinary wall thickness
    expect(effectiveWallHeight(rect, WALL_H_PERIMETER, DOOR)).toBe(32);
  });

  it('leaves a DEEP run\'s height unchanged — the face never spilled for it in the first place', () => {
    const rect = r(0, 0, 32, 200);
    expect(effectiveWallHeight(rect, WALL_H_PERIMETER, DOOR)).toBe(WALL_H_PERIMETER);
  });

  it('is a no-op with no doorClip at all, regardless of depth', () => {
    const shallow = r(0, 0, 32, 32);
    expect(effectiveWallHeight(shallow, WALL_H_PERIMETER, NO_JOINS)).toBe(WALL_H_PERIMETER);
    expect(effectiveWallHeight(shallow, WALL_H_PERIMETER)).toBe(WALL_H_PERIMETER); // default param
  });

  it('composes with blockCapTop so the cap always resolves to exactly the footprint\'s own edge', () => {
    // Once `height` is this function's own result, `blockCapTop`'s doorClip branch must always
    // land on `-r.h` — face and cap agreeing on the same flush edge, not by coincidence.
    for (const rect of [r(0, 0, 32, 32), r(0, 0, 32, 96), r(0, 0, 32, 200)]) {
      const height = effectiveWallHeight(rect, WALL_H_PERIMETER, DOOR);
      expect(blockCapTop(rect, height, DOOR)).toBe(-rect.h);
    }
  });
});
