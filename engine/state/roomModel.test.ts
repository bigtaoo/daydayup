// The two halves of the 2026-08-27 room-model unification (see `roomModel.ts`'s header):
// the CONFIG invariant that dungeon mode and arena mode are alternatives, which until now
// lived only in two doc comments on `EngineConfig`, and the single selector that every
// consumer of the two room-rect lists reads.
//
// The consumers keep their own tests, and those are what prove the selector is actually
// wired: `controllers/GameLoop.test.ts` ("prefers the DUNGEON list when a state carries
// both") and `scene/groundLayer.test.ts` ("room identity prefers dungeon rooms, then arena
// rooms, then the world itself") both hand a hand-built both-populated state to their own
// call site and pin the answer. Reversing the ternary in `roomModel` fails both — which is
// the point of there being one ternary: the 2026-08-27 mutation battery that started this
// found `cameraFrame`'s own copy of it unread, and reversing THAT passed all 3,310 client
// tests because the fixtures could not tell the two copies apart.
import { describe, it, expect } from 'vitest';
import { createGameState, type EngineConfig } from '@dd/engine/state/GameState';
import { toFp } from '@dd/engine/math/fixed';
import { roomModel, roomRects, type RoomRect } from '@dd/engine/state/roomModel';
import type { ArenaMap } from '@dd/engine/content/arenas';
import type { RoomPiece } from '@dd/engine/content/rooms';

const FLAT: EngineConfig = { seed: 7, worldW: 800, worldH: 600, waves: [] };

const ARENA: ArenaMap = {
  id: 'mini',
  sizeGrid: { w: 10, h: 10 },
  rooms: [{ id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] }],
  doors: [],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

const PIECE: RoomPiece = {
  id: 'rm_only',
  tags: ['rm'],
  role: 'boss',
  sizeGrid: { w: 20, h: 16 },
  solids: [],
  spawns: { player: [{ x: 2, y: 8 }], enemy: [] },
  exits: [],
};

const DUNGEON: NonNullable<EngineConfig['dungeon']> = {
  config: {
    biomeId: 'rm',
    nameKey: 'rm',
    floorCount: 1,
    roomsPerFloor: { min: 1, max: 1 },
    pieceTags: ['rm'],
    layout: 'linear',
    extractionPieceId: 'rm_only',
    bossPieceId: 'rm_only',
    difficultyCurve: { base: 1, perFloor: 0 },
  },
  library: [PIECE],
};

const rect = (x: number): RoomRect => ({
  id: `r${x}`,
  rect: { x: toFp(x), y: toFp(0), w: toFp(1), h: toFp(1) },
});

describe('EngineConfig — dungeon and arena are mutually exclusive room models', () => {
  it('rejects a config carrying both, at construction', () => {
    // Both of them override the flat `walls`/`obstacles`/`worldW`/`worldH` fields, and each
    // one's own doc comment has called the other an ALTERNATIVE since it was added — but
    // until 2026-08-27 nothing checked, and three call sites had already drifted into two
    // different rules for picking between the two room-rect lists such a state would carry.
    expect(() => createGameState({ ...FLAT, arena: ARENA, dungeon: DUNGEON })).toThrow(
      /mutually exclusive/,
    );
  });

  it('accepts either one alone, and a config with neither', () => {
    // The guard's control: it must be the COMBINATION that throws, not the presence of
    // either field. All three of these are shipped shapes (`match/pvpConfig.ts`,
    // `match/offlineConfig.ts`, and the tutorial respectively).
    expect(createGameState({ ...FLAT, arena: ARENA }).zoneEnabled).toBe(true);
    expect(createGameState({ ...FLAT, dungeon: DUNGEON }).dungeonEnabled).toBe(true);
    const flat = createGameState(FLAT);
    expect([flat.zoneEnabled, flat.dungeonEnabled]).toEqual([false, false]);
  });

  it('an arena state populates exactly one of the two room-rect lists, and a dungeon state neither until its floor places', () => {
    // What makes the selector below single-valued in practice. The dungeon half is the
    // "generate a fresh floor" sentinel (`SpawnSystem` fills the list on its first tick,
    // `ExtractionSystem` empties it again on DESCEND), so `'none'` is a state a real
    // dungeon run passes through, not just a flat config's permanent condition.
    const arena = createGameState({ ...FLAT, arena: ARENA });
    expect(arena.arenaRoomRects).toHaveLength(1);
    expect(arena.dungeonRoomRects).toHaveLength(0);

    const dungeon = createGameState({ ...FLAT, dungeon: DUNGEON });
    expect(dungeon.dungeonRoomRects).toHaveLength(0);
    expect(dungeon.arenaRoomRects).toHaveLength(0);
  });
});

describe('roomModel — the one rule for picking between the two room-rect lists', () => {
  it('reports the arena when only the arena list has rooms', () => {
    const m = roomModel({ arenaRoomRects: [rect(1)], dungeonRoomRects: [] });
    expect(m.kind).toBe('arena');
    expect(m.rects).toEqual([rect(1)]);
  });

  it('reports the dungeon when only the dungeon list has rooms', () => {
    const m = roomModel({ arenaRoomRects: [], dungeonRoomRects: [rect(2)] });
    expect(m.kind).toBe('dungeon');
    expect(m.rects).toEqual([rect(2)]);
  });

  it("reports 'none' with no rooms — a flat config, and a dungeon between floors", () => {
    const m = roomModel({ arenaRoomRects: [], dungeonRoomRects: [] });
    expect(m.kind).toBe('none');
    expect(m.rects).toEqual([]);
    // The kind, not just an empty list: `groundLayer.floorRegionsPx` branches on it, and
    // 'none' is the branch that falls back to the whole world rather than to a flood fill.
  });

  it('gives ONE answer for a state hand-built past the config guard, rather than one per consumer', () => {
    // Unreachable through any config now, but this is the shape the divergence lived in, and
    // it is the shape both consumers' own tests use (they cannot build a real dungeon+arena
    // state either). Dungeon wins — the precedence both client call sites already had.
    const both = { arenaRoomRects: [rect(3)], dungeonRoomRects: [rect(4)] };
    expect(roomModel(both).kind).toBe('dungeon');
    expect(roomRects(both)).toEqual([rect(4)]);
  });

  it("hands back the state's own arrays, not copies — the lists are re-pushed in place every floor", () => {
    // `dungeonRoomRects` is `readonly` in the REFERENCE sense only (same convention as
    // `walls`/`obstacles`): a floor transition clears and re-pushes it. A selector that
    // copied would hand a caller that cached its result a stale floor.
    const s = createGameState({ ...FLAT, dungeon: DUNGEON });
    s.dungeonRoomRects.push(rect(5));
    expect(roomRects(s)).toBe(s.dungeonRoomRects);
    s.dungeonRoomRects.length = 0;
    expect(roomModel(s).kind).toBe('none');
  });
});
