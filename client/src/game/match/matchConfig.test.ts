/** buildOnlineConfig: derives the EngineConfig from a server-issued MatchStart. Mirrors
 *  pvpConfig.test.ts's plain input->output style. See matchConfig.ts's doc comment for
 *  why `m.mode === 'pvp'` branches to the arena shape (buildPvpEngineConfig) instead. */
import { describe, it, expect } from 'vitest';
import { SKIN_DEFS, type MatchStart } from '@dd/engine';
import { buildOnlineConfig } from './matchConfig';
import { buildPvpEngineConfig } from './pvpConfig';

function matchStart(overrides: Partial<MatchStart> = {}): MatchStart {
  return { seed: 1, startFrame: 0, localOwner: 0, playerCount: 2, ...overrides };
}

describe('buildOnlineConfig', () => {
  it('delegates to buildPvpEngineConfig(seed, playerCount) when mode is "pvp"', () => {
    const m = matchStart({ mode: 'pvp', seed: 42, playerCount: 8 });
    expect(buildOnlineConfig(m)).toEqual(buildPvpEngineConfig(42, 8));
  });

  it('builds a PvE dungeon config for the "coop" mode', () => {
    const m = matchStart({ mode: 'coop', seed: 7, playerCount: 3 });
    const cfg = buildOnlineConfig(m);
    expect(cfg.dungeon).toBeDefined();
    expect(cfg.arena).toBeUndefined();
    expect(cfg.seed).toBe(7);
    expect(cfg.players).toHaveLength(3);
  });

  it('builds a PvE dungeon config when mode is absent (undefined)', () => {
    const m = matchStart({ mode: undefined, seed: 9, playerCount: 1 });
    const cfg = buildOnlineConfig(m);
    expect(cfg.dungeon).toBeDefined();
    expect(cfg.arena).toBeUndefined();
  });

  it('skins each seat by index into SKIN_DEFS, cycling if playerCount exceeds the skin count', () => {
    const ids = Object.keys(SKIN_DEFS);
    const m = matchStart({ playerCount: ids.length + 1 });
    const cfg = buildOnlineConfig(m);
    const skinIds = cfg.players!.map((p) => p.skinId);
    expect(skinIds).toEqual(Array.from({ length: ids.length + 1 }, (_, i) => ids[i % ids.length]));
  });

  it('is a pure function of the MatchStart fields it reads — identical config on every call', () => {
    const m = matchStart({ mode: 'coop', seed: 5, playerCount: 4 });
    expect(buildOnlineConfig(m)).toEqual(buildOnlineConfig(m));
  });

  it('non-pvp seats carry only skinId — no teamId, matching the PvE (non-arena) seat shape', () => {
    const m = matchStart({ mode: 'coop', playerCount: 2 });
    const cfg = buildOnlineConfig(m);
    for (const p of cfg.players!) expect('teamId' in p).toBe(false);
  });
});
