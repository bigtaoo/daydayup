import { describe, it, expect } from 'vitest';
import type { RoomPiece } from '@dd/engine';
import type { ArenaMap } from '@dd/engine/content/arenas';
import { validateRoomPiece, validateArenaMap } from './validate';

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
