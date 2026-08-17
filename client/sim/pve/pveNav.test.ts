/**
 * pveNav.ts — the level simulator bot's room-graph navigation helpers. Driven against
 * hand-built `GameState`-shaped fixtures rather than a real engine run: these are pure
 * readers of the co-resident room/door state, and a fixture makes the graph shapes
 * (a chain, a fork, an unreachable room) explicit instead of hoping a generated floor
 * happens to contain them.
 */
import { describe, expect, it } from 'vitest';
import type { GameState } from '@dd/engine';
import { adjacency, bfsPath, capstoneRoomId, doorCentre, pointInRect, rectCentre, roomIdAt, roomRect, roomRuntime } from './pveNav';

interface FakeRoomSpec {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  activated?: boolean;
  hasLiveEnemy?: boolean;
}

/** Minimal stand-in for the six `dungeon*` fields these helpers read. Cast once, here,
 *  so no test body has to repeat it. */
function fakeState(rooms: FakeRoomSpec[], doors: [string, string][]): GameState {
  const s = {
    dungeonRooms: rooms.map((r) => ({ id: r.id })),
    dungeonRoomRects: rooms.map((r) => ({ id: r.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h } })),
    dungeonRoomRuntime: rooms.map((r) => ({
      activated: r.activated ?? true,
      roomTick: 0,
      schedule: [],
      cursor: 0,
      hasLiveEnemy: r.hasLiveEnemy ?? false,
    })),
    dungeonRoomIndexById: new Map(rooms.map((r, i) => [r.id, i] as const)),
    dungeonDoors: doors.map(([a, b], i) => ({
      door: { roomA: a, roomB: b, passageGrid: { x: 0, y: 0, w: 0, h: 0 } },
      // Passage rect is placed distinctly per door so `doorCentre` can be told apart.
      passageAabb: { x: 100 + i * 10, y: 200 + i * 10, w: 4, h: 2 },
      locked: false,
    })),
  };
  return s as unknown as GameState;
}

const CHAIN = () =>
  fakeState(
    [
      { id: 'a', x: 0, y: 0, w: 10, h: 10 },
      { id: 'b', x: 10, y: 0, w: 10, h: 10 },
      { id: 'c', x: 20, y: 0, w: 10, h: 10 },
    ],
    [
      ['a', 'b'],
      ['b', 'c'],
    ],
  );

describe('rectCentre / pointInRect', () => {
  it('centres a rect and treats its edges as inside', () => {
    expect(rectCentre({ x: 10, y: 20, w: 4, h: 8 })).toEqual({ x: 12, y: 24 });
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(pointInRect(0, 0, r)).toBe(true);
    expect(pointInRect(10, 10, r)).toBe(true);
    expect(pointInRect(10.1, 5, r)).toBe(false);
    expect(pointInRect(-0.1, 5, r)).toBe(false);
  });
});

describe('roomIdAt / roomRect / roomRuntime', () => {
  it('finds the room containing a point, and reports undefined outside every room', () => {
    const s = CHAIN();
    expect(roomIdAt(s, 5, 5)).toBe('a');
    expect(roomIdAt(s, 15, 5)).toBe('b');
    expect(roomIdAt(s, 100, 100)).toBeUndefined();
  });

  it('resolves ties by array order — the engine’s own room-order determinism convention', () => {
    // Adjacent rects share an edge, so the shared line is genuinely in both.
    expect(roomIdAt(CHAIN(), 10, 5)).toBe('a');
  });

  it('reads a rect and a runtime row by id, undefined for an unknown id', () => {
    const s = CHAIN();
    expect(roomRect(s, 'c')).toEqual({ x: 20, y: 0, w: 10, h: 10 });
    expect(roomRect(s, 'nope')).toBeUndefined();
    expect(roomRuntime(s, 'b')?.activated).toBe(true);
    expect(roomRuntime(s, 'nope')).toBeUndefined();
  });
});

describe('capstoneRoomId', () => {
  it('is the LAST placed room — the same single-index convention ExtractionSystem uses', () => {
    expect(capstoneRoomId(CHAIN())).toBe('c');
  });

  it('is undefined before a floor has been placed', () => {
    expect(capstoneRoomId(fakeState([], []))).toBeUndefined();
  });
});

describe('adjacency / doorCentre', () => {
  it('links both directions of every door', () => {
    const adj = adjacency(CHAIN());
    expect(adj.get('a')).toEqual(['b']);
    expect(adj.get('b')).toEqual(['a', 'c']);
    expect(adj.get('c')).toEqual(['b']);
  });

  it('has no entry for a room with no doors at all', () => {
    const s = fakeState([{ id: 'lonely', x: 0, y: 0, w: 5, h: 5 }], []);
    expect(adjacency(s).get('lonely')).toBeUndefined();
  });

  it('returns the passage centre for either argument order, undefined for a non-adjacent pair', () => {
    const s = CHAIN();
    expect(doorCentre(s, 'a', 'b')).toEqual({ x: 102, y: 201 });
    expect(doorCentre(s, 'b', 'a')).toEqual({ x: 102, y: 201 });
    expect(doorCentre(s, 'b', 'c')).toEqual({ x: 112, y: 211 });
    expect(doorCentre(s, 'a', 'c')).toBeUndefined();
  });
});

describe('bfsPath', () => {
  it('returns just the start when the start itself is the goal', () => {
    expect(bfsPath(CHAIN(), 'a', (id) => id === 'a')).toEqual(['a']);
  });

  it('returns the full inclusive path to the nearest goal', () => {
    expect(bfsPath(CHAIN(), 'a', (id) => id === 'c')).toEqual(['a', 'b', 'c']);
  });

  it('finds the NEAREST goal when several qualify, not just any', () => {
    const s = fakeState(
      [
        { id: 'a', x: 0, y: 0, w: 10, h: 10 },
        { id: 'b', x: 10, y: 0, w: 10, h: 10 },
        { id: 'c', x: 20, y: 0, w: 10, h: 10 },
      ],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    expect(bfsPath(s, 'a', (id) => id === 'b' || id === 'c')).toEqual(['a', 'b']);
  });

  it('is null when no reachable room qualifies', () => {
    expect(bfsPath(CHAIN(), 'a', (id) => id === 'nowhere')).toBeNull();
  });

  it('is null for a goal that exists but sits in a disconnected component', () => {
    const s = fakeState(
      [
        { id: 'a', x: 0, y: 0, w: 10, h: 10 },
        { id: 'island', x: 50, y: 50, w: 10, h: 10 },
      ],
      [],
    );
    expect(bfsPath(s, 'a', (id) => id === 'island')).toBeNull();
  });

  it('terminates on a cycle instead of revisiting rooms forever', () => {
    const s = fakeState(
      [
        { id: 'a', x: 0, y: 0, w: 10, h: 10 },
        { id: 'b', x: 10, y: 0, w: 10, h: 10 },
        { id: 'c', x: 20, y: 0, w: 10, h: 10 },
      ],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
      ],
    );
    // Both a→b→c and a→c reach 'c'; BFS must take the one-hop route.
    expect(bfsPath(s, 'a', (id) => id === 'c')).toEqual(['a', 'c']);
  });
});
