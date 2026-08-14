/**
 * AIDecideSystem.tick() — PvE enemy facing/fire-intent/chase decision (see the
 * module's own doc comment for the no-target early-out, the chase-to-engage-range
 * movement, and the dungeon room-activation gate's rationale, design/05 "Room &
 * door model", 2026-08-04; movement added ENGINE_VERSION 37).
 */
import { describe, it, expect } from 'vitest';
import { isqrt, toFp } from '@dd/engine/math/fixed';
import type { Fp } from '@dd/engine/math/fixed';
import type { Brad } from '@dd/engine/math/trig';
import { atan2Brad } from '@dd/engine/math/trig';
import { pxToFp } from '@dd/engine/content/convert';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ENEMY_TEAM_ID, type EnemyActor } from '@dd/engine/state/entities';
import { freshStatus } from '@dd/engine/content/damage';
import {
  BASIC_ENEMY,
  DEFAULT_ENEMY_ENGAGE_RANGE_FP,
  DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
} from '@dd/engine/content/enemies';
import { AIDecideSystem } from '@dd/engine/systems/AIDecideSystem';
import type { DungeonConfig } from '@dd/engine/world/dungeon';
import type { RoomPiece } from '@dd/engine/content/rooms';

const CFG = { seed: 29, worldW: 1600, worldH: 1200, waves: [] as const };

function addEnemy(s: GameState, xpx: number, ypx: number, roomId?: string): EnemyActor {
  const e: EnemyActor = {
    id: s.nextId(), faction: 'enemy', teamId: ENEMY_TEAM_ID,
    gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0), vx: toFp(0), vy: toFp(0),
    knockVx: toFp(0), knockVy: toFp(0),
    facing: 0 as Brad, hp: BASIC_ENEMY.maxHp, maxHp: BASIC_ENEMY.maxHp, shield: 0, maxShield: 0,
    ticksSinceHit: 0, radius: BASIC_ENEMY.radius, footprintRadius: BASIC_ENEMY.footprintRadius,
    alive: true, weapon: null, firing: false, status: freshStatus(), enraged: false, roomId,
  };
  s.enemies.push(e);
  return e;
}

// Minimal dungeon config: only `dungeon`'s PRESENCE matters here (it flips
// `state.dungeonEnabled`) — `generateFloor` is never invoked by these tests, so
// none of the catalog's actual field values are exercised.
const DUMMY_ROOM: RoomPiece = {
  id: 'r', sizeGrid: { w: 10, h: 10 }, solids: [],
  spawns: { player: [{ x: 5, y: 5 }], enemy: [] }, exits: [],
};
const DUMMY_DUNGEON: DungeonConfig = {
  biomeId: 'd', nameKey: 'd', floorCount: 1, roomsPerFloor: { min: 1, max: 1 },
  pieceTags: ['d'], layout: 'linear', extractionPieceId: 'r', bossPieceId: 'r',
  difficultyCurve: { base: 1, perFloor: 0 },
};

function dungeonState(): GameState {
  return createGameState({ ...CFG, dungeon: { config: DUMMY_DUNGEON, library: [DUMMY_ROOM] } });
}

