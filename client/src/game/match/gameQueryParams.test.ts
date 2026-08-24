/** parseGameQueryParams: pure URLSearchParams parser (see gameQueryParams.ts field doc
 *  comments for what each dev/demo override means). Mirrors pvpConfig.test.ts's plain
 *  input->output style. */
import { describe, it, expect } from 'vitest';
import { parseGameQueryParams } from './gameQueryParams';

describe('parseGameQueryParams', () => {
  it('defaults every field when no params are present', () => {
    expect(parseGameQueryParams('')).toEqual({
      skinOverride: null,
      coop: false,
      online: false,
      arenaDemo: false,
      pvp: false,
      pvpSeats: null,
      matchBaseUrl: null,
      lagMs: null,
      loadoutOverride: null,
      perf: false,
    });
  });

  it('reads skin/mm/wpn as passthrough strings when present', () => {
    const p = parseGameQueryParams('?skin=juggernaut&mm=https://mm.example&wpn=shotgun');
    expect(p.skinOverride).toBe('juggernaut');
    expect(p.matchBaseUrl).toBe('https://mm.example');
    expect(p.loadoutOverride).toEqual(['shotgun']);
  });

  it('treats coop/online/arenaDemo/pvp as "1" boolean toggles, any other value is falsy', () => {
    expect(parseGameQueryParams('?coop=1').coop).toBe(true);
    expect(parseGameQueryParams('?coop=0').coop).toBe(false);
    expect(parseGameQueryParams('?coop=true').coop).toBe(false);
    expect(parseGameQueryParams('?online=1').online).toBe(true);
    expect(parseGameQueryParams('?arenaDemo=1').arenaDemo).toBe(true);
    expect(parseGameQueryParams('?pvp=1').pvp).toBe(true);
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
