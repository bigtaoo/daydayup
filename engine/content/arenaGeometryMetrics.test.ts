/** measurePlacement / measureEnclosure: where an ArenaMap's content actually lands, and
 *  whether its rooms and doors physically exist. Synthetic maps for the mechanisms.
 *
 *  Both were first pointed at `arena_prototype_60`, where they found two defects no variety
 *  metric could see (every pillar and loot marker authored in the wrong coordinate space, and
 *  `solids: []` everywhere so no room or door physically existed). That map was retired
 *  2026-08-26 along with the block pinning those numbers — every defect it exhibited has a
 *  fixture above, and the real-content case now runs against the map that ships, in
 *  `world/arenas/launchArena.test.ts`. */
import { describe, it, expect } from 'vitest';
import { measureEnclosure, measurePlacement, solidCellSet } from './arenaGeometryMetrics';
import type { ArenaMap, ArenaRoom } from './arenas';

function room(id: string, x: number, y: number, extra: Partial<ArenaRoom> = {}): ArenaRoom {
  return { id, rectGrid: { x, y, w: 10, h: 10 }, solids: [], ...extra };
}

function map(rooms: ArenaRoom[], doors: [string, string][] = [], extra: Partial<ArenaMap> = {}): ArenaMap {
  return {
    id: 'test',
    sizeGrid: { w: 100, h: 100 },
    rooms,
    doors: doors.map(([roomA, roomB]) => ({ roomA, roomB, passageGrid: { x: 10, y: 4, w: 10, h: 2 } })),
    spawns: [],
    eyeCandidates: [],
    ...extra,
  };
}

describe('measurePlacement', () => {
  it('accepts a feature authored ROOM-RELATIVE — the engine convention', () => {
    const p = measurePlacement(
      map([
        room('a', 20, 20, {
          pillars: [{ center: { x: 5, y: 5 }, radius: 1 }],
          lootMarkers: [{ point: { x: 2, y: 8 }, tableId: 't' }],
          spawns: [{ x: 9, y: 9, type: 'basic' }],
          cellTraits: [{ id: 'x', rectGrid: { x: 1, y: 1, w: 1, h: 1 }, kind: 'spike', timed: false }],
        }),
      ]),
    );
    expect(p.outsideOwnRoom).toEqual([]);
    expect(p.byFeature.pillar).toEqual({ authored: 1, misplaced: 0 });
    expect(p.byFeature.loot).toEqual({ authored: 1, misplaced: 0 });
    expect(p.byFeature.enemySpawn).toEqual({ authored: 1, misplaced: 0 });
    expect(p.byFeature.trait).toEqual({ authored: 1, misplaced: 0 });
  });

  it('flags a feature authored ABSOLUTE — the offset lands it outside its own room', () => {
    // A room at (20,20) whose pillar is written as the absolute centre (25,25): the engine
    // adds the room offset again, so it ends up at (45,45) — a room away.
    const p = measurePlacement(map([room('a', 20, 20, { pillars: [{ center: { x: 25, y: 25 }, radius: 1 }] })]));
    expect(p.byFeature.pillar).toEqual({ authored: 1, misplaced: 1 });
    expect(p.outsideOwnRoom[0]).toEqual({ room: 'a', feature: 'pillar', at: { x: 45, y: 45 }, offMap: false });
  });

  it('separates "outside its room" from "off the map entirely"', () => {
    const p = measurePlacement(
      map([room('a', 90, 90, { pillars: [{ center: { x: 95, y: 95 }, radius: 1 }] })], [], {
        sizeGrid: { w: 100, h: 100 },
      }),
    );
    expect(p.outsideOwnRoom).toHaveLength(1);
    expect(p.offMap).toHaveLength(1);
    expect(p.offMap[0]!.at).toEqual({ x: 185, y: 185 });
  });

  it('reports each feature list independently — one wrong convention does not implicate the rest', () => {
    const p = measurePlacement(
      map([
        room('a', 20, 20, {
          pillars: [{ center: { x: 25, y: 25 }, radius: 1 }], // absolute — wrong
          spawns: [{ x: 5, y: 5, type: 'basic' }], // relative — right
        }),
      ]),
    );
    expect(p.byFeature.pillar.misplaced).toBe(1);
    expect(p.byFeature.enemySpawn.misplaced).toBe(0);
  });

  // Half-open containment, same rule as room membership: a feature landing exactly ON the
  // room's far edge is OUTSIDE it. An inclusive test here would silently accept a whole
  // column of off-by-one placements.
  it('treats a feature on the room far edge as outside it', () => {
    const p = measurePlacement(map([room('a', 0, 0, { pillars: [{ center: { x: 10, y: 5 }, radius: 1 }] })]));
    expect(p.byFeature.pillar.misplaced).toBe(1);
    const inside = measurePlacement(map([room('a', 0, 0, { pillars: [{ center: { x: 9, y: 5 }, radius: 1 }] })]));
    expect(inside.byFeature.pillar.misplaced).toBe(0);
  });

  it('counts nothing when a room authors nothing', () => {
    const p = measurePlacement(map([room('a', 0, 0)]));
    expect(p.outsideOwnRoom).toEqual([]);
    expect(p.byFeature.pillar.authored).toBe(0);
  });
});

