/**
 * ArenaMap schema + buildArenaGeometry (design/15, ROADMAP 4.2b/c) — the co-resident
 * multi-room stitching that complements spatialGrid.test.ts's broadphase-in-isolation
 * coverage: here the geometry actually comes from several rooms placed at distinct
 * offsets, proving the whole arena->GameState->spatialIndex->systems pipeline, not
 * just the grid data structure alone.
 */
import { describe, it, expect } from 'vitest';
import { toFp, type Fp } from '@dd/engine/math/fixed';
import { toFpGrid } from '@dd/engine/content/convert';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { MovementSystem, ProjectileStepSystem } from '@dd/engine/systems';
import {
  buildArenaGeometry,
  buildArenaCellTraits,
  buildArenaRoomRects,
  computeRoomDistances,
  maxFiniteDistance,
  safeRoomIds,
  isTraitActive,
  type ArenaMap,
  type CellTrait,
} from '@dd/engine/content/arenas';
import { ENEMY_TEAM_ID, type Faction, type Projectile } from '@dd/engine/state/entities';

// Three rooms far enough apart (100 grid units) that even a naive full-array scan
// would never confuse one room's geometry for another's — the point here is
// correctness of the STITCH, not re-proving broadphase pruning (spatialGrid.test.ts
// already covers that in isolation).
const ROOM_SHAPE = { x: 4, y: 4, w: 2, h: 2 }; // room-local solid, same in every room
const ARENA: ArenaMap = {
  id: 'test_arena',
  sizeGrid: { w: 200, h: 200 },
  rooms: [
    { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [ROOM_SHAPE], pillars: [{ center: { x: 8, y: 8 }, radius: 1 }] },
    { id: 'B', rectGrid: { x: 100, y: 0, w: 10, h: 10 }, solids: [ROOM_SHAPE] },
    { id: 'C', rectGrid: { x: 0, y: 100, w: 10, h: 10 }, solids: [ROOM_SHAPE] },
  ],
  doors: [],
  spawns: [{ x: 1, y: 1 }],
  eyeCandidates: [{ roomId: 'A' }],
};

describe('buildArenaGeometry — stitches every room at its rectGrid offset', () => {
  it('places each room\'s solid at its own absolute position', () => {
    const { walls } = buildArenaGeometry(ARENA);
    expect(walls).toHaveLength(3);
    expect(walls[0]).toEqual({ x: toFpGrid(4), y: toFpGrid(4), w: toFpGrid(2), h: toFpGrid(2) }); // room A, offset (0,0)
    expect(walls[1]).toEqual({ x: toFpGrid(104), y: toFpGrid(4), w: toFpGrid(2), h: toFpGrid(2) }); // room B, offset (100,0)
    expect(walls[2]).toEqual({ x: toFpGrid(4), y: toFpGrid(104), w: toFpGrid(2), h: toFpGrid(2) }); // room C, offset (0,100)
  });

  it('places the one pillar (room A only) at its absolute position', () => {
    const { obstacles } = buildArenaGeometry(ARENA);
    expect(obstacles).toHaveLength(1);
    expect(obstacles[0]).toEqual({ gx: toFpGrid(8), gy: toFpGrid(8), radius: toFpGrid(1) });
  });

  it('derives world bounds from the map\'s overall sizeGrid, not any one room', () => {
    const { worldW, worldH } = buildArenaGeometry(ARENA);
    expect(worldW).toBe(toFpGrid(200));
    expect(worldH).toBe(toFpGrid(200));
  });
});

