/** measureArena: pure static metrics over an ArenaMap (see arenaMetrics.ts's doc comment
 *  for why structural validity and design quality are different claims). Synthetic maps for
 *  the mechanisms, plus one case driven by the REAL shipped map so the suite is not blind to
 *  a schema the fixtures happen to agree with. */
import { describe, it, expect } from 'vitest';
import { measureArena } from './arenaMetrics';
import type { ArenaMap, ArenaRoom } from './arenas';
import arenaPrototype60 from '../../world/arenas/arena_prototype_60.json';

/** A 10x10 room at (x, y) with nothing in it. */
function room(id: string, x: number, y: number, extra: Partial<ArenaRoom> = {}): ArenaRoom {
  return { id, rectGrid: { x, y, w: 10, h: 10 }, solids: [], ...extra };
}

function map(rooms: ArenaRoom[], doors: [string, string][], extra: Partial<ArenaMap> = {}): ArenaMap {
  return {
    id: 'test',
    sizeGrid: { w: 100, h: 100 },
    rooms,
    doors: doors.map(([roomA, roomB]) => ({ roomA, roomB, passageGrid: { x: 0, y: 0, w: 1, h: 1 } })),
    spawns: [],
    eyeCandidates: [],
    ...extra,
  };
}

describe('variety — the "stamped, not authored" measurement', () => {
  // ROOM-RELATIVE is the engine's convention (only `rectGrid` is absolute — see
  // buildArenaRoomRects). Two rooms furnished the same way therefore carry the SAME
  // numbers regardless of where they sit, and the metric must not subtract the offset.
  it('counts two identically-furnished rooms at DIFFERENT offsets as one interior', () => {
    const furnish: Partial<ArenaRoom> = { pillars: [{ center: { x: 5, y: 5 }, radius: 1 }] };
    const m = measureArena(map([room('a', 0, 0, furnish), room('b', 20, 20, furnish)], [['a', 'b']]));
    expect(m.interiors).toEqual({ rooms: 2, distinct: 1, dominantShare: 1 });
  });

  // The distinction the first version of this module got wrong, and that its fixture agreed
  // with: a map authoring these as ABSOLUTE is internally consistent and visibly uniform,
  // but every room's numbers differ. `interiors` must report that honestly (2 distinct),
  // while `interiorShapes` still recognises one repeated arrangement.
  it('separates "same numbers" from "same shape" when a map authors absolute coordinates', () => {
    const absolute = (x: number, y: number): Partial<ArenaRoom> => ({
      pillars: [{ center: { x: x + 5, y: y + 5 }, radius: 1 }],
    });
    const m = measureArena(
      map([room('a', 0, 0, absolute(0, 0)), room('b', 20, 20, absolute(20, 20))], [['a', 'b']]),
    );
    expect(m.interiors.distinct).toBe(2);
    expect(m.interiorShapes.distinct).toBe(1);
  });

  it('interiorShapes still separates genuinely different arrangements', () => {
    const m = measureArena(
      map(
        [
          room('a', 0, 0, { pillars: [{ center: { x: 5, y: 5 }, radius: 1 }] }),
          room('b', 20, 0, { pillars: [{ center: { x: 1, y: 1 }, radius: 1 }, { center: { x: 8, y: 8 }, radius: 1 }] }),
        ],
        [['a', 'b']],
      ),
    );
    expect(m.interiorShapes.distinct).toBe(2);
  });

  // The counterweight: without it the test above would also pass if `interiorKey` returned a
  // constant, which is exactly the "the fixture made two different things equal" failure.
  it('counts differently-furnished rooms as distinct interiors', () => {
    const m = measureArena(
      map(
        [
          room('a', 0, 0, { pillars: [{ center: { x: 5, y: 5 }, radius: 1 }] }),
          room('b', 20, 20, { pillars: [{ center: { x: 22, y: 21 }, radius: 1 }] }),
        ],
        [['a', 'b']],
      ),
    );
    expect(m.interiors.distinct).toBe(2);
    expect(m.interiors.dominantShare).toBe(0.5);
  });

  it('ignores authoring ORDER — the same two pillars listed the other way round is one variant', () => {
    const p = (x: number, y: number) => ({ center: { x, y }, radius: 1 });
    const m = measureArena(
      map(
        [
          room('a', 0, 0, { pillars: [p(2, 2), p(7, 7)] }),
          room('b', 20, 0, { pillars: [p(7, 7), p(2, 2)] }),
        ],
        [['a', 'b']],
      ),
    );
    expect(m.interiors.distinct).toBe(1);
  });

  it('reports a room with no feature as absent, not as a variant', () => {
    const m = measureArena(map([room('a', 0, 0), room('b', 20, 0)], [['a', 'b']]));
    expect(m.interiors).toEqual({ rooms: 0, distinct: 0, dominantShare: 0 });
    expect(m.lootLayouts.rooms).toBe(0);
  });

  it('tallies loot tables and hazard kinds across every room', () => {
    const m = measureArena(
      map(
        [
          room('a', 0, 0, { lootMarkers: [{ point: { x: 2, y: 2 }, tableId: 'common' }] }),
          room('b', 20, 0, {
            lootMarkers: [{ point: { x: 22, y: 2 }, tableId: 'rare' }],
            cellTraits: [{ id: 't', rectGrid: { x: 21, y: 1, w: 1, h: 1 }, kind: 'spike', timed: false }],
          }),
        ],
        [['a', 'b']],
      ),
    );
    expect(m.lootTables).toEqual({ common: 1, rare: 1 });
    expect(m.traitKinds).toEqual({ spike: 1 });
  });
});

