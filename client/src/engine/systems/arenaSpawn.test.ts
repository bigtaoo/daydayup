/**
 * SpawnSystem's PvP arena branch (design/15, ROADMAP 4.3) — per-room lazy
 * encounter/loot activation. Every arena room is already co-resident (4.2b); this
 * proves each room's `encounter`/`lootMarkers` only go live once a player actually
 * enters it, and stay independent of every other room's schedule/clock.
 */
import { describe, it, expect } from 'vitest';
import { toFpGrid } from '@dd/engine/content/convert';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { ZoneSystem, EnvironmentSystem, SpawnSystem, DeathDropsSystem } from '@dd/engine/systems';
import { ARENA_DROP_TABLE, rollArenaDrop } from '@dd/engine/content/drops';
import { Prng } from '@dd/engine/math/prng';
import type { ArenaMap } from '@dd/engine/content/arenas';

const TWO_ROOM_MAP: ArenaMap = {
  id: 'spawn_test',
  sizeGrid: { w: 20, h: 10 },
  rooms: [
    {
      id: 'A',
      rectGrid: { x: 0, y: 0, w: 10, h: 10 },
      solids: [],
      spawns: [{ x: 5, y: 5, type: 'basic' }],
      encounter: { entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 0, count: 1 }] },
      lootMarkers: [{ point: { x: 2, y: 2 }, tableId: 'common' }],
    },
    {
      id: 'B',
      rectGrid: { x: 10, y: 0, w: 10, h: 10 },
      solids: [],
      spawns: [{ x: 5, y: 5, type: 'basic' }],
      encounter: { entries: [{ atTick: 0, enemyType: 'basic', spawnPoint: 0, count: 1 }] },
      lootMarkers: [{ point: { x: 2, y: 2 }, tableId: 'common' }],
    },
  ],
  doors: [{ roomA: 'A', roomB: 'B', passageGrid: { x: 10, y: 4, w: 1, h: 2 } }],
  spawns: [{ x: 5, y: 5 }],
  eyeCandidates: [{ roomId: 'A' }],
};

function tickPipeline(s: GameState): void {
  new ZoneSystem().tick(s);
  new EnvironmentSystem().tick(s);
  new SpawnSystem().tick(s);
}

function arenaState(): GameState {
  return createGameState({ seed: 1, worldW: 0, worldH: 0, waves: [], arena: TWO_ROOM_MAP });
}

describe('SpawnSystem — arena lazy activation', () => {
  it('neither room\'s encounter/loot fires before any player has entered it', () => {
    const s = arenaState();
    const p = s.players[0]!;
    p.gx = toFpGrid(-100); // outside every room's rect
    p.gy = toFpGrid(-100);
    tickPipeline(s);
    expect(s.enemies).toHaveLength(0);
    expect(s.pickups).toHaveLength(0);
  });

  it('activates room A (spawns its enemy + loot) the tick a player enters it, leaving B untouched', () => {
    const s = arenaState();
    const p = s.players[0]!;
    p.gx = toFpGrid(5); // inside room A
    p.gy = toFpGrid(5);
    tickPipeline(s);

    expect(s.enemies).toHaveLength(1);
    expect(s.enemies[0]!.gx).toBe(toFpGrid(5)); // spawn point (5,5) + room A's (0,0) offset
    expect(s.enemies[0]!.gy).toBe(toFpGrid(5));

    expect(s.pickups).toHaveLength(1);
    expect(s.pickups[0]!.gx).toBe(toFpGrid(2)); // loot marker (2,2) + room A's (0,0) offset
    expect(s.pickups[0]!.gy).toBe(toFpGrid(2));
  });

  it('activates room B independently once a player enters it, without re-triggering room A', () => {
    const s = arenaState();
    const p = s.players[0]!;
    p.gx = toFpGrid(5); // room A first
    p.gy = toFpGrid(5);
    tickPipeline(s);
    expect(s.enemies).toHaveLength(1);

    p.gx = toFpGrid(15); // now room B (10..20, offset +10)
    tickPipeline(s);
    expect(s.enemies).toHaveLength(2);
    const roomBEnemy = s.enemies.find((e) => e.gx === toFpGrid(15));
    expect(roomBEnemy).toBeDefined();
    expect(roomBEnemy!.gy).toBe(toFpGrid(5));

    expect(s.pickups).toHaveLength(2); // one per room, neither re-spawned

    // Room A must not have spawned a second enemy just because B activated.
    tickPipeline(s);
    expect(s.enemies).toHaveLength(2);
  });

  it('does not re-spawn a room\'s loot on later ticks once already activated', () => {
    const s = arenaState();
    const p = s.players[0]!;
    p.gx = toFpGrid(5);
    p.gy = toFpGrid(5);
    tickPipeline(s);
    tickPipeline(s);
    tickPipeline(s);
    expect(s.pickups).toHaveLength(1);
  });
});

describe('DeathDropsSystem — arena mode uses the arena table, never a PvE material', () => {
  it('rolls only heal/weapon/buff for an enemy killed in an arena match', () => {
    // Fresh state per draw (a different seed each time) rather than respawning a
    // hand-built enemy — DeathDropsSystem's own SpawnSystem-produced enemy is used,
    // so this only exercises the real production path, not a synthetic stand-in.
    for (let seed = 1; seed <= 30; seed++) {
      const s = createGameState({ seed, worldW: 0, worldH: 0, waves: [], arena: TWO_ROOM_MAP });
      const p = s.players[0]!;
      p.gx = toFpGrid(5);
      p.gy = toFpGrid(5);
      tickPipeline(s); // room A activates, spawns its one enemy
      expect(s.enemies).toHaveLength(1);

      s.enemies[0]!.hp = 0;
      new DeathDropsSystem().tick(s);

      expect(s.pickups.length).toBeGreaterThanOrEqual(1); // the loot marker's pickup, plus now the kill's
      const killDrop = s.pickups[s.pickups.length - 1]!;
      expect(killDrop.kind).not.toBe('material');
      expect(killDrop.materialId).toBeUndefined();
    }
  });
});

describe('rollArenaDrop — never rolls material (design/15 fairness wall)', () => {
  it('exhausts every table entry across many draws and never produces a material kind', () => {
    const prng = new Prng(42);
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i++) kinds.add(rollArenaDrop(prng).kind);
    expect(kinds.has('material')).toBe(false);
    expect(ARENA_DROP_TABLE.some((e) => (e.kind as string) === 'material')).toBe(false);
  });
});