describe('solidCellSet', () => {
  it('expands every solid rect to cells at the room offset', () => {
    const cells = solidCellSet(map([room('a', 20, 20, { solids: [{ x: 1, y: 1, w: 2, h: 3 }] })]));
    expect(cells.size).toBe(6);
    expect(cells.has('21,21')).toBe(true);
    expect(cells.has('22,23')).toBe(true);
    expect(cells.has('23,21')).toBe(false); // w=2 covers x 21..22 only
  });
});

describe('measureEnclosure', () => {
  /** A room with a full perimeter wall ring authored room-relative. */
  function walled(id: string, x: number, y: number): ArenaRoom {
    return {
      id,
      rectGrid: { x, y, w: 10, h: 10 },
      solids: [
        { x: 0, y: 0, w: 10, h: 1 },
        { x: 0, y: 9, w: 10, h: 1 },
        { x: 0, y: 1, w: 1, h: 8 },
        { x: 9, y: 1, w: 1, h: 8 },
      ],
    };
  }

  it('reports a map with no solids as entirely unenclosed, every door gating nothing', () => {
    const e = measureEnclosure(map([room('a', 0, 0), room('b', 20, 0)], [['a', 'b']]));
    expect(e.solidCells).toBe(0);
    expect(e.unenclosedRooms).toEqual(['a', 'b']);
    expect(e.perimeterCoverage).toEqual([0, 0]);
    expect(e.doorsWithoutWalls).toBe(1);
  });

  it('reports a fully-walled room as 100% perimeter coverage', () => {
    const e = measureEnclosure(map([walled('a', 20, 20)]));
    expect(e.unenclosedRooms).toEqual([]);
    expect(e.perimeterCoverage).toEqual([1]);
  });

  it('counts a door as real once a wall stands beside its passage', () => {
    const e = measureEnclosure(map([walled('a', 0, 0), walled('b', 20, 0)], [['a', 'b']]));
    expect(e.doorsWithoutWalls).toBe(0);
  });

  describe('undoored walk-throughs', () => {
    it('counts a facing pair with no wall and no door', () => {
      const e = measureEnclosure(map([room('a', 0, 0), room('b', 20, 0)]));
      expect(e.undoorLeaks).toBe(1);
    });

    it('does not count a pair that HAS a door', () => {
      const e = measureEnclosure(map([room('a', 0, 0), room('b', 20, 0)], [['a', 'b']]));
      expect(e.undoorLeaks).toBe(0);
    });

    it('does not count a pair walled off from each other', () => {
      const e = measureEnclosure(map([walled('a', 0, 0), walled('b', 20, 0)]));
      expect(e.undoorLeaks).toBe(0);
    });

    it('does not count a pair that only shares a diagonal corner', () => {
      const e = measureEnclosure(map([room('a', 0, 0), room('b', 20, 20)]));
      expect(e.undoorLeaks).toBe(0);
    });

    // Without this, an open map counts every aligned pair across its whole width as a leak,
    // and the number stops meaning "these two rooms are neighbours".
    it('does not count a distant pair with another room standing between them', () => {
      const e = measureEnclosure(map([room('a', 0, 0), room('b', 20, 0), room('c', 40, 0)]));
      expect(e.undoorLeaks).toBe(2); // a-b and b-c, never a-c
    });

    it('a wall on only ONE of the two facing edges is still enough to close the corridor', () => {
      const oneSided = room('a', 0, 0, { solids: [{ x: 9, y: 0, w: 1, h: 10 }] });
      const e = measureEnclosure(map([oneSided, room('b', 20, 0)]));
      expect(e.undoorLeaks).toBe(0);
    });

    // Everything above is an EAST-WEST pair, which exercises only one of the two corridor
    // branches. A mutation battery left three mutants alive in the NORTH-SOUTH branch — the
    // occlusion guard, the facing-edge scan and nothing else covering them — so each case
    // above has a vertical twin here.
    it('counts a vertically facing pair with no wall and no door', () => {
      const e = measureEnclosure(map([room('a', 0, 0), room('b', 0, 20)]));
      expect(e.undoorLeaks).toBe(1);
    });

    it('does not count a vertical pair walled off from each other', () => {
      const e = measureEnclosure(map([walled('a', 0, 0), walled('b', 0, 20)]));
      expect(e.undoorLeaks).toBe(0);
    });

    it('does not count a distant vertical pair with a room standing between them', () => {
      const e = measureEnclosure(map([room('a', 0, 0), room('b', 0, 20), room('c', 0, 40)]));
      expect(e.undoorLeaks).toBe(2);
    });

    it('a wall on the SOUTH edge alone closes a north-south corridor', () => {
      const oneSided = room('a', 0, 0, { solids: [{ x: 0, y: 9, w: 10, h: 1 }] });
      const e = measureEnclosure(map([oneSided, room('b', 0, 20)]));
      expect(e.undoorLeaks).toBe(0);
    });

    it('a wall covering only PART of the corridor still leaves a leak', () => {
      const partial = room('a', 0, 0, { solids: [{ x: 9, y: 0, w: 1, h: 5 }] });
      const e = measureEnclosure(map([partial, room('b', 20, 0)]));
      expect(e.undoorLeaks).toBe(1);
    });
  });
});