describe('GameState with EngineConfig.arena — end-to-end pipeline', () => {
  function arenaState(): GameState {
    return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: ARENA });
  }

  it('overrides worldW/worldH from the arena, not the placeholder config values', () => {
    const s = arenaState();
    expect(s.worldW).toBe(toFpGrid(200));
    expect(s.worldH).toBe(toFpGrid(200));
  });

  it('the spatial index isolates room C\'s wall from rooms A/B\'s (100 grid units away)', () => {
    const s = arenaState();
    const nearC = s.spatialIndex.queryWalls(toFpGrid(5), toFpGrid(104.9), toFpGrid(0.2));
    expect(nearC).toEqual([2]); // room C's solid is walls[2] (rooms pushed in array order)
  });

  it('MovementSystem pushes a player out of room A\'s wall without touching rooms B/C', () => {
    const s = arenaState();
    const p = s.players[0]!;
    p.gx = toFpGrid(5); // inside room A's 4..6,4..6 solid — fully engulfed footprint
    p.gy = toFpGrid(5);
    new MovementSystem().tick(s);
    // Fully-engulfed axis-separation resolver (MovementSystem.resolveWalls) pushes out
    // the nearest edge — same tie-break rule as rooms.test.ts's engulfed-footprint case.
    const pushedOut = p.gx !== toFpGrid(5) || p.gy !== toFpGrid(5);
    expect(pushedOut).toBe(true);
  });

  it('a player standing in room B is untouched by room A\'s or room C\'s geometry', () => {
    const s = arenaState();
    const p = s.players[0]!;
    p.gx = toFpGrid(101); // open floor in room B, clear of its solid (104..106,4..6)
    p.gy = toFpGrid(1);
    new MovementSystem().tick(s);
    expect(p.gx).toBe(toFpGrid(101));
    expect(p.gy).toBe(toFpGrid(1));
  });

  function addBullet(s: GameState, gx: Fp, gy: Fp, vx: Fp, faction: Faction = 'enemy'): Projectile {
    const b: Projectile = {
      id: s.nextId(), faction, teamId: faction === 'enemy' ? ENEMY_TEAM_ID : 0,
      gx, gy, z: toFp(0),
      vx, vy: toFp(0), radius: toFpGrid(0.15), damage: 1, damageType: 'physical',
      lifeTicks: 90, alive: true,
    };
    s.projectiles.push(b);
    return b;
  }

  it('ProjectileStepSystem stops a bullet on room C\'s wall, unaffected by rooms A/B', () => {
    const s = arenaState();
    // Room C's solid spans absolute x 4..6, y 104..106 — spawn already inside it so
    // the one-tick nudge (vx) keeps it overlapping regardless of bullet radius.
    const b = addBullet(s, toFpGrid(4.5), toFpGrid(104.9), toFpGrid(0.1));
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(false);
  });

  it('a bullet flying through open floor in room B is unaffected by rooms A/C', () => {
    const s = arenaState();
    const b = addBullet(s, toFpGrid(100.5), toFpGrid(1), toFpGrid(0.5));
    new ProjectileStepSystem().tick(s);
    expect(b.alive).toBe(true);
  });
});