describe('cover', () => {
  it('separates "no walls" from "no cover at all" — a pillar is cover, and is not a wall', () => {
    const m = measureArena(
      map(
        [room('bare', 0, 0), room('pillared', 20, 0, { pillars: [{ center: { x: 25, y: 5 }, radius: 1 }] })],
        [['bare', 'pillared']],
      ),
    );
    expect(m.cover.roomsWithNoCover).toEqual(['bare']);
    expect(m.cover.roomsWithNoWalls).toEqual(['bare', 'pillared']);
    expect(m.cover.totalPillars).toBe(1);
    expect(m.cover.totalSolids).toBe(0);
  });

  it('reports cover as a fraction of the room own footprint, ascending', () => {
    const m = measureArena(
      map(
        [room('empty', 0, 0), room('walled', 20, 0, { solids: [{ x: 21, y: 1, w: 5, h: 4 }] })],
        [['empty', 'walled']],
      ),
    );
    // 5x4 of a 10x10 room = 20%; the empty room contributes the 0 that sorts first.
    expect(m.cover.coverFractions).toEqual([0, 0.2]);
  });
});

describe('door graph', () => {
  //   a - b - c
  //       |
  //       d
  const star = () => map([room('a', 0, 0), room('b', 20, 0), room('c', 40, 0), room('d', 20, 20)],
    [['a', 'b'], ['b', 'c'], ['b', 'd']]);

  it('histograms degree and names the dead ends', () => {
    const g = measureArena(star()).graph;
    expect(g.degreeHistogram).toEqual({ 1: 3, 3: 1 });
    expect(g.deadEnds).toEqual(['a', 'c', 'd']);
    expect(g.isolated).toEqual([]);
  });

  it('finds the chokepoint — the one room whose removal splits the map', () => {
    expect(measureArena(star()).graph.chokepoints).toEqual(['b']);
  });

  // The star above never exercises Tarjan's ROOT rule: its DFS starts at `rooms[0]` = the
  // leaf 'a', so the hub is found by the ordinary non-root test. Listing the hub FIRST makes
  // it the root, where "cut vertex" is decided by child count instead — a mutation battery
  // found this hole by leaving the root rule survivable.
  it('finds a chokepoint that is also the traversal root (rooms[0])', () => {
    const rootHub = map([room('b', 20, 0), room('a', 0, 0), room('c', 40, 0), room('d', 20, 20)],
      [['a', 'b'], ['b', 'c'], ['b', 'd']]);
    expect(measureArena(rootHub).graph.chokepoints).toEqual(['b']);
  });

  it('a cycle has no chokepoint at all', () => {
    const ring = map([room('a', 0, 0), room('b', 20, 0), room('c', 40, 0)],
      [['a', 'b'], ['b', 'c'], ['c', 'a']]);
    expect(measureArena(ring).graph.chokepoints).toEqual([]);
    expect(measureArena(ring).graph.diameter).toBe(1);
  });

  it('measures the diameter in door hops, not in grid distance', () => {
    // Four rooms in a line, each 20 grid units apart: 3 hops end to end.
    const line = map([room('a', 0, 0), room('b', 20, 0), room('c', 40, 0), room('d', 60, 0)],
      [['a', 'b'], ['b', 'c'], ['c', 'd']]);
    expect(measureArena(line).graph.diameter).toBe(3);
  });

  it('reports a disconnected map as disconnected, with an infinite diameter', () => {
    const split = map([room('a', 0, 0), room('b', 20, 0), room('c', 40, 0)], [['a', 'b']]);
    const g = measureArena(split).graph;
    expect(g.connected).toBe(false);
    expect(g.diameter).toBe(Infinity);
    expect(g.isolated).toEqual(['c']);
  });

  // design/15's load-bearing rule: adjacency is the doors, never inferred from rect
  // proximity. Two rooms that touch but have no door between them are NOT adjacent.
  it('never infers adjacency from touching rects', () => {
    const touching = map([room('a', 0, 0), room('b', 10, 0)], []);
    expect(measureArena(touching).graph.isolated).toEqual(['a', 'b']);
  });
});

