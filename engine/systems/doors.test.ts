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

/**
 * ENGINE_VERSION 41's softlock fix (`DoorSystem.inLockingDoorway`). Found by
 * `client/sim/pveLevelSim.sim.ts` on the shipped level 1 — 7 of 8 bot runs wedged
 * forever right after clearing the entrance room, and a human crossing a threshold
 * hits the same geometry: the tick your step across the line activates the room, your
 * body is still in the doorway. `p.roomId` had already been re-tagged to the new room
 * (EnvironmentSystem, step 8b, runs before DoorSystem at 11.5), so the old
 * `p.roomId === room.id` skip left you un-regrouped, then the restored passage wall
 * pushed you out — frequently back the way you came. The room stays in combat, its
 * door stays locked, and the floor becomes uncompletable.
 */
describe('DoorSystem — a room activating under a player who is still in its doorway pulls them in (ENGINE_VERSION 41)', () => {
  const START: RoomPiece = {
    id: 'dw_start', tags: ['dw'], sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'east' }],
  };
  const GUARDED_CAPSTONE: RoomPiece = {
    id: 'dw_guarded', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] }, exits: [{ edge: 'west' }],
  };
  const DW_DUN: DungeonConfig = {
    biomeId: 'dw', nameKey: 'dw', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
    pieceTags: ['dw'], layout: 'linear', extractionPieceId: 'dw_guarded', bossPieceId: 'dw_guarded',
    difficultyCurve: { base: 1, perFloor: 0 },
  };
  const DW_CFG: EngineConfig = { seed: 21, worldW: 640, worldH: 640, waves: [], dungeon: { config: DW_DUN, library: [START, GUARDED_CAPSTONE] } };

  /** Stand the player in the door passage, nudged `grid` units off its centre toward
   *  `room`'s middle — i.e. body in the doorway, centre already over the threshold,
   *  which is exactly the state that used to escape the force-regroup. */
  const standInDoorway = (s: typeof eng.state, roomIdx: number, grid: number) => {
    const pass = s.dungeonDoors[0]!.passageAabb;
    const room = s.dungeonRooms[roomIdx]!;
    const cx = pass.x + pass.w / 2;
    const cy = pass.y + pass.h / 2;
    const tx = toFpGrid(room.offsetXGrid + room.piece.sizeGrid.w / 2);
    const ty = toFpGrid(room.offsetYGrid + room.piece.sizeGrid.h / 2);
    const len = Math.hypot(tx - cx, ty - cy) || 1;
    s.players[0]!.gx = (cx + ((tx - cx) / len) * toFpGrid(grid)) as Fp;
    s.players[0]!.gy = (cy + ((ty - cy) / len) * toFpGrid(grid)) as Fp;
  };
  let eng = createGameEngine(DW_CFG);

  it('regroups them onto the entrance instead of leaving them to be shoved out of the closing door', () => {
    eng = createGameEngine(DW_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]); // floor places
    eng.step([idle(0, 2)]); // start room activates (enemy-free → no lock)
    expect(s.dungeonRoomRuntime[1]!.activated).toBe(false);

    const capstone = s.dungeonRooms[1]!;
    standInDoorway(s, 1, 0.6);
    const events = eng.step([idle(0, 3)]); // roomId flips to the capstone → it activates → door locks

    expect(s.dungeonRoomRuntime[1]!.activated).toBe(true);
    expect(s.dungeonDoors[0]!.locked).toBe(true);
    // Placed at the entrance, INSIDE the room whose door just locked — so the fight is
    // winnable. Before the fix this player stayed in the doorway and got pushed out.
    expect(s.players[0]!.gx).toBe(toFpGrid(capstone.entranceGrid.x));
    expect(s.players[0]!.gy).toBe(toFpGrid(capstone.entranceGrid.y));
    expect(s.players[0]!.roomId).toBe(capstone.id);
    expect(events.some((e) => e.type === 'force_regroup' && e.roomId === capstone.id)).toBe(true);
  });

  // Invariant follow-through rather than a second regression catcher: whether the
  // push-out sent the old code backwards or forwards depended on which side of the
  // passage the body sat, so only the assertion above reliably goes red without the
  // fix (checked by re-introducing the old condition). The end-to-end proof is the
  // level sim's no-stall gate — before the fix it wedged 7 of 8 careful runs.
  it('the room stays reachable afterwards — the run can still be finished, which is the actual bug', () => {
    eng = createGameEngine(DW_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]);
    eng.step([idle(0, 2)]);
    standInDoorway(s, 1, 0.6);
    eng.step([idle(0, 3)]);

    // Whatever the geometry does over the following ticks, the player must remain
    // inside the locked room (not sealed out of the only room that can be cleared).
    for (let t = 4; t <= 30; t++) eng.step([idle(0, t)]);
    expect(s.players[0]!.roomId).toBe(s.dungeonRooms[1]!.id);
    expect(s.dungeonDoors[0]!.locked).toBe(true);

    s.enemies.length = 0; // clear it → checkpoint opens, i.e. the floor was completable
    eng.step([idle(0, 31)]);
    expect(s.dungeonRoomRuntime[1]!.hasLiveEnemy).toBe(false);
    expect(s.dungeonDoors[0]!.locked).toBe(false);
  });

  it('still leaves a DOWNED player in the doorway exactly where they are', () => {
    // design/05: a downed teammate is never yanked, full stop — the revive comes to
    // them. That outranks the doorway rule, and it is not a softlock: the door unlocks
    // when the room is cleared, so a reviver can reach them then. Pinned here because
    // the doorway fix deliberately did NOT touch the downed guard above it.
    eng = createGameEngine(DW_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]);
    eng.step([idle(0, 2)]);
    standInDoorway(s, 1, 0.6);
    s.players[0]!.downed = true;
    s.players[0]!.hp = 0;
    const at = { gx: s.players[0]!.gx, gy: s.players[0]!.gy };
    const events = eng.step([idle(0, 3)]);

    expect(s.players[0]!.gx).toBe(at.gx);
    expect(s.players[0]!.gy).toBe(at.gy);
    expect(events.some((e) => e.type === 'force_regroup')).toBe(false);
  });

  it('checks every doorway of the activating room, not just the first', () => {
    // `inLockingDoorway` iterates the room's doors, so a player in the SECOND one has to
    // be caught too — a capstone is single-door, but a mid-floor room is not.
    // One normal piece (guarded) drawn twice plus an enemy-free capstone referenced by
    // id, so the MIDDLE room is guaranteed to be both guarded and two-doored — the
    // shape a single-door capstone fixture can't produce.
    const GUARDED: RoomPiece = {
      id: 'dw_mid', tags: ['dw2'], sizeGrid: { w: 20, h: 16 }, solids: [],
      spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'basic' }] },
      exits: [{ edge: 'east' }, { edge: 'west' }],
    };
    const HUB: RoomPiece = {
      id: 'dw_hub', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
      spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'east' }, { edge: 'west' }],
    };
    const THREE: DungeonConfig = {
      biomeId: 'dw2', nameKey: 'dw2', floorCount: 1, roomsPerFloor: { min: 3, max: 3 },
      pieceTags: ['dw2'], layout: 'linear', extractionPieceId: 'dw_hub', bossPieceId: 'dw_hub',
      difficultyCurve: { base: 1, perFloor: 0 },
    };
    const engine = createGameEngine({ seed: 5, worldW: 640, worldH: 640, waves: [], dungeon: { config: THREE, library: [GUARDED, HUB] } });
    const s = engine.state;
    engine.step([idle(0, 1)]);
    engine.step([idle(0, 2)]);

    // The room that has yet to activate, still holds a garrison, and has two doors.
    const guardedIdx = s.dungeonRooms.findIndex(
      (r, i) =>
        !s.dungeonRoomRuntime[i]!.activated &&
        r.piece.spawns.enemy.length > 0 &&
        s.dungeonDoors.filter((d) => d.door.roomA === r.id || d.door.roomB === r.id).length >= 2,
    );
    expect(guardedIdx).toBeGreaterThanOrEqual(0); // the case under test actually exists
    const guarded = s.dungeonRooms[guardedIdx]!;
    const doors = s.dungeonDoors.filter((d) => d.door.roomA === guarded.id || d.door.roomB === guarded.id);

    const pass = doors[doors.length - 1]!.passageAabb; // the LAST one, not the first
    const cx = pass.x + pass.w / 2;
    const cy = pass.y + pass.h / 2;
    const tx = toFpGrid(guarded.offsetXGrid + guarded.piece.sizeGrid.w / 2);
    const ty = toFpGrid(guarded.offsetYGrid + guarded.piece.sizeGrid.h / 2);
    const len = Math.hypot(tx - cx, ty - cy) || 1;
    s.players[0]!.gx = (cx + ((tx - cx) / len) * toFpGrid(0.6)) as Fp;
    s.players[0]!.gy = (cy + ((ty - cy) / len) * toFpGrid(0.6)) as Fp;
    const events = engine.step([idle(0, 3)]);

    expect(s.dungeonRoomRuntime[guardedIdx]!.activated).toBe(true);
    expect(s.players[0]!.gx).toBe(toFpGrid(guarded.entranceGrid.x));
    expect(events.some((e) => e.type === 'force_regroup' && e.roomId === guarded.id)).toBe(true);
  });

  it('leaves a player who is genuinely inside the room alone — no gratuitous teleport on activation', () => {
    eng = createGameEngine(DW_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]);
    eng.step([idle(0, 2)]);
    // Well clear of the doorway: the room's own centre.
    const capstone = s.dungeonRooms[1]!;
    s.players[0]!.gx = toFpGrid(capstone.offsetXGrid + capstone.piece.sizeGrid.w / 2) as Fp;
    s.players[0]!.gy = toFpGrid(capstone.offsetYGrid + capstone.piece.sizeGrid.h / 2) as Fp;
    const at = { gx: s.players[0]!.gx, gy: s.players[0]!.gy };
    const events = eng.step([idle(0, 3)]);

    expect(s.dungeonRoomRuntime[1]!.activated).toBe(true);
    expect(s.players[0]!.gx).toBe(at.gx); // exactly where they walked to
    expect(s.players[0]!.gy).toBe(at.gy);
    expect(events.some((e) => e.type === 'force_regroup')).toBe(false);
  });
});