// A-B-C linear chain, explicit doors — for the zone-math helpers (ROADMAP 4.2d).
const LINEAR_MAP: ArenaMap = {
  id: 'linear_test',
  sizeGrid: { w: 30, h: 10 },
  rooms: [
    { id: 'A', rectGrid: { x: 0, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'B', rectGrid: { x: 10, y: 0, w: 10, h: 10 }, solids: [] },
    { id: 'C', rectGrid: { x: 20, y: 0, w: 10, h: 10 }, solids: [] },
  ],
  doors: [
    { roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 4, w: 1, h: 2 } },
    { roomA: 'B', roomB: 'C', passageGrid: { x: 20, y: 4, w: 1, h: 2 } },
  ],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

describe('computeRoomDistances — BFS over the explicit doors graph', () => {
  it('gives each room its correct hop distance from the eye', () => {
    const dist = computeRoomDistances(LINEAR_MAP, 'A');
    expect(dist).toEqual([0, 1, 2]); // A, B, C in rooms[] order
  });

  it('never infers adjacency from rectGrid proximity — an isolated room stays unreachable', () => {
    const isolated: ArenaMap = { ...LINEAR_MAP, rooms: [...LINEAR_MAP.rooms, { id: 'D', rectGrid: { x: 100, y: 100, w: 10, h: 10 }, solids: [] }] };
    const dist = computeRoomDistances(isolated, 'A');
    expect(dist[3]).toBe(-1); // D has no door to anything
  });

  it('an unknown eye id leaves every room unreachable', () => {
    const dist = computeRoomDistances(LINEAR_MAP, 'does_not_exist');
    expect(dist).toEqual([-1, -1, -1]);
  });
});

describe('maxFiniteDistance / safeRoomIds', () => {
  const dist = computeRoomDistances(LINEAR_MAP, 'A'); // [0, 1, 2]

  it('maxFiniteDistance ignores unreachable (-1) rooms', () => {
    expect(maxFiniteDistance(dist)).toBe(2);
    expect(maxFiniteDistance([-1, -1])).toBe(0);
  });

  it('safeRoomIds includes only rooms within the given radius, never an unreachable one', () => {
    expect(safeRoomIds(LINEAR_MAP, dist, 2)).toEqual(['A', 'B', 'C']);
    expect(safeRoomIds(LINEAR_MAP, dist, 1)).toEqual(['A', 'B']);
    expect(safeRoomIds(LINEAR_MAP, dist, 0)).toEqual(['A']);
    expect(safeRoomIds(LINEAR_MAP, [0, -1, 5], 5)).toEqual(['A', 'C']); // B's -1 never counts as safe, even though -1 <= 5
  });
});

describe('isTraitActive', () => {
  it('an always-on trait is active at every tick', () => {
    const trait: CellTrait = { id: 't1', rectGrid: { x: 0, y: 0, w: 1, h: 1 }, kind: 'spike', timed: false };
    expect(isTraitActive(trait, 0)).toBe(true);
    expect(isTraitActive(trait, 12345)).toBe(true);
  });

  it('a phased trait cycles armed -> active -> armed on its own period', () => {
    const trait: CellTrait = {
      id: 't2', rectGrid: { x: 0, y: 0, w: 1, h: 1 }, kind: 'spike', timed: true,
      phase: { armTicks: 10, activeTicks: 5 }, // period 15
    };
    expect(isTraitActive(trait, 0)).toBe(false); // armed
    expect(isTraitActive(trait, 9)).toBe(false); // still armed
    expect(isTraitActive(trait, 10)).toBe(true); // active window starts
    expect(isTraitActive(trait, 14)).toBe(true); // still active
    expect(isTraitActive(trait, 15)).toBe(false); // wrapped to the next cycle's armed phase
    expect(isTraitActive(trait, 25)).toBe(true); // second cycle's active window
  });

  it('offsetTicks shifts the cycle\'s start', () => {
    const trait: CellTrait = {
      id: 't3', rectGrid: { x: 0, y: 0, w: 1, h: 1 }, kind: 'spike', timed: true,
      phase: { armTicks: 10, activeTicks: 5, offsetTicks: 10 }, // active immediately at tick 0
    };
    expect(isTraitActive(trait, 0)).toBe(true);
  });

  it('a timed trait authored with no phase is never active (fail-safe, content bug)', () => {
    const trait: CellTrait = { id: 't4', rectGrid: { x: 0, y: 0, w: 1, h: 1 }, kind: 'spike', timed: true };
    expect(isTraitActive(trait, 500)).toBe(false);
  });
});

describe('buildArenaCellTraits / buildArenaRoomRects — construction-time conversion', () => {
  const map: ArenaMap = {
    ...LINEAR_MAP,
    rooms: [
      {
        ...LINEAR_MAP.rooms[0]!,
        cellTraits: [{ id: 'spike1', rectGrid: { x: 2, y: 2, w: 1, h: 1 }, kind: 'spike', timed: false, damage: 3 }],
      },
      LINEAR_MAP.rooms[1]!,
      LINEAR_MAP.rooms[2]!,
    ],
  };

  it('converts a cellTrait rect to absolute Fp, offset by its owning room', () => {
    const traits = buildArenaCellTraits(map);
    expect(traits).toHaveLength(1);
    // room A's offset is (0,0), so absolute == local here; buildArenaGeometry's own
    // stitching test already proves the offset math against a non-zero-offset room.
    expect(traits[0]!.rect).toEqual({ x: toFpGrid(2), y: toFpGrid(2), w: toFpGrid(1), h: toFpGrid(1) });
    expect(traits[0]!.trait.damage).toBe(3);
  });

  it('converts every room\'s rectGrid to an absolute Fp rect', () => {
    const rects = buildArenaRoomRects(map);
    expect(rects).toHaveLength(3);
    expect(rects[1]).toEqual({ id: 'B', rect: { x: toFpGrid(10), y: toFpGrid(0), w: toFpGrid(10), h: toFpGrid(10) } });
  });
});