describe('spawns', () => {
  const two = (spawns: { x: number; y: number }[]) =>
    measureArena(
      map([room('a', 0, 0), room('b', 20, 0), room('c', 40, 0)], [['a', 'b'], ['b', 'c']], { spawns }),
    ).spawns;

  it('resolves each spawn to the room whose rect contains it', () => {
    const s = two([{ x: 5, y: 5 }, { x: 45, y: 5 }]);
    expect(s.rooms).toEqual(['a', 'c']);
    expect(s.orphans).toBe(0);
    expect(s.minPairHops).toBe(2);
    expect(s.maxPairHops).toBe(2);
  });

  it('counts a spawn that lands outside every room as an orphan', () => {
    const s = two([{ x: 5, y: 5 }, { x: 15, y: 5 }]);
    expect(s.rooms).toEqual(['a', null]);
    expect(s.orphans).toBe(1);
  });

  it('counts two spawns sharing a room, and reports them 0 hops apart', () => {
    const s = two([{ x: 2, y: 2 }, { x: 8, y: 8 }]);
    expect(s.colliding).toBe(2);
    expect(s.minPairHops).toBe(0);
  });

  it('membership is half-open — a point on the shared border belongs to exactly one room', () => {
    const s = two([{ x: 10, y: 0 }, { x: 9, y: 0 }]);
    expect(s.rooms).toEqual([null, 'a']); // x=10 is past room a's far edge, and b starts at 20
  });
});

describe('zone reach', () => {
  it('measures the furthest room from its NEAREST eye candidate, not from a single one', () => {
    // a - b - c - d, candidates at both ends: every room is at most 1 hop from one.
    const m = measureArena(
      map([room('a', 0, 0), room('b', 20, 0), room('c', 40, 0), room('d', 60, 0)],
        [['a', 'b'], ['b', 'c'], ['c', 'd']],
        { eyeCandidates: [{ roomId: 'a' }, { roomId: 'd' }] }),
    );
    expect(m.eyeCandidates).toBe(2);
    expect(m.maxHopsToEye).toBe(1);
  });

  it('excludes a weight-0 candidate — design/15: it can never be drawn as final', () => {
    const m = measureArena(
      map([room('a', 0, 0), room('b', 20, 0)], [['a', 'b']],
        { eyeCandidates: [{ roomId: 'a', weight: 0 }, { roomId: 'b' }] }),
    );
    expect(m.eyeCandidates).toBe(1);
    expect(m.maxHopsToEye).toBe(1);
  });
});

/**
 * One case driven by the REAL shipped map rather than a fixture. Every test above agrees
 * with a map this file wrote, so all of them would still pass if the JSON's schema and this
 * module's reader had drifted apart. These are the audit's headline findings — the evidence
 * that `arena_prototype_60` is a generated placeholder, pinned so that the map replacing it
 * has to move them.
 */
describe('the shipped arena_prototype_60', () => {
  const m = measureArena(arenaPrototype60 as ArenaMap);

  it('is measurable at all: 60 connected rooms with real doors', () => {
    expect(m.roomCount).toBe(60);
    expect(m.doorCount).toBeGreaterThan(0);
    expect(m.graph.connected).toBe(true);
    expect(m.graph.isolated).toEqual([]);
  });

  // The signature of a map whose pillars and loot markers were authored as ABSOLUTE
  // coordinates: one shape, sixty different sets of numbers for it. `interiors.distinct === 1`
  // (what the first version of this module reported) would have hidden the defect behind the
  // correct-sounding "one room stamped 60 times" headline.
  it('is one SHAPE stamped 60 times, at 60 different sets of coordinates', () => {
    expect(m.footprints.distinct).toBe(1);
    expect(m.interiorShapes.distinct).toBe(1);
    expect(m.interiors.distinct).toBe(60);
    expect(m.interiors.rooms).toBe(60);
    expect(m.lootLayouts.distinct).toBe(60);
    expect(m.lootTables).toEqual({ arena_common: 60 });
  });

  it('has no wall runs anywhere — every room cover is one pillar', () => {
    expect(m.cover.totalSolids).toBe(0);
    expect(m.cover.roomsWithNoWalls).toHaveLength(60);
    expect(m.cover.totalPillars).toBe(60);
    // Flat across the map: the min and the max are the same number.
    expect(m.cover.coverFractions[0]).toBeCloseTo(m.cover.coverFractions[59]!, 10);
  });

  it('drops its 8 seats at wildly unequal separations', () => {
    expect(m.spawns.count).toBe(8);
    expect(m.spawns.orphans).toBe(0);
    expect(m.spawns.colliding).toBe(0);
    expect(m.spawns.maxPairHops).toBeGreaterThan(m.spawns.minPairHops * 2);
  });
});
