/**
 * The quality-tier table and its `'auto'` policy (`quality.ts`, 2026-08-25).
 *
 * The thing worth testing here is NOT "the two profiles differ" — a table of booleans differs
 * from another table of booleans by construction, and an assertion that just reads the constants
 * back would pass with the tiers swapped. What has to hold is DIRECTIONAL: every knob on the low
 * tier must be cheaper than, or equal to, the same knob on high. A reversed table is byte-
 * identical in any count and catastrophic in effect (design/ROADMAP: the reversed shading ramp).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  QUALITY_SETTINGS,
  activeQuality,
  qualityProfile,
  resetActiveQuality,
  resolveTier,
  setActiveQuality,
  type QualityTier,
} from './quality';

afterEach(() => resetActiveQuality());

describe('quality profiles', () => {
  it('never makes the low tier more expensive than the high tier, on any knob', () => {
    const hi = qualityProfile('high');
    const lo = qualityProfile('low');
    // The boolean passes: low may drop one high runs, never the reverse.
    for (const knob of ['sceneLight', 'screenFx', 'bloom', 'actorShaders'] as const) {
      expect(hi[knob], `high.${knob}`).toBe(true);
      expect(lo[knob], `low.${knob}`).toBe(false);
    }
    // The numeric ones, as inequalities rather than as pinned values, so retuning either tier
    // does not have to come here — only INVERTING them does.
    expect(lo.particleBudget).toBeLessThan(hi.particleBudget);
    expect(lo.resolutionCap).toBeLessThan(hi.resolutionCap);
  });

  it('keeps particles alive on the low tier — thinner, not gone', () => {
    // 0 is a legal budget for the ParticleSystem (see its `scaled`), but a tier that ships it
    // would silently delete muzzle flashes, which carry information about who is shooting.
    expect(qualityProfile('low').particleBudget).toBeGreaterThan(0);
  });

  it('reports its own tier back, so a profile is self-describing', () => {
    for (const tier of ['high', 'low'] as QualityTier[]) {
      expect(qualityProfile(tier).tier).toBe(tier);
    }
  });
});

describe('resolveTier', () => {
  it('honours an explicit pick regardless of what the watchdog decided', () => {
    // The case that matters: the watchdog downgraded, then the player asked for high anyway.
    // Their choice wins — otherwise the setting would be a suggestion the game can veto.
    expect(resolveTier('high', true)).toBe('high');
    expect(resolveTier('high', false)).toBe('high');
    expect(resolveTier('low', false)).toBe('low');
    expect(resolveTier('low', true)).toBe('low');
  });

  it('starts auto on high and only drops once the watchdog says so', () => {
    expect(resolveTier('auto', false)).toBe('high');
    expect(resolveTier('auto', true)).toBe('low');
  });
});

describe('the live mirror', () => {
  it('starts high, so a host that never wires the setting still gets the authored look', () => {
    expect(activeQuality().tier).toBe('high');
  });

  it('swaps the whole profile, not just the tier name', () => {
    setActiveQuality('low');
    expect(activeQuality()).toEqual(qualityProfile('low'));
    setActiveQuality('high');
    expect(activeQuality()).toEqual(qualityProfile('high'));
  });
});

describe('QUALITY_SETTINGS (the settings screen cycles this order)', () => {
  it('lists auto first and covers every setting exactly once', () => {
    expect(QUALITY_SETTINGS[0]).toBe('auto');
    expect([...QUALITY_SETTINGS].sort()).toEqual(['auto', 'high', 'low']);
  });
});
