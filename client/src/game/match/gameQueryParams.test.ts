/** parseGameQueryParams: pure URLSearchParams parser (see gameQueryParams.ts field doc
 *  comments for what each dev/demo override means). Mirrors pvpConfig.test.ts's plain
 *  input->output style. readGameQueryParams: the platform-guard wrapper Game.ts actually
 *  calls — covered separately below since it reads globals, not an argument. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseGameQueryParams, readGameQueryParams } from './gameQueryParams';

describe('parseGameQueryParams', () => {
  it('defaults every field when no params are present', () => {
    expect(parseGameQueryParams('')).toEqual({
      skinOverride: null,
      coop: false,
      online: false,
      arenaDemo: null,
      pvp: false,
      pvpSeats: null,
      matchBaseUrl: null,
      lagMs: null,
      loadoutOverride: null,
      perf: false,
      pickupDebug: false,
      replayUrl: null,
    });
  });

  it('reads ?replay= as the recorded-run URL to play back', () => {
    expect(parseGameQueryParams('?replay=/ddreplay-dungeon-17.json').replayUrl).toBe(
      '/ddreplay-dungeon-17.json',
    );
    expect(parseGameQueryParams('?pickupDebug=1').replayUrl).toBeNull();
  });

  it('reads skin/mm/wpn as passthrough strings when present', () => {
    const p = parseGameQueryParams('?skin=juggernaut&mm=https://mm.example&wpn=shotgun');
    expect(p.skinOverride).toBe('juggernaut');
    expect(p.matchBaseUrl).toBe('https://mm.example');
    expect(p.loadoutOverride).toEqual(['shotgun']);
  });

  it('treats coop/online/pvp as "1" boolean toggles, any other value is falsy', () => {
    expect(parseGameQueryParams('?coop=1').coop).toBe(true);
    expect(parseGameQueryParams('?coop=0').coop).toBe(false);
    expect(parseGameQueryParams('?coop=true').coop).toBe(false);
    expect(parseGameQueryParams('?online=1').online).toBe(true);
    expect(parseGameQueryParams('?pvp=1').pvp).toBe(true);
  });

  describe('arenaDemo — which local arena the dev harness boots (null = off)', () => {
    it('?arenaDemo=1 keeps its original meaning: the small synthetic fixture', () => {
      expect(parseGameQueryParams('?arenaDemo=1').arenaDemo).toBe('landing_basic');
      expect(parseGameQueryParams('?arenaDemo=0').arenaDemo).toBeNull();
      expect(parseGameQueryParams('?arenaDemo=true').arenaDemo).toBeNull();
    });

    it('?arena=<id> selects any catalog map and implies the harness, no arenaDemo needed', () => {
      expect(parseGameQueryParams('?arena=arena_launch').arenaDemo).toBe('arena_launch');
      expect(parseGameQueryParams('?arena=landing_basic').arenaDemo).toBe('landing_basic');
    });

    // The failure this rejects is silent, not loud: an unvalidated id reaches
    // `EngineConfig.arena` as `undefined`, which boots a run with NO arena rather than
    // reporting the typo — so an unknown id must leave the harness off, not on-with-nothing.
    it('an unknown ?arena= id leaves the harness off rather than booting an empty arena', () => {
      expect(parseGameQueryParams('?arena=nope').arenaDemo).toBeNull();
      expect(parseGameQueryParams('?arena=').arenaDemo).toBeNull();
    });

    it('an unknown ?arena= id does not cancel an explicit ?arenaDemo=1', () => {
      expect(parseGameQueryParams('?arena=nope&arenaDemo=1').arenaDemo).toBe('landing_basic');
    });

    it('?arena= wins over ?arenaDemo=1 when both name a real map', () => {
      expect(parseGameQueryParams('?arenaDemo=1&arena=arena_launch').arenaDemo).toBe(
        'arena_launch',
      );
    });
  });

  it('pvp=1 implies online=true even without an explicit online param', () => {
    const p = parseGameQueryParams('?pvp=1');
    expect(p.pvp).toBe(true);
    expect(p.online).toBe(true);
  });

  it('online stays true when both online=1 and pvp=1 are set', () => {
    const p = parseGameQueryParams('?online=1&pvp=1');
    expect(p.online).toBe(true);
    expect(p.pvp).toBe(true);
  });

  it('online is false when pvp is absent/off and online is absent/off', () => {
    expect(parseGameQueryParams('?pvp=0').online).toBe(false);
    expect(parseGameQueryParams('').online).toBe(false);
  });

  describe('pvpSeats (seat count clamp)', () => {
    it('accepts integers within the inclusive 2-8 range', () => {
      for (const n of [2, 3, 5, 8]) {
        expect(parseGameQueryParams(`?seats=${n}`).pvpSeats).toBe(n);
      }
    });

    it('rejects values below the 2-8 range', () => {
      expect(parseGameQueryParams('?seats=1').pvpSeats).toBeNull();
      expect(parseGameQueryParams('?seats=0').pvpSeats).toBeNull();
      expect(parseGameQueryParams('?seats=-1').pvpSeats).toBeNull();
    });

    it('rejects values above the 2-8 range', () => {
      expect(parseGameQueryParams('?seats=9').pvpSeats).toBeNull();
      expect(parseGameQueryParams('?seats=100').pvpSeats).toBeNull();
    });

    it('rejects non-integers and non-numeric strings', () => {
      expect(parseGameQueryParams('?seats=4.5').pvpSeats).toBeNull();
      expect(parseGameQueryParams('?seats=abc').pvpSeats).toBeNull();
    });

    it('defaults to null when the param is absent', () => {
      expect(parseGameQueryParams('').pvpSeats).toBeNull();
    });
  });

  describe('lagMs (lag>0 validation)', () => {
    it('accepts a positive finite number', () => {
      expect(parseGameQueryParams('?lag=150').lagMs).toBe(150);
      expect(parseGameQueryParams('?lag=0.5').lagMs).toBe(0.5);
    });

    it('rejects zero and negative values', () => {
      expect(parseGameQueryParams('?lag=0').lagMs).toBeNull();
      expect(parseGameQueryParams('?lag=-50').lagMs).toBeNull();
    });

    it('rejects non-numeric strings and absent param', () => {
      expect(parseGameQueryParams('?lag=abc').lagMs).toBeNull();
      expect(parseGameQueryParams('').lagMs).toBeNull();
    });
  });

  describe('loadoutOverride', () => {
    it('wraps a single wpn id into a one-element array', () => {
      expect(parseGameQueryParams('?wpn=auto_pistol').loadoutOverride).toEqual(['auto_pistol']);
    });

    it('is null when wpn is absent or empty', () => {
      expect(parseGameQueryParams('').loadoutOverride).toBeNull();
      expect(parseGameQueryParams('?wpn=').loadoutOverride).toBeNull();
    });
  });
});

describe('readGameQueryParams', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses location.search when both globals are present (web/jsdom)', () => {
    vi.stubGlobal('location', { search: '?coop=1' });
    expect(readGameQueryParams()).toEqual(parseGameQueryParams('?coop=1'));
  });

  it('returns null without throwing when URLSearchParams is missing (WeChat mini-game)', () => {
    // Mirrors the real WeChat runtime: it injects a compat `location` (search always
    // '') for libraries that probe it, but has no URLSearchParams at all — this is the
    // exact shape that used to throw a bare ReferenceError out of Game's constructor.
    vi.stubGlobal('location', { search: '' });
    vi.stubGlobal('URLSearchParams', undefined);
    expect(() => readGameQueryParams()).not.toThrow();
    expect(readGameQueryParams()).toBeNull();
  });

  it('returns null when location itself is missing', () => {
    vi.stubGlobal('location', undefined);
    expect(readGameQueryParams()).toBeNull();
  });
});
