/**
 * DoorSystem — the co-resident PvE room/door model's lock/unlock + force-regroup
 * mechanics (design/05 "Room & door model", 2026-08-04). `dungeonrun.test.ts`
 * already covers the SpawnSystem/ExtractionSystem-visible surface of this (a locked
 * room holding the checkpoint back, a door's lock reacting to live-enemy count in
 * real time); this file is the dedicated, more exhaustive coverage of DoorSystem
 * itself — the general per-door lock formula, a real physical-collision check (not
 * just the flag), the softlock-prevention regression, and force-regroup's player
 * targeting (excludes downed, excludes the trigger, no-ops solo).
 */
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '@dd/engine/GameEngine';
import { MovementSystem } from '@dd/engine/systems';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { makeCommand } from '@dd/engine/state/input';
import type { Brad } from '@dd/engine/math/trig';
import type { Fp } from '@dd/engine/math/fixed';
import { toFpGrid } from '@dd/engine/content/convert';
import type { RoomPiece } from '@dd/engine/content/rooms';
import type { DungeonConfig } from '@dd/engine/world/dungeon';

const idle = (owner: number, tick: number) =>
  makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

// A 3-room linear chain: two normal pieces (one with an enemy, one without — which
// lands in which position is left to the seed, deliberately, since the property under
// test — "a door locks iff EITHER side it touches has a live enemy" — holds regardless
// of the assignment) plus an enemy-free capstone.
const NORMAL_QUIET: RoomPiece = {
  id: 'quiet', tags: ['3r'], sizeGrid: { w: 20, h: 16 }, solids: [],
  spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }, { edge: 'east' }],
};
const NORMAL_GUARDED: RoomPiece = {
  id: 'guarded', tags: ['3r'], sizeGrid: { w: 20, h: 16 }, solids: [],
  spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] },
  exits: [{ edge: 'west' }, { edge: 'east' }],
};
const CAPSTONE: RoomPiece = {
  id: 'cap', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
  spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
};
const THREE_ROOM_DUN: DungeonConfig = {
  biomeId: '3r', nameKey: '3r', floorCount: 1, roomsPerFloor: { min: 3, max: 3 },
  pieceTags: ['3r'], layout: 'linear', extractionPieceId: 'cap', bossPieceId: 'cap',
  difficultyCurve: { base: 1, perFloor: 0 },
};
const cfg = (seed: number, players?: EngineConfig['players']): EngineConfig => ({
  seed, worldW: 640, worldH: 640, waves: [],
  players,
  dungeon: { config: THREE_ROOM_DUN, library: [NORMAL_QUIET, NORMAL_GUARDED, CAPSTONE] },
});

describe('DoorSystem — a door locks iff EITHER room it touches has a live enemy', () => {
  it('holds for every door in a 3-room floor, regardless of which room drew the enemy', () => {
    const eng = createGameEngine(cfg(13));
    const s = eng.state;
    eng.step([idle(0, 1)]); // floor places (3 rooms, 2 doors)
    for (let t = 2; t <= 6; t++) eng.step([idle(0, t)]); // let every reachable-from-room0 activation settle

    // Regardless of activation reach, the formula itself must hold for every door,
    // computed directly from each side's own hasLiveEnemy — not assumed.
    for (const dr of s.dungeonDoors) {
      const aIdx = s.dungeonRoomIndexById.get(dr.door.roomA)!;
      const bIdx = s.dungeonRoomIndexById.get(dr.door.roomB)!;
      const expected = s.dungeonRoomRuntime[aIdx]!.hasLiveEnemy || s.dungeonRoomRuntime[bIdx]!.hasLiveEnemy;
      expect(dr.locked).toBe(expected);
    }
    // At least one room actually has a live enemy in this run (the point of the test).
    expect(s.dungeonRoomRuntime.some((rt) => rt.hasLiveEnemy)).toBe(true);
  });
});