describe('AIDecideSystem.tick — no-target early-out', () => {
  it('sets firing false (overriding a prior true) when no player exists at all', () => {
    const s = createGameState({ ...CFG, players: [] });
    const e = addEnemy(s, 900, 700);
    e.firing = true;
    e.vx = toFp(1);
    e.vy = toFp(1);
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false);
    expect(e.vx).toBe(toFp(0)); // no target → also stop moving (ENGINE_VERSION 37)
    expect(e.vy).toBe(toFp(0));
  });

  it('sets firing false when the only player is downed (design/07 — ignore a body that cannot fight back)', () => {
    const s = createGameState(CFG);
    s.players[0]!.downed = true;
    const e = addEnemy(s, 900, 700);
    e.firing = true;
    e.vx = toFp(1);
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false);
    expect(e.vx).toBe(toFp(0));
  });

  it('skips a dead enemy entirely — leaves its facing/firing/vx/vy untouched', () => {
    const s = createGameState(CFG);
    const e = addEnemy(s, 900, 700);
    e.alive = false;
    e.firing = false;
    e.vx = toFp(3);
    const facingBefore = e.facing;
    new AIDecideSystem().tick(s);
    expect(e.facing).toBe(facingBefore);
    expect(e.firing).toBe(false);
    expect(e.vx).toBe(toFp(3));
  });

  it('targets the first alive, non-downed player when several exist', () => {
    const s = createGameState({ ...CFG, players: [{ start: [100, 100] }, { start: [900, 700] }] });
    s.players[0]!.downed = true; // first seat is downed — must be skipped
    const e = addEnemy(s, 0, 0);
    new AIDecideSystem().tick(s);
    const target = s.players[1]!;
    expect(e.facing).toBe(atan2Brad(target.gy - e.gy, target.gx - e.gx));
    expect(e.firing).toBe(true);
  });
});

describe('AIDecideSystem.tick — atan2 facing', () => {
  it('faces exactly toward the target via atan2Brad(dy, dx) and sets firing true', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const target = s.players[0]!;
    const e = addEnemy(s, 400, 400);
    new AIDecideSystem().tick(s);
    expect(e.facing).toBe(atan2Brad(target.gy - e.gy, target.gx - e.gx));
    expect(e.firing).toBe(true);
  });

  it('re-faces every tick as the target moves', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const target = s.players[0]!;
    const e = addEnemy(s, 400, 400);
    new AIDecideSystem().tick(s);
    const firstFacing = e.facing;
    target.gx = pxToFp(400); // target moves to sit directly above the enemy
    target.gy = pxToFp(0);
    new AIDecideSystem().tick(s);
    expect(e.facing).not.toBe(firstFacing);
    expect(e.facing).toBe(atan2Brad(target.gy - e.gy, target.gx - e.gx));
  });
});

describe('AIDecideSystem.tick — chase toward engage range (ENGINE_VERSION 37)', () => {
  it('closes distance when farther than engageRangeFp, along the exact direction to the target', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const target = s.players[0]!;
    const e = addEnemy(s, 400, 400); // well outside the default ~180px engage range
    new AIDecideSystem().tick(s);
    expect(e.vx).toBeGreaterThan(0); // target is to the +x, +y side
    expect(e.vy).toBeGreaterThan(0);
    // Direction must match facing: vy/vx ratio equals dy/dx (integer truncation aside).
    const dx = target.gx - e.gx;
    const dy = target.gy - e.gy;
    expect(Math.round((e.vy / e.vx) * 100)).toBe(Math.round((dy / dx) * 100));
  });

  it('moves at (approximately) the configured moveSpeedPerTick magnitude', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const e = addEnemy(s, 400, 400);
    new AIDecideSystem().tick(s);
    const speedSq = e.vx * e.vx + e.vy * e.vy;
    // isqrt truncates twice (direction normalize, then this check) — allow 1fp slack.
    expect(Math.abs(isqrt(speedSq) - DEFAULT_ENEMY_MOVE_SPEED_PER_TICK)).toBeLessThanOrEqual(1);
  });

  it('stops (vx=vy=0) once within engageRangeFp of the target', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const e = addEnemy(s, 400, 400); // exactly on top of the target — well inside range
    new AIDecideSystem().tick(s);
    expect(e.vx).toBe(toFp(0));
    expect(e.vy).toBe(toFp(0));
  });

  it('stops exactly at the boundary (distance === engageRangeFp)', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 400] }] });
    const e = addEnemy(s, 400, 400);
    // Place the enemy exactly engageRangeFp away along +x — the boundary is inclusive.
    e.gx = (s.players[0]!.gx - DEFAULT_ENEMY_ENGAGE_RANGE_FP) as Fp;
    new AIDecideSystem().tick(s);
    expect(e.vx).toBe(toFp(0));
    expect(e.vy).toBe(toFp(0));
  });

  it('a per-enemy moveSpeedPerTick/engageRangeFp override wins over the shared default', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const e = addEnemy(s, 400, 400);
    e.moveSpeedPerTick = toFp(50); // far above the default — should dominate
    e.engageRangeFp = toFp(0); // never satisfied at this distance, so it should keep closing
    new AIDecideSystem().tick(s);
    const speed = isqrt(e.vx * e.vx + e.vy * e.vy);
    // Direction-normalize truncates twice at this magnitude — a loose relative
    // tolerance, not exact-arithmetic reimplementation.
    expect(speed).toBeGreaterThan(toFp(50) * 0.95);
    expect(speed).toBeLessThan(toFp(50) * 1.05);
  });

  it('a hand-built enemy missing moveSpeedPerTick/engageRangeFp falls back to the shared defaults', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    const e = addEnemy(s, 400, 400);
    expect(e.moveSpeedPerTick).toBeUndefined();
    expect(e.engageRangeFp).toBeUndefined();
    new AIDecideSystem().tick(s);
    expect(isqrt(e.vx * e.vx + e.vy * e.vy)).toBeGreaterThan(0); // moved, using the fallback speed
  });

  it('in dungeon mode, an unactivated room leaves vx/vy untouched (frozen, same gate as firing)', () => {
    const s = dungeonState();
    const e = addEnemy(s, 400, 400, 'nonexistent-room');
    e.vx = toFp(7);
    e.vy = toFp(9);
    new AIDecideSystem().tick(s);
    expect(e.vx).toBe(toFp(7));
    expect(e.vy).toBe(toFp(9));
  });
});

