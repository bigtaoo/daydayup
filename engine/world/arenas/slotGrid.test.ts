/** slotGrid: the wall arithmetic under the launch arena's hand-drawn plan. Tested directly
 *  because it is where an off-by-one becomes a room you can walk out of — the exact class of
 *  defect the previous arena shipped, and one that assembled content hides well. */
import { describe, it, expect } from 'vitest';
import { doorBetween, facingSide, gridExtent, perimeterSolids, slotRects, type Rect } from './slotGrid';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe('slotRects', () => {
  it('lays columns and rows end to end from the origin', () => {
    const rects = slotRects({ x: 2, y: 3 }, [10, 4], [5, 6, 7]);
    expect(rects).toHaveLength(3);
    expect(rects[0]).toEqual([rect(2, 3, 10, 5), rect(12, 3, 4, 5)]);
    expect(rects[1]).toEqual([rect(2, 8, 10, 6), rect(12, 8, 4, 6)]);
    expect(rects[2]).toEqual([rect(2, 14, 10, 7), rect(12, 14, 4, 7)]);
  });

  it('makes horizontal and vertical neighbours FLUSH — no gap to slip through', () => {
    const rects = slotRects({ x: 0, y: 0 }, [8, 12], [9, 5]);
    const a = rects[0]![0]!;
    const east = rects[0]![1]!;
    const south = rects[1]![0]!;
    expect(a.x + a.w).toBe(east.x);
    expect(a.y + a.h).toBe(south.y);
  });
});

describe('gridExtent', () => {
  it('covers the whole grid plus the origin margin on both sides', () => {
    expect(gridExtent({ x: 2, y: 3 }, [10, 4], [5, 6], 2)).toEqual({ w: 18, h: 16 });
  });
});

describe('facingSide', () => {
  const a = rect(10, 10, 10, 10);

  it('names the side a flush neighbour is on', () => {
    expect(facingSide(a, rect(20, 10, 6, 10))).toBe('east');
    expect(facingSide(a, rect(4, 10, 6, 10))).toBe('west');
    expect(facingSide(a, rect(10, 20, 10, 6))).toBe('south');
    expect(facingSide(a, rect(10, 4, 10, 6))).toBe('north');
  });

  it('rejects a diagonal, a gap and an overlap', () => {
    expect(facingSide(a, rect(20, 20, 6, 6))).toBeNull(); // diagonal
    expect(facingSide(a, rect(22, 10, 6, 10))).toBeNull(); // 2-cell gap
    expect(facingSide(a, rect(15, 15, 10, 10))).toBeNull(); // overlapping
  });
});

describe('doorBetween', () => {
  const west = rect(0, 0, 10, 12);
  const east = rect(10, 0, 10, 12);

  it('spans BOTH rooms wall columns, so one passage is one hole in two walls', () => {
    const door = doorBetween(west, east, 3)!;
    expect(door.passageGrid.w).toBe(2);
    expect(door.passageGrid.x).toBe(9); // west's last column and east's first
    expect(door.passageGrid.h).toBe(3);
  });

  it('carves the matching opening out of each room, in ROOM-RELATIVE coordinates', () => {
    const door = doorBetween(west, east, 3)!;
    expect(door.openingA.side).toBe('east');
    expect(door.openingB.side).toBe('west');
    expect(door.openingA.from).toBe(door.passageGrid.y - west.y);
    expect(door.openingB.from).toBe(door.passageGrid.y - east.y);
    expect(door.openingA.span).toBe(3);
  });

  it('keeps the opening clear of both corners', () => {
    // A 12-tall shared edge with a 3-wide door: rows 1..10 are usable, so the gap can never
    // start at row 0 or end at row 11 — a corner gap would open a diagonal sightline and
    // leave a zero-length wall run.
    for (let bias = -6; bias <= 6; bias++) {
      const door = doorBetween(west, east, 3, bias)!;
      expect(door.openingA.from).toBeGreaterThanOrEqual(1);
      expect(door.openingA.from + door.openingA.span).toBeLessThanOrEqual(11);
    }
  });

  it('shifts the opening by bias, within those bounds', () => {
    const centred = doorBetween(west, east, 3, 0)!;
    const shifted = doorBetween(west, east, 3, 2)!;
    expect(shifted.passageGrid.y).toBe(centred.passageGrid.y + 2);
  });

  it('narrows a door that will not fit rather than overflowing the shared edge', () => {
    const tiny = rect(10, 0, 10, 5);
    const door = doorBetween(rect(0, 0, 10, 5), tiny, 9)!;
    expect(door.openingA.span).toBeLessThanOrEqual(3);
    expect(door.openingA.from).toBeGreaterThanOrEqual(1);
  });

  it('runs the other axis for a north/south pair', () => {
    const north = rect(0, 0, 12, 10);
    const south = rect(0, 10, 12, 10);
    const door = doorBetween(north, south, 4)!;
    expect(door.passageGrid.h).toBe(2);
    expect(door.passageGrid.y).toBe(9);
    expect(door.passageGrid.w).toBe(4);
    expect(door.openingA.side).toBe('south');
    expect(door.openingB.side).toBe('north');
  });

  it('returns null for rooms that are not flush neighbours', () => {
    expect(doorBetween(west, rect(30, 0, 10, 12), 3)).toBeNull();
  });
});