describe('DoorSystem — a locked door is a REAL physical blocker, not just a flag', () => {
  const GUARD_ROOM: RoomPiece = {
    id: 'g', tags: ['g'], sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] }, exits: [{ edge: 'east' }],
  };
  const BOSS_ROOM: RoomPiece = {
    id: 'gb', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
  };
  const GUARD_DUN: DungeonConfig = {
    biomeId: 'g', nameKey: 'g', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
    pieceTags: ['g'], layout: 'linear', extractionPieceId: 'gb', bossPieceId: 'gb',
    difficultyCurve: { base: 1, perFloor: 0 },
  };
  const GUARD_CFG: EngineConfig = { seed: 9, worldW: 640, worldH: 640, waves: [], dungeon: { config: GUARD_DUN, library: [GUARD_ROOM, BOSS_ROOM] } };

  it('a player overlapping the passage gets pushed out while locked; the same point is open once cleared', () => {
    const eng = createGameEngine(GUARD_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]); // floor places
    eng.step([idle(0, 2)]); // room 0 activates → guard spawns → door locks
    expect(s.dungeonDoors[0]!.locked).toBe(true);

    const passage = s.dungeonDoors[0]!.passageAabb;
    const centerX = (passage.x + passage.w / 2) as Fp;
    const centerY = (passage.y + passage.h / 2) as Fp;
    s.players[0]!.gx = centerX;
    s.players[0]!.gy = centerY;
    new MovementSystem().tick(s);
    expect(s.players[0]!.gx === centerX && s.players[0]!.gy === centerY).toBe(false); // pushed off the blocking rect

    s.enemies.length = 0; // clear the guard
    eng.step([idle(0, 3)]); // DoorSystem sees zero live enemies → unlocks (removes the blocking rect)
    expect(s.dungeonDoors[0]!.locked).toBe(false);

    s.players[0]!.gx = centerX;
    s.players[0]!.gy = centerY;
    new MovementSystem().tick(s);
    expect(s.players[0]!.gx).toBe(centerX); // no wall there anymore — free to stand in the doorway
    expect(s.players[0]!.gy).toBe(centerY);
  });

  it('never re-locks once cleared, even across many idle ticks (nothing ever respawns into a cleared room)', () => {
    const eng = createGameEngine(GUARD_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]);
    eng.step([idle(0, 2)]); // guard spawns, door locks
    s.enemies.length = 0;
    eng.step([idle(0, 3)]); // unlocks
    for (let t = 4; t <= 50; t++) eng.step([idle(0, t)]);
    expect(s.dungeonDoors[0]!.locked).toBe(false);
    expect(s.dungeonRoomRuntime[0]!.hasLiveEnemy).toBe(false);
    expect(s.enemies.length).toBe(0);
  });

  it('is never found already-locked the very first tick a room is reached (the softlock regression)', () => {
    // Activation and locking are computed from the SAME hasLiveEnemy snapshot, on the
    // same tick — so the tick a player's roomId first matches an about-to-be-guarded
    // room is also the tick its door locks, one tick AFTER their entry already
    // resolved (movement uses last tick's geometry) — never before.
    const eng = createGameEngine(GUARD_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]); // floor places; room 0 door is open (unlocked, unactivated)
    expect(s.dungeonDoors[0]!.locked).toBe(false);
    expect(s.dungeonRoomRuntime[0]!.activated).toBe(false);
  });
});

describe('DoorSystem — force-regroup targets every OTHER online, non-downed player', () => {
  // Deterministic by construction, not by seed luck: the pool has exactly ONE normal
  // piece (enemy-free, where every co-op seat starts), so the single normal draw
  // always lands there; the capstone (referenced by id, never drawn) is the one with
  // the enemy — guaranteeing the trigger room is never the one everyone starts in.
  const SAFE_START: RoomPiece = {
    id: 'safe', tags: ['fr3'], sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'east' }],
  };
  const DANGER_CAPSTONE: RoomPiece = {
    id: 'danger', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] }, exits: [{ edge: 'west' }],
  };
  const FR3_DUN: DungeonConfig = {
    biomeId: 'fr3', nameKey: 'fr3', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
    pieceTags: ['fr3'], layout: 'linear', extractionPieceId: 'danger', bossPieceId: 'danger',
    difficultyCurve: { base: 1, perFloor: 0 },
  };
  const CO_OP_CFG: EngineConfig = {
    seed: 13, worldW: 640, worldH: 640, waves: [],
    players: [{}, {}, {}],
    dungeon: { config: FR3_DUN, library: [SAFE_START, DANGER_CAPSTONE] },
  };

  it('excludes the trigger (already inside), excludes downed teammates, moves everyone else to the entrance', () => {
    const eng = createGameEngine(CO_OP_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]);
    eng.step([idle(0, 2)]); // room 0 (SAFE_START) activates — enemy-free, no lock

    const target = s.dungeonRooms[1]!; // DANGER_CAPSTONE — guaranteed by construction above
    expect(s.dungeonRoomRuntime[1]!.activated).toBe(false); // nobody's reached it yet

    const [pTrigger, pDowned, pBystander] = s.players;
    pDowned!.downed = true;
    pDowned!.hp = 0;
    const bystanderRoomBefore = pBystander!.roomId;

    pTrigger!.gx = toFpGrid(target.piece.spawns.player[0]!.x + target.offsetXGrid);
    pTrigger!.gy = toFpGrid(target.piece.spawns.player[0]!.y + target.offsetYGrid);
    const t = s.tick + 1;
    const events = eng.step([idle(0, t)]); // trigger's roomId updates → target activates → force-regroup fires

    expect(pTrigger!.roomId).toBe(target.id); // the trigger — never "regrouped" onto itself
    expect(pBystander!.roomId).toBe(target.id); // pulled in
    expect(pBystander!.roomId).not.toBe(bystanderRoomBefore);
    expect(pBystander!.gx).toBe(toFpGrid(target.entranceGrid.x));
    expect(pBystander!.gy).toBe(toFpGrid(target.entranceGrid.y));
    expect(pDowned!.roomId).not.toBe(target.id); // left exactly where they were — never yanked
    expect(events.some((e) => e.type === 'force_regroup' && e.roomId === target.id && e.playerIds.includes(pBystander!.id))).toBe(true);
    expect(events.some((e) => e.type === 'force_regroup' && e.playerIds.includes(pDowned!.id))).toBe(false);
  });
});

describe('DoorSystem — solo play is a complete no-op for force-regroup', () => {
  it('never emits force_regroup with only one player online', () => {
    const eng = createGameEngine(cfg(13));
    const s = eng.state;
    let sawForceRegroup = false;
    for (let t = 1; t <= 10; t++) {
      const events = eng.step([idle(0, t)]);
      if (events.some((e) => e.type === 'force_regroup')) sawForceRegroup = true;
    }
    expect(sawForceRegroup).toBe(false);
    expect(s.players).toHaveLength(1); // nothing else to regroup — solo collapses correctly
  });
});