describe('AIDecideSystem.tick — dungeon room-activation gate (design/05, 2026-08-04)', () => {
  it('outside dungeon mode, an enemy with no roomId still decides normally', () => {
    const s = createGameState({ ...CFG, players: [{ start: [900, 700] }] });
    expect(s.dungeonEnabled).toBe(false);
    const e = addEnemy(s, 400, 400); // roomId undefined
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(true);
  });

  it('in dungeon mode, an enemy with no roomId is inert (isActivated(undefined) → false)', () => {
    const s = dungeonState();
    const e = addEnemy(s, 400, 400); // roomId undefined
    e.firing = false;
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(false); // never touched — left exactly as spawned
  });

  it('in dungeon mode, a roomId with no matching dungeonRoomIndexById entry is inert', () => {
    const s = dungeonState();
    const e = addEnemy(s, 400, 400, 'nonexistent-room');
    e.firing = true; // pre-set true to prove the gate leaves it UNTOUCHED, not forced false
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(true);
  });

  it('in dungeon mode, a real room that has not activated yet is inert', () => {
    const s = dungeonState();
    s.dungeonRoomIndexById.set('r0', 0);
    s.dungeonRoomRuntime.push({ activated: false, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false });
    const e = addEnemy(s, 400, 400, 'r0');
    e.firing = true;
    const facingBefore = e.facing;
    new AIDecideSystem().tick(s);
    expect(e.firing).toBe(true); // untouched
    expect(e.facing).toBe(facingBefore); // untouched
  });

  it('in dungeon mode, an activated room decides normally', () => {
    const s = dungeonState();
    const target = s.players[0]!; // default seat, world centre
    s.dungeonRoomIndexById.set('r0', 0);
    s.dungeonRoomRuntime.push({ activated: true, roomTick: 0, schedule: [], cursor: 0, hasLiveEnemy: false });
    const e = addEnemy(s, 400, 400, 'r0');
    new AIDecideSystem().tick(s);
    expect(e.facing).toBe(atan2Brad(target.gy - e.gy, target.gx - e.gx));
    expect(e.firing).toBe(true);
  });
});
