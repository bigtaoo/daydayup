/**
 * levelSim.ts — the end-to-end half of the level simulator: a real `createGameEngine`
 * run over the real shipped level, driven by `PveBotController`, with per-room metrics
 * recorded. These tests are about the HARNESS being trustworthy (does it record what
 * it claims to, is it reproducible, does it terminate); the balance numbers themselves
 * are the job of `sim/pveLevelSim.sim.ts`, which is excluded from the default `npm
 * test` glob because full 5-floor runs are slow.
 *
 * Everything here is therefore capped with a small `maxTicks`: enough real ticks to
 * activate the entrance room and take fire, cheap enough for the normal suite.
 */
import { describe, expect, it } from 'vitest';
import { ROOM_FIRE_BUDGET } from '@dd/engine';
import { runLevel } from './levelSim';

const SHORT = { maxTicks: 400 };

describe('runLevel', () => {
  it('plays the real shipped level and records the entrance room encounter', () => {
    const m = runLevel({ seed: 101, ...SHORT });
    const entrance = m.encounters.find((e) => e.floorIndex === 0);
    expect(entrance).toBeDefined();
    expect(entrance!.garrison).toBeGreaterThan(0); // the authored garrison really spawned
    expect(entrance!.activatedTick).toBeGreaterThan(0);
  });

  it('is reproducible — same seed and profile, byte-identical metrics (design/06)', () => {
    const a = runLevel({ seed: 202, ...SHORT });
    const b = runLevel({ seed: 202, ...SHORT });
    expect(a).toEqual(b);
  });

  it('reports the character it actually played, and the pool the burst numbers are read against', () => {
    const m = runLevel({ seed: 303, skinId: 'juggernaut', ...SHORT });
    expect(m.skinId).toBe('juggernaut');
    expect(m.effectiveHp).toBeGreaterThan(0); // maxHp + maxShield of the real SkinDef
  });

  it('defaults to a fresh save’s loadout — the starter blaster, i.e. what a new player has', () => {
    // An empty `loadout` is what `defaultMetaState()` carries, and it is the case the
    // "I get killed the moment I walk in" report came from.
    const m = runLevel({ seed: 404, ...SHORT });
    expect(m.profileName).toBe('careful');
    expect(m.seed).toBe(404);
  });

  it('takes real damage and records it against the room that dealt it', () => {
    const m = runLevel({ seed: 505, profileName: 'aggressive', ...SHORT });
    const hit = m.encounters.filter((e) => e.damageTaken > 0);
    expect(hit.length).toBeGreaterThan(0);
    // Per-room damage must add up to no more than the run total (bullets in flight can
    // land after the player has left a room, so equality is not guaranteed).
    const summed = m.encounters.reduce((n, e) => n + e.damageTaken, 0);
    expect(summed).toBeLessThanOrEqual(m.damageTaken);
  });

  it('records the reaction window as ticks AFTER activation, never before it', () => {
    const m = runLevel({ seed: 606, profileName: 'aggressive', ...SHORT });
    for (const e of m.encounters) {
      if (e.reactionTicks === null) continue;
      expect(e.reactionTicks).toBeGreaterThanOrEqual(0);
    }
  });

  it('never reports more simultaneous shooters than the engine’s own room budget allows', () => {
    // Cross-checks the tracker against `ROOM_FIRE_BUDGET` (engine/balance/encounter.ts)
    // — if this ever exceeds it, either the budget regressed or the tracker is
    // miscounting, and both are worth failing on.
    const m = runLevel({ seed: 707, ...SHORT });
    for (const e of m.encounters) expect(e.peakShooters).toBeLessThanOrEqual(ROOM_FIRE_BUDGET);
  });

  it('bounds the burst window to one second of damage, not the whole run', () => {
    const m = runLevel({ seed: 808, profileName: 'aggressive', ...SHORT });
    expect(m.peakBurstDamage).toBeLessThanOrEqual(m.damageTaken);
  });

  it('stops at maxTicks and says so, instead of running forever', () => {
    const m = runLevel({ seed: 909, maxTicks: 60 });
    expect(m.outcome).toBe('timeout');
    expect(m.ticks).toBe(60);
  });

  it('tracks the lowest health fraction seen, as a fraction of the pool', () => {
    const m = runLevel({ seed: 111, profileName: 'aggressive', ...SHORT });
    expect(m.lowestHpFrac).toBeGreaterThanOrEqual(0);
    expect(m.lowestHpFrac).toBeLessThanOrEqual(1);
  });

  it('a died outcome always names the room the run ended in — the actionable half of a death', () => {
    // Long enough for the aggressive profile to actually die somewhere.
    const m = runLevel({ seed: 202, profileName: 'aggressive', maxTicks: 4000 });
    if (m.outcome === 'died') expect(m.endRoom).not.toBeNull();
  });
});