describe('perimeterSolids', () => {
  const room = rect(0, 0, 8, 6);

  /** Every cell the returned solids cover, as "x,y". */
  function cells(solids: readonly { x: number; y: number; w: number; h: number }[]): Set<string> {
    const out = new Set<string>();
    for (const s of solids) {
      for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) out.add(`${x},${y}`);
    }
    return out;
  }

  it('walls the whole ring when there are no openings', () => {
    const covered = cells(perimeterSolids(room, []));
    expect(covered.size).toBe(2 * 8 + 2 * (6 - 2)); // 24 boundary cells
    for (let x = 0; x < 8; x++) {
      expect(covered.has(`${x},0`)).toBe(true);
      expect(covered.has(`${x},5`)).toBe(true);
    }
    for (let y = 1; y < 5; y++) {
      expect(covered.has(`0,${y}`)).toBe(true);
      expect(covered.has(`7,${y}`)).toBe(true);
    }
  });

  it('never overlaps two solids at a corner — a doubled cell skews every cover metric', () => {
    const solids = perimeterSolids(room, []);
    const area = solids.reduce((sum, s) => sum + s.w * s.h, 0);
    expect(area).toBe(cells(solids).size);
  });

  it('leaves exactly the opening open, and nothing else', () => {
    const covered = cells(perimeterSolids(room, [{ side: 'north', from: 3, span: 2 }]));
    expect(covered.has('3,0')).toBe(false);
    expect(covered.has('4,0')).toBe(false);
    expect(covered.has('2,0')).toBe(true);
    expect(covered.has('5,0')).toBe(true);
    expect(covered.size).toBe(24 - 2);
  });

  it('handles two openings on the same side', () => {
    const covered = cells(perimeterSolids(rect(0, 0, 12, 6), [
      { side: 'south', from: 2, span: 2 },
      { side: 'south', from: 7, span: 2 },
    ]));
    for (const x of [2, 3, 7, 8]) expect(covered.has(`${x},5`)).toBe(false);
    for (const x of [1, 4, 6, 9]) expect(covered.has(`${x},5`)).toBe(true);
  });

  it('carves a west/east opening without disturbing the north and south runs', () => {
    const covered = cells(perimeterSolids(room, [{ side: 'west', from: 2, span: 2 }]));
    expect(covered.has('0,2')).toBe(false);
    expect(covered.has('0,3')).toBe(false);
    expect(covered.has('0,1')).toBe(true);
    expect(covered.has('0,4')).toBe(true);
    // The corner cells belong to the north/south runs and stay stone.
    expect(covered.has('0,0')).toBe(true);
    expect(covered.has('0,5')).toBe(true);
  });

  it('drops a vertical run entirely when the opening covers every interior row', () => {
    const covered = cells(perimeterSolids(room, [{ side: 'east', from: 1, span: 4 }]));
    for (let y = 1; y < 5; y++) expect(covered.has(`7,${y}`)).toBe(false);
    expect(covered.has('7,0')).toBe(true); // still the north run's corner
  });
});
