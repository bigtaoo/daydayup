import { describe, it, expect } from 'vitest';
import type { RoomPiece, DungeonFloorMap } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { validateRoomPiece, validateArenaMap, validateDungeonFloorMap } from './validate';

function makeRoom(overrides: Partial<RoomPiece> = {}): RoomPiece {
  return {
    id: 'room_a',
    sizeGrid: { w: 10, h: 10 },
    solids: [],
    spawns: { player: [{ x: 1, y: 1 }], enemy: [] },
    exits: [],
    ...overrides,
  };
}

describe('validateRoomPiece', () => {
  it('accepts a minimal valid room', () => {
    expect(validateRoomPiece(makeRoom())).toEqual([]);
  });

  it('rejects an empty id', () => {
    const issues = validateRoomPiece(makeRoom({ id: '' }));
    expect(issues.some((i) => i.message.includes('non-empty id'))).toBe(true);
  });

  it('rejects a non-positive sizeGrid', () => {
    const issues = validateRoomPiece(makeRoom({ sizeGrid: { w: 0, h: 10 } }));
    expect(issues.some((i) => i.message.includes('sizeGrid'))).toBe(true);
  });

  it('rejects zero player spawns', () => {
    const issues = validateRoomPiece(makeRoom({ spawns: { player: [], enemy: [] } }));
    expect(issues.some((i) => i.message.includes('player spawn'))).toBe(true);
  });

  it('rejects an out-of-range encounter spawnPoint', () => {
    const room = makeRoom({
      spawns: { player: [{ x: 1, y: 1 }], enemy: [{ x: 5, y: 5 }] },
      encounter: { entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 3, count: 1 }] },
    });
    const issues = validateRoomPiece(room);
    expect(issues.some((i) => i.message.includes('no matching enemy spawn'))).toBe(true);
  });

  it('accepts an in-range encounter spawnPoint', () => {
    const room = makeRoom({
      spawns: { player: [{ x: 1, y: 1 }], enemy: [{ x: 5, y: 5 }] },
      encounter: { entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 0, count: 1 }] },
    });
    expect(validateRoomPiece(room)).toEqual([]);
  });
});

function makeArena(overrides: Partial<ArenaMap> = {}): ArenaMap {
  return {
    id: 'arena_1',
    sizeGrid: { w: 100, h: 100 },
    rooms: [],
    doors: [],
    spawns: [],
    eyeCandidates: [],
    ...overrides,
  };
}

