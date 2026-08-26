/** buildDungeonRunConfig / buildArenaDemoConfig: the offline PvE/dev-arena EngineConfig
 *  builders (see offlineConfig.ts's doc comments for the beginRun/arenaDemo contexts).
 *  Mirrors pvpConfig.test.ts's plain input->output style. */
import { describe, it, expect } from 'vitest';
import { fpToPx } from '../coords';
import { toFpGrid } from '@dd/engine/content/convert';
import { ARENA_CATALOG } from './arenaCatalog';
import { buildDungeonRunConfig, buildArenaDemoConfig } from './offlineConfig';

describe('buildDungeonRunConfig', () => {
  const localSeat = { skinId: 'vanguard', loadout: ['auto_pistol'] };

  it('solo (coop: false) uses the top-level skinId/loadout, no players list', () => {
    const cfg = buildDungeonRunConfig({ seed: 1, coop: false, localSeat, allySkinId: 'juggernaut' });
    expect(cfg.players).toBeUndefined();
    expect(cfg.skinId).toBe('vanguard');
    expect(cfg.loadout).toEqual(['auto_pistol']);
  });

  it('coop (coop: true) builds a two-seat players list: local seat then the bot ally', () => {
    const cfg = buildDungeonRunConfig({ seed: 1, coop: true, localSeat, allySkinId: 'juggernaut' });
    expect(cfg.skinId).toBeUndefined();
    expect(cfg.loadout).toBeUndefined();
    expect(cfg.players).toEqual([localSeat, { skinId: 'juggernaut' }]);
  });

  it('carries seed through untouched and sets dungeon geometry, no arena', () => {
    const cfg = buildDungeonRunConfig({ seed: 123, coop: false, localSeat, allySkinId: 'juggernaut' });
    expect(cfg.seed).toBe(123);
    expect(cfg.dungeon).toBeDefined();
    expect(cfg.arena).toBeUndefined();
    expect(cfg.waves).toEqual([]);
  });

  it('is a pure function of its opts — identical config on every call', () => {
    const opts = { seed: 5, coop: true, localSeat, allySkinId: 'skirmisher' };
    expect(buildDungeonRunConfig(opts)).toEqual(buildDungeonRunConfig(opts));
  });
});

describe('buildArenaDemoConfig', () => {
  it('places two local seats on distinct teams (0 and 1) using landing_basic', () => {
    const cfg = buildArenaDemoConfig({ seed: 1, localSkinId: 'vanguard', allySkinId: 'juggernaut' });
    expect(cfg.arena).toBe(ARENA_CATALOG.landing_basic);
    expect(cfg.players).toHaveLength(2);
    expect(cfg.players![0]!.teamId).toBe(0);
    expect(cfg.players![1]!.teamId).toBe(1);
    expect(cfg.players![0]!.skinId).toBe('vanguard');
    expect(cfg.players![1]!.skinId).toBe('juggernaut');
  });

  it('converts room-centre grid coordinates to px start positions via fpToPx(toFpGrid(n))', () => {
    const cfg = buildArenaDemoConfig({ seed: 1, localSkinId: 'vanguard', allySkinId: 'juggernaut' });
    const px = (grid: number) => fpToPx(toFpGrid(grid));
    expect(cfg.players![0]!.start).toEqual([px(5), px(5)]);
    expect(cfg.players![1]!.start).toEqual([px(5), px(35)]);
  });

  it('has no dungeon geometry set (arena mode only)', () => {
    const cfg = buildArenaDemoConfig({ seed: 1, localSkinId: 'vanguard', allySkinId: 'juggernaut' });
    expect(cfg.dungeon).toBeUndefined();
  });

  describe('?arena=<id> — any catalog map, not just the synthetic fixture', () => {
    const opts = { seed: 1, localSkinId: 'vanguard', allySkinId: 'juggernaut' } as const;

    it('an explicit landing_basic is byte-identical to the default (no arenaId)', () => {
      expect(buildArenaDemoConfig({ ...opts, arenaId: 'landing_basic' })).toEqual(
        buildArenaDemoConfig(opts),
      );
    });

    it('builds the REAL 60-room launch map, seats standing on its own authored spawns', () => {
      const arena = ARENA_CATALOG.arena_launch;
      const cfg = buildArenaDemoConfig({ ...opts, arenaId: 'arena_launch' });
      const px = (grid: number) => fpToPx(toFpGrid(grid));
      expect(cfg.arena).toBe(arena);
      // Read out of the map rather than written as literals: the point of this path is
      // that the harness stands where a REAL match would, so the assertion has to move
      // if the map's spawns do. (Both are non-empty — pinned below, since two undefined
      // spawns would make this comparison vacuously true.)
      expect(arena.spawns.length).toBeGreaterThanOrEqual(2);
      expect(cfg.players![0]!.start).toEqual([px(arena.spawns[0]!.x), px(arena.spawns[0]!.y)]);
      expect(cfg.players![1]!.start).toEqual([px(arena.spawns[1]!.x), px(arena.spawns[1]!.y)]);
      expect(cfg.players![0]!.start).not.toEqual(cfg.players![1]!.start);
    });

    it('still puts the two seats on distinct teams, same as the fixture path', () => {
      const cfg = buildArenaDemoConfig({ ...opts, arenaId: 'arena_launch' });
      expect(cfg.players!.map((p) => p.teamId)).toEqual([0, 1]);
    });
  });

  it('is a pure function of its opts, seed passthrough included — identical config on every call', () => {
    const opts = { seed: 9, localSkinId: 'vanguard', allySkinId: 'juggernaut' };
    const a = buildArenaDemoConfig(opts);
    const b = buildArenaDemoConfig(opts);
    expect(a).toEqual(b);
    expect(a.seed).toBe(9);
  });
});
