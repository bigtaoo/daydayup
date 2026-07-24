/**
 * Dungeon mode wired live (design/05/09, ROADMAP 1.3). SpawnSystem generates each
 * floor's room sequence from a RoomPiece library and traverses it room-by-room,
 * swapping collision geometry / world bounds / spawns per room; ExtractionSystem's
 * descend generates the next floor. All of this is a no-op unless EngineConfig.dungeon
 * is set (additive, no ENGINE_VERSION bump — see config.ts's note), so these tests
 * cover both the dungeon behaviour and the non-dungeon regression.
 *
 * Verified through the full createGameEngine pipeline (the "screenshots time out, drive
 * the engine headlessly" convention), plus a few targeted state pokes where forcing a
 * room clear via real combat would only add noise.
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { hashState } from '@dd/engine/replay';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { Button } from '@dd/engine/state/commands';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import { toFpGrid } from '@dd/engine/content/convert';
import type { RoomPiece } from '@dd/engine/content/rooms';
import type { DungeonConfig } from '@dd/engine/world/dungeon';
import { EMBER_DUNGEON, EMBER_ROOMS } from '@dd/engine/world/rooms/ember';

// A tiny, fully-controlled library. Two normal pieces (distinct geometry, NO enemies →
// they clear the instant they load, so a floor auto-advances to its capstone with no
// combat), an empty extraction capstone, and a boss capstone (also enemy-free here so
// the plumbing tests never need to win a fight). Grid units, like every RoomPiece.
const TEST_LIB: RoomPiece[] = [
  {
    id: 't_hall',
    tags: ['t'],
    sizeGrid: { w: 20, h: 16 },
    solids: [{ x: 5, y: 5, w: 2, h: 2 }],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] },
    exits: [{ edge: 'east' }],
  },
  {
    id: 't_pillars',
    tags: ['t'],
    sizeGrid: { w: 24, h: 12 },
    solids: [],
    pillars: [{ center: { x: 12, y: 6 }, radius: 1 }],
    spawns: { player: [{ x: 2, y: 6 }], enemy: [] },
    exits: [{ edge: 'east' }],
  },
  {
    id: 't_extract',
    role: 'extraction',
    sizeGrid: { w: 10, h: 10 },
    solids: [],
    spawns: { player: [{ x: 5, y: 8 }], enemy: [] },
    exits: [{ edge: 'west' }],
  },
  {
    id: 't_boss',
    role: 'boss',
    sizeGrid: { w: 22, h: 18 },
    solids: [],
    spawns: { player: [{ x: 11, y: 16 }], enemy: [] },
    exits: [{ edge: 'west' }],
  },
];

// min=max=2 → every floor is exactly [1 normal, capstone]. Two floors: floor 0's
// capstone is the extraction room, floor 1 (the last) is the boss room.
const TEST_DUN: DungeonConfig = {
  biomeId: 't',
  nameKey: 't',
  floorCount: 2,
  roomsPerFloor: { min: 2, max: 2 },
  pieceTags: ['t'],
  layout: 'linear',
  extractionPieceId: 't_extract',
  bossPieceId: 't_boss',
  difficultyCurve: { base: 1, perFloor: 1 },
};

const DUN_CFG: EngineConfig = {
  seed: 7,
  worldW: 640, // placeholder — each room resizes the world as it loads
  worldH: 640,
  waves: [],
  dungeon: { config: TEST_DUN, library: TEST_LIB },
};

const idle = (tick: number) =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons: 0 });
const interact = (tick: number) =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons: Button.INTERACT });

describe('Dungeon mode — no-op unless a `dungeon` config is provided', () => {
  it('a plain config never enters a room, never draws roomgenPrng, keeps its static geometry', () => {
    const cfg: EngineConfig = {
      seed: 1, worldW: 800, worldH: 600, playerStart: [400, 300],
      waves: [[[600, 300]]],
      walls: [[100, 100, 64, 64]],
    };
    const eng = createGameEngine(cfg);
    const wallsBefore = eng.state.walls.length;
    const roomgenBefore = eng.state.roomgenPrng.peek();
    for (let t = 1; t <= 20; t++) eng.step([idle(t)]);
    expect(eng.state.dungeonEnabled).toBe(false);
    expect(eng.state.roomIndex).toBe(-1); // never loaded a room
    expect(eng.state.walls.length).toBe(wallsBefore); // config geometry untouched
    expect(eng.state.roomgenPrng.peek()).toBe(roomgenBefore); // no dungeon draws
  });
});

describe('Dungeon mode — floor 0, room 0 loads live geometry', () => {
  it('generates the floor and swaps in the first room’s walls, bounds, player spawn, and event', () => {
    const eng = createGameEngine(DUN_CFG);
    const events = eng.step([idle(1)]);
    const s = eng.state;

    expect(s.dungeonEnabled).toBe(true);
    expect(s.floorsEnabled).toBe(true); // dungeon enables the extraction loop
    expect(s.floorLayout.length).toBe(2); // [1 normal, capstone]
    expect(s.roomIndex).toBe(0);

    const room0 = s.floorLayout[0]!;
    expect(room0.role).toBeUndefined(); // a normal room, not the capstone
    // Geometry swapped in from the room (roomGeometry).
    expect(s.walls.length).toBe(room0.solids.length);
    expect(s.obstacles.length).toBe(room0.pillars?.length ?? 0);
    // World resized to the room.
    expect(s.worldW).toBe(toFpGrid(room0.sizeGrid.w));
    expect(s.worldH).toBe(toFpGrid(room0.sizeGrid.h));
    // Player teleported onto the room's spawn point.
    const ps = room0.spawns.player[0]!;
    expect(s.players[0]!.gx).toBe(toFpGrid(ps.x));
    expect(s.players[0]!.gy).toBe(toFpGrid(ps.y));
    // room_enter announced for the render layer.
    expect(events.some((e) => e.type === 'room_enter' && e.roomIndex === 0 && e.roomId === room0.id)).toBe(true);
  });
});

describe('Dungeon mode — a cleared room advances to the next, geometry swapping each time', () => {
  it('auto-advances through an enemy-free normal room into the extraction capstone', () => {
    const eng = createGameEngine(DUN_CFG);
    const s = eng.state;

    eng.step([idle(1)]); // load room 0 (normal, no enemies)
    expect(s.roomIndex).toBe(0);
    const normalWorldW = s.worldW;

    const events = eng.step([idle(2)]); // room 0 cleared (empty) → advance to capstone
    expect(s.roomIndex).toBe(1);
    expect(s.floorLayout[1]!.role).toBe('extraction');
    expect(s.worldW).toBe(toFpGrid(s.floorLayout[1]!.sizeGrid.w)); // bounds followed the room
    expect(s.worldW).not.toBe(normalWorldW); // ...and actually changed
    expect(events.some((e) => e.type === 'room_enter' && e.roomIndex === 1)).toBe(true);

    eng.step([idle(3)]); // capstone (no enemies) → checkpoint
    expect(s.wavesExhausted).toBe(true);
    expect(s.phase).not.toBe('gameover'); // a non-last floor waits for the extract gesture
  });
});

describe('Dungeon mode — DESCEND generates the next floor', () => {
  it('a tap at the floor-0 checkpoint banks, advances the floor index, and regenerates', () => {
    const eng = createGameEngine(DUN_CFG);
    const s = eng.state;
    s.floorMaterials.mat_fire = 2; // pretend we picked up some material this floor

    eng.step([idle(1)]); // room 0
    eng.step([idle(2)]); // capstone
    eng.step([idle(3)]); // checkpoint (wavesExhausted)
    expect(s.wavesExhausted).toBe(true);

    eng.step([interact(4)]); // hold one tick
    expect(s.extractHoldTicks).toBe(1);
    eng.step([idle(5)]); // release before the threshold → DESCEND
    expect(s.floorIndex).toBe(1);
    expect(s.roomIndex).toBe(-1); // marked for regeneration
    expect(s.bankedMaterials.mat_fire).toBe(2); // floor buffer banked
    expect(s.phase).not.toBe('gameover');

    eng.step([idle(6)]); // SpawnSystem generates floor 1 and loads its first room
    expect(s.roomIndex).toBe(0);
    expect(s.floorLayout.length).toBe(2);
    expect(s.floorLayout[1]!.role).toBe('boss'); // floor 1 is the last → boss capstone
  });
});

describe('Dungeon mode — the last floor auto-extracts (no descend option)', () => {
  it('clearing the deepest floor’s capstone ends the run as a win', () => {
    const eng = createGameEngine(DUN_CFG);
    const s = eng.state;
    // Floor 0 → descend to floor 1.
    eng.step([idle(1)]);
    eng.step([idle(2)]);
    eng.step([idle(3)]);
    eng.step([interact(4)]);
    eng.step([idle(5)]);
    // Floor 1 (last): normal → boss capstone (enemy-free in TEST_LIB) → auto-extract.
    for (let t = 6; t <= 12 && s.phase !== 'gameover'; t++) eng.step([idle(t)]);
    expect(s.floorIndex).toBe(1);
    expect(s.phase).toBe('gameover');
    expect(s.winner).toBe(0);
  });
});

describe('Dungeon mode — a room does not advance while enemies remain', () => {
  it('holds on a room until it is cleared', () => {
    // A one-floor dungeon whose only normal room spawns an enemy; the run must sit on
    // room 0 until that enemy is gone, then advance to the (enemy-free) boss capstone.
    const lib: RoomPiece[] = [
      {
        id: 'guard', tags: ['g'], sizeGrid: { w: 20, h: 16 }, solids: [],
        spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] }, exits: [],
      },
      {
        id: 'g_boss', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
        spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [],
      },
    ];
    const cfg: EngineConfig = {
      seed: 3, worldW: 640, worldH: 640, waves: [],
      dungeon: {
        config: {
          biomeId: 'g', nameKey: 'g', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
          pieceTags: ['g'], layout: 'linear', extractionPieceId: 'g_boss', bossPieceId: 'g_boss',
          difficultyCurve: { base: 1, perFloor: 0 },
        },
        library: lib,
      },
    };
    const eng = createGameEngine(cfg);
    const s = eng.state;

    eng.step([idle(1)]); // load room 0 — spawns the guard
    expect(s.roomIndex).toBe(0);
    expect(s.enemies.length).toBe(1);
    for (let t = 2; t <= 10; t++) eng.step([idle(t)]);
    expect(s.roomIndex).toBe(0); // still room 0 — the guard blocks the advance
    expect(s.phase).not.toBe('gameover');

    s.enemies.length = 0; // simulate the guard dying (combat is exercised elsewhere)
    eng.step([idle(11)]);
    expect(s.roomIndex).toBe(1); // now it advances to the boss capstone
  });
});

describe('Dungeon mode — determinism', () => {
  it('two engines on the same seed pick the same rooms and stay byte-equal every tick', () => {
    const a = createGameEngine(DUN_CFG);
    const b = createGameEngine(DUN_CFG);
    for (let t = 1; t <= 40; t++) {
      a.step([idle(t)]);
      b.step([idle(t)]);
      expect(hashState(b.state)).toBe(hashState(a.state));
    }
    expect(a.state.floorLayout.map((r) => r.id)).toEqual(b.state.floorLayout.map((r) => r.id));
  });
});

describe('Dungeon mode — the real Ember biome runs end-to-end', () => {
  it('generates + traverses EMBER_DUNGEON floors without throwing, geometry always populated', () => {
    const eng = createGameEngine({
      seed: 0xda1d, worldW: 1600, worldH: 1200, waves: [],
      dungeon: { config: EMBER_DUNGEON, library: EMBER_ROOMS },
    });
    const s = eng.state;
    eng.step([idle(1)]); // first Ember room loads
    expect(s.floorLayout.length).toBeGreaterThanOrEqual(EMBER_DUNGEON.roomsPerFloor.min);
    expect(s.roomIndex).toBe(0);
    // The world was resized to an actual Ember room (not the placeholder config bounds).
    expect(s.worldW).toBe(toFpGrid(s.floorLayout[0]!.sizeGrid.w));
    // Drive a while; every loaded room must have consistent bounds vs its geometry.
    for (let t = 2; t <= 60; t++) {
      eng.step([idle(t)]);
      expect(s.worldW).toBe(toFpGrid(s.floorLayout[s.roomIndex]!.sizeGrid.w));
    }
  });
});