describe('validateArenaMap', () => {
  it('accepts a minimal valid map', () => {
    expect(validateArenaMap(makeArena())).toEqual([]);
  });

  it('rejects duplicate room ids', () => {
    const map = makeArena({
      rooms: [
        { id: 'r1', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
        { id: 'r1', rectGrid: { x: 20, y: 0, w: 10, h: 10 }, solids: [] },
      ],
    });
    const issues = validateArenaMap(map);
    expect(issues.some((i) => i.message.includes('Duplicate room id'))).toBe(true);
  });

  it('rejects overlapping rooms', () => {
    const map = makeArena({
      rooms: [
        { id: 'r1', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
        { id: 'r2', rectGrid: { x: 5, y: 5, w: 10, h: 10 }, solids: [] },
      ],
    });
    const issues = validateArenaMap(map);
    expect(issues.some((i) => i.message.includes('overlap'))).toBe(true);
  });

  it('accepts two rooms that only share a boundary edge', () => {
    const map = makeArena({
      rooms: [
        { id: 'r1', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
        { id: 'r2', rectGrid: { x: 10, y: 0, w: 10, h: 10 }, solids: [] },
      ],
      doors: [{ roomA: 'r1', roomB: 'r2', passageGrid: { x: 10, y: 3, w: 1, h: 4 } }],
    });
    expect(validateArenaMap(map)).toEqual([]);
  });

  it('rejects a door referencing an unknown room', () => {
    const map = makeArena({
      rooms: [{ id: 'r1', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
      doors: [{ roomA: 'r1', roomB: 'ghost', passageGrid: { x: 10, y: 3, w: 1, h: 4 } }],
    });
    const issues = validateArenaMap(map);
    expect(issues.some((i) => i.message.includes('unknown room "ghost"'))).toBe(true);
  });

  it('rejects an eye candidate referencing an unknown room', () => {
    const map = makeArena({
      rooms: [{ id: 'r1', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
      eyeCandidates: [{ roomId: 'ghost' }],
    });
    const issues = validateArenaMap(map);
    expect(issues.some((i) => i.message.includes('Eye candidate'))).toBe(true);
  });

  it('rejects an out-of-range per-room encounter spawnPoint', () => {
    const map = makeArena({
      rooms: [
        {
          id: 'r1',
          rectGrid: { x: 0, y: 0, w: 10, h: 10 },
          solids: [],
          spawns: [{ x: 1, y: 1 }],
          encounter: { entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 2, count: 1 }] },
        },
      ],
    });
    const issues = validateArenaMap(map);
    expect(issues.some((i) => i.message.includes('no matching enemy spawn'))).toBe(true);
  });
});

function makePiece(id: string, w: number, h: number, role?: 'extraction' | 'boss'): RoomPiece {
  return {
    id,
    sizeGrid: { w, h },
    solids: [],
    spawns: { player: [{ x: 1, y: 1 }], enemy: [] },
    exits: [],
    ...(role ? { role } : {}),
  };
}

const FLOOR_LIB: RoomPiece[] = [makePiece('start', 10, 10), makePiece('end', 10, 10, 'extraction')];

function makeFloor(overrides: Partial<DungeonFloorMap> = {}): DungeonFloorMap {
  return {
    id: 'floor_1',
    rooms: [
      { id: 'a', pieceId: 'start', offsetXGrid: 0, offsetYGrid: 0 },
      { id: 'b', pieceId: 'end', offsetXGrid: 10, offsetYGrid: 0 },
    ],
    doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 3, w: 1, h: 4 } }],
    ...overrides,
  };
}

describe('validateDungeonFloorMap (design/05 "Hand-authored PvE floors", 2026-08-05)', () => {
  it('accepts a minimal valid floor', () => {
    expect(validateDungeonFloorMap(makeFloor(), FLOOR_LIB)).toEqual([]);
  });

  it('rejects an empty rooms list', () => {
    const issues = validateDungeonFloorMap({ id: 'f', rooms: [], doors: [] }, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('at least one room'))).toBe(true);
  });

  it('rejects duplicate room ids', () => {
    const map = makeFloor({
      rooms: [
        { id: 'a', pieceId: 'start', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'a', pieceId: 'end', offsetXGrid: 20, offsetYGrid: 0 },
      ],
      doors: [],
    });
    const issues = validateDungeonFloorMap(map, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('Duplicate room id'))).toBe(true);
  });

  it('rejects a room referencing an unknown piece', () => {
    const map = makeFloor({ rooms: [{ id: 'a', pieceId: 'ghost', offsetXGrid: 0, offsetYGrid: 0 }], doors: [] });
    const issues = validateDungeonFloorMap(map, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('unknown piece "ghost"'))).toBe(true);
  });

  it('rejects overlapping rooms', () => {
    const map = makeFloor({
      rooms: [
        { id: 'a', pieceId: 'start', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'end', offsetXGrid: 5, offsetYGrid: 5 },
      ],
      doors: [],
    });
    const issues = validateDungeonFloorMap(map, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('overlap'))).toBe(true);
  });

  it('accepts two rooms that only share a boundary edge', () => {
    expect(validateDungeonFloorMap(makeFloor(), FLOOR_LIB)).toEqual([]);
  });

  it('rejects a door referencing an unknown room', () => {
    const map = makeFloor({ doors: [{ roomA: 'a', roomB: 'ghost', passageGrid: { x: 10, y: 3, w: 1, h: 4 } }] });
    const issues = validateDungeonFloorMap(map, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('unknown room "ghost"'))).toBe(true);
  });

  it('rejects a door whose passageGrid does not sit on a real shared wall', () => {
    const map = makeFloor({ doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 3, y: 3, w: 1, h: 4 } }] }); // not near the shared boundary (x=10)
    const issues = validateDungeonFloorMap(map, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('does not sit on a real shared wall'))).toBe(true);
  });

  // A half-cell passage is not a cosmetic slip: `carveDoorGaps` cuts a
  // correspondingly misaligned hole and the tail of the wall run past it inherits
  // the offset as its own DEPTH. Four wall runs in shipped level-1 content stood
  // 16 px deep that way, under a 104 px-tall perimeter run, before
  // `ENGINE_VERSION` 44. The door tool only ever produces whole cells; this is the
  // gate on a value typed into the Inspector's numeric passageGrid fields by hand.
  it('rejects a door whose passageGrid lands on a half cell', () => {
    const map = makeFloor({ doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 3.5, w: 1, h: 4 } }] });
    const issues = validateDungeonFloorMap(map, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('off the grid'))).toBe(true);
  });

  it('rejects a door whose passageGrid has a zero or fractional extent', () => {
    for (const bad of [{ w: 0, h: 4 }, { w: 1.5, h: 4 }, { w: 1, h: 0 }]) {
      const map = makeFloor({ doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 3, ...bad } }] });
      const issues = validateDungeonFloorMap(map, FLOOR_LIB);
      expect(issues.some((i) => i.message.includes('off the grid')), JSON.stringify(bad)).toBe(true);
    }
  });

  it('rejects a room unreachable from the entrance room (rooms[0]) via the door graph', () => {
    const map = makeFloor({
      rooms: [
        { id: 'a', pieceId: 'start', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'end', offsetXGrid: 10, offsetYGrid: 0 },
        { id: 'c', pieceId: 'start', offsetXGrid: 100, offsetYGrid: 100 }, // never connected by any door
      ],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 3, w: 1, h: 4 } }],
    });
    const issues = validateDungeonFloorMap(map, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('not reachable'))).toBe(true);
  });

  it('rejects a floor whose last room is not an extraction/boss piece', () => {
    const map = makeFloor({
      rooms: [
        { id: 'a', pieceId: 'start', offsetXGrid: 0, offsetYGrid: 0 },
        { id: 'b', pieceId: 'start', offsetXGrid: 10, offsetYGrid: 0 }, // last room, but 'start' has no role
      ],
      doors: [{ roomA: 'a', roomB: 'b', passageGrid: { x: 10, y: 3, w: 1, h: 4 } }],
    });
    const issues = validateDungeonFloorMap(map, FLOOR_LIB);
    expect(issues.some((i) => i.message.includes('must use an extraction/boss'))).toBe(true);
  });
});
