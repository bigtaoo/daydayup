/**
 * RoomState collision geometry (design/07/09, ROADMAP 1.2): AABB tile/wall solids
 * alongside the existing round pillars, plus the pure RoomPiece → sim-geometry
 * converter. This is additive (no ENGINE_VERSION bump): every existing config
 * omits `walls`, so `state.walls` stays empty and these code paths are no-ops for
 * any pre-1.2 replay — see config.ts's note near ENGINE_VERSION.
 */
import { describe, it, expect } from 'vitest';
import { addFp, toFp, type Fp } from '@dd/engine/math/fixed';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { pxToFp } from '@dd/engine/content/convert';
import { circleOverlapsAabb } from '@dd/engine/systems/geom';
import { roomGeometry, type RoomPiece } from '@dd/engine/content/rooms';
import { MovementSystem, ProjectileStepSystem } from '@dd/engine/systems';
import { ENEMY_TEAM_ID, type Faction, type Projectile } from '@dd/engine/state/entities';

const CFG = { seed: 1, worldW: 1600, worldH: 1200, waves: [] as const };

describe('circleOverlapsAabb (geom)', () => {
  it('overlaps when the circle centre is inside the rect', () => {
    const rect = { x: toFp(0), y: toFp(0), w: toFp(2), h: toFp(2) };
    expect(circleOverlapsAabb(toFp(1), toFp(1), toFp(0.1), rect)).toBe(true);
  });

  it('overlaps when within radius of the nearest edge', () => {
    const rect = { x: toFp(0), y: toFp(0), w: toFp(2), h: toFp(2) };
    expect(circleOverlapsAabb(toFp(2.3), toFp(1), toFp(0.5), rect)).toBe(true); // 0.3 grid past the right edge, radius 0.5
  });

  it('does not overlap when clear of the rect', () => {
    const rect = { x: toFp(0), y: toFp(0), w: toFp(2), h: toFp(2) };
    expect(circleOverlapsAabb(toFp(5), toFp(5), toFp(0.5), rect)).toBe(false);
  });
});

describe('MovementSystem — AABB wall push-out', () => {
  it('pushes a player out along the normal when approaching from outside (right edge)', () => {
    // Wall's right edge sits just inside the player's small footprint radius
    // (~7px) — player spawns at world centre (800,600px); wall right edge = 795px.
    const s = createGameState({ ...CFG, walls: [[780, 590, 15, 20]] as const }); // px x,y,w,h
    const p = s.players[0]!;
    new MovementSystem().tick(s);
    const wallRight = addFp(pxToFp(780), pxToFp(15));
    expect(p.gx).toBe(addFp(wallRight, p.footprintRadius)); // pushed to just touching the edge
    expect(p.gy).toBe(pxToFp(600)); // untouched — the push was purely along x
  });

  it('resolves a fully-engulfed footprint via axis separation (nearest edge)', () => {
    // A tall, narrow wall centred exactly on the player spawn (784..816px x)
    // spanning the whole world height — nearest edge is a tied left/right (both
    // 16px away); the resolver's fixed tie-break prefers +x (right).
    const s = createGameState({ ...CFG, walls: [[784, 0, 32, 1200]] as const });
    const p = s.players[0]!;
    new MovementSystem().tick(s);
    const wallRight = addFp(pxToFp(784), pxToFp(32));
    expect(p.gx).toBe(addFp(wallRight, p.footprintRadius)); // pushed out the +x edge
    expect(p.gy).toBe(pxToFp(600)); // y untouched — the resolved axis was x
  });

  it('does not move an actor clear of every wall', () => {
    const s = createGameState({ ...CFG, walls: [[0, 0, 32, 32]] as const }); // far corner
    const p = s.players[0]!;
    const before = p.gx;
    new MovementSystem().tick(s);
    expect(p.gx).toBe(before);
  });
});

describe('ProjectileStepSystem — AABB wall stop/expire', () => {
  function addBullet(s: GameState, xpx: number, ypx: number, vx: Fp, faction: Faction = 'enemy'): Projectile {
    const b: Projectile = {
      id: s.nextId(), faction, teamId: faction === 'enemy' ? ENEMY_TEAM_ID : 0,
      gx: pxToFp(xpx), gy: pxToFp(ypx), z: toFp(0),
      vx, vy: toFp(0), radius: pxToFp(5), damage: 1, damageType: 'physical',
      lifeTicks: 90, alive: true,
    };
    s.projectiles.push(b);
    return b;
  }

  it('expires a bullet that flies into a wall', () => {
    const s = createGameState({ ...CFG, walls: [[816, 90, 40, 40]] as const }); // spans y 90..130, x 816..856
    const b = addBullet(s, 800, 100, toFp(0.5)); // ~16px step lands inside the wall
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('lets a bullet pass where there is no wall', () => {
    const s = createGameState({ ...CFG, walls: [[816, 400, 40, 40]] as const }); // wall is far away on y
    const b = addBullet(s, 800, 100, toFp(0.5));
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(true);
  });
});

describe('roomGeometry (content/rooms) — pure RoomPiece → sim-geometry conversion', () => {
  const piece: RoomPiece = {
    id: 'test_room',
    sizeGrid: { w: 10, h: 8 },
    solids: [{ x: 0, y: 0, w: 10, h: 1 }],
    pillars: [{ center: { x: 5, y: 4 }, radius: 0.5 }],
    spawns: { player: [{ x: 5, y: 6 }], enemy: [{ x: 5, y: 2, type: 'basic' }] },
    exits: [{ edge: 'north' }],
  };

  it('converts solids/pillars to Fp, offset by the placement origin', () => {
    const { walls, obstacles } = roomGeometry(piece, 20, 30);
    expect(walls).toHaveLength(1);
    expect(walls[0]).toEqual({ x: toFp(20), y: toFp(30), w: toFp(10), h: toFp(1) });
    expect(obstacles).toHaveLength(1);
    expect(obstacles[0]).toEqual({ gx: toFp(25), gy: toFp(34), radius: toFp(0.5) });
  });

  it('defaults the offset to the origin', () => {
    const { walls } = roomGeometry(piece);
    expect(walls[0]!.x).toBe(toFp(0));
  });

  it('a piece with no pillars converts to an empty obstacles array', () => {
    const bare: RoomPiece = { ...piece, pillars: undefined };
    const { obstacles } = roomGeometry(bare);
    expect(obstacles).toHaveLength(0);
  });
});

describe('Additive, no-bump (design/09 "unknown field ignored" precedent)', () => {
  it('a config with no walls leaves state.walls empty — every pre-1.2 replay is unaffected', () => {
    const s = createGameState(CFG);
    expect(s.walls).toHaveLength(0);
  });
});