describe('DoorSystem — a dying boss\'s onDeathSpawn adds never open a walk-back-out window', () => {
  // Regression for the bug report: a cleared boss room's door briefly unlocked (then
  // slammed shut + force-regrouped the player back) because DeathDropsSystem's
  // onDeathSpawn minions were pushed onto state.enemies without a roomId — so
  // DoorSystem's SAME-tick hasLiveEnemy scan (which skips roomId===undefined) saw the
  // boss room as empty for exactly one tick. Mirrors SpawnSystem.dispatchDungeonSpawns'
  // own "sets roomId DIRECTLY, same tick" fix for the identical class of bug.
  const BOSS_GUARD_ROOM: RoomPiece = {
    id: 'bg', tags: ['bg'], sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [{ x: 16, y: 8, type: 'blightlord' }] }, exits: [{ edge: 'east' }],
  };
  const BOSS_EXIT_ROOM: RoomPiece = {
    id: 'bge', role: 'boss', sizeGrid: { w: 20, h: 16 }, solids: [],
    spawns: { player: [{ x: 2, y: 8 }], enemy: [] }, exits: [{ edge: 'west' }],
  };
  const BOSS_GUARD_DUN: DungeonConfig = {
    biomeId: 'bg', nameKey: 'bg', floorCount: 1, roomsPerFloor: { min: 2, max: 2 },
    pieceTags: ['bg'], layout: 'linear', extractionPieceId: 'bge', bossPieceId: 'bge',
    difficultyCurve: { base: 1, perFloor: 0 },
  };
  const BOSS_GUARD_CFG: EngineConfig = {
    seed: 9, worldW: 640, worldH: 640, waves: [],
    dungeon: { config: BOSS_GUARD_DUN, library: [BOSS_GUARD_ROOM, BOSS_EXIT_ROOM] },
  };

  it('door stays locked the SAME tick the boss dies and its adds spawn (no unlock flicker)', () => {
    const eng = createGameEngine(BOSS_GUARD_CFG);
    const s = eng.state;
    eng.step([idle(0, 1)]); // floor places
    eng.step([idle(0, 2)]); // room 0 activates → blightlord spawns → door locks
    expect(s.dungeonDoors[0]!.locked).toBe(true);

    const boss = s.enemies.find((e) => e.boss)!;
    expect(boss).toBeDefined();
    const bossRoomId = boss.roomId;
    boss.hp = 0; // lethal, to be processed by DeathDropsSystem next tick

    eng.step([idle(0, 3)]); // DeathDropsSystem kills the boss + spawns its 2 adds, THEN DoorSystem runs
    // The adds must be visible to DoorSystem's hasLiveEnemy scan this SAME tick.
    const adds = s.enemies.filter((e) => !e.boss);
    expect(adds).toHaveLength(2);
    for (const add of adds) expect(add.roomId).toBe(bossRoomId);
    expect(s.dungeonRoomRuntime[0]!.hasLiveEnemy).toBe(true);
    expect(s.dungeonDoors[0]!.locked).toBe(true); // never flickered open

    // Only once the adds are actually cleared does it unlock, same as any other room.
    s.enemies.length = 0;
    eng.step([idle(0, 4)]);
    expect(s.dungeonDoors[0]!.locked).toBe(false);
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
