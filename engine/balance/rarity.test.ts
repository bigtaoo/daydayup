import { describe, it, expect } from 'vitest';
import {
  RARITY_TIERS,
  RARITY_ORDER,
  DEFAULT_RARITY,
  applyQuality,
  type RarityTier,
} from './rarity';
import { WEAPON_SPECS, toSimSpec } from '../content/weapons';

describe('RARITY_TIERS (design/14 intrinsic rarity)', () => {
  it('defines all five tiers in ascending order', () => {
    expect(RARITY_ORDER).toEqual(['common', 'fine', 'epic', 'legend', 'legendary']);
    for (const tier of RARITY_ORDER) expect(RARITY_TIERS[tier]).toBeDefined();
  });

  it('common is the identity baseline and the default', () => {
    expect(DEFAULT_RARITY).toBe('common');
    expect(RARITY_TIERS.common.qualityMult).toBe(1000);
  });

  it('quality edge is monotonically increasing and small (never crushing, ≤ +20%)', () => {
    let prev = 0;
    for (const tier of RARITY_ORDER) {
      const mult = RARITY_TIERS[tier].qualityMult;
      expect(mult).toBeGreaterThan(prev); // strictly higher each step
      prev = mult;
    }
    expect(RARITY_TIERS.legendary.qualityMult).toBeLessThanOrEqual(1200);
  });

  it('every tier has a distinct colour key (白蓝紫橙金)', () => {
    const keys = RARITY_ORDER.map((t) => RARITY_TIERS[t].colorKey);
    expect(keys).toEqual(['white', 'blue', 'purple', 'orange', 'gold']);
    expect(new Set(keys).size).toBe(5);
  });
});

describe('applyQuality (per-mille, convert-once, deterministic)', () => {
  it('common leaves an integer stat untouched', () => {
    for (const base of [1, 2, 3, 7, 100]) expect(applyQuality(base, 'common')).toBe(base);
  });

  it('scales by the per-mille edge with a single round', () => {
    // 5 dmg: fine 5.25→5, epic 5.5→6, legend 5.75→6, legendary 6.0→6.
    expect(applyQuality(5, 'fine')).toBe(5);
    expect(applyQuality(5, 'epic')).toBe(6);
    expect(applyQuality(5, 'legend')).toBe(6);
    expect(applyQuality(5, 'legendary')).toBe(6);
  });

  it('is a pure function — identical input, identical output', () => {
    for (const tier of RARITY_ORDER) {
      expect(applyQuality(13, tier)).toBe(applyQuality(13, tier));
    }
  });
});

describe('weapon catalog carries intrinsic rarity', () => {
  it('every authored weapon has a valid rarity tier', () => {
    for (const spec of Object.values(WEAPON_SPECS)) {
      expect(RARITY_ORDER).toContain(spec.rarity as RarityTier);
    }
  });

  it('toSimSpec carries the tier through and applies the quality edge to damage', () => {
    for (const spec of Object.values(WEAPON_SPECS)) {
      const sim = toSimSpec(spec);
      expect(sim.rarity).toBe(spec.rarity);
      expect(sim.damage).toBe(applyQuality(spec.damage, spec.rarity));
    }
  });

  it('INVARIANT: the shipped placeholder tiers do not change any weapon damage', () => {
    // The demo tiers were chosen so the small edge rounds back to the authored
    // integer for every current weapon — so this is a purely additive change: no
    // sim-outcome shift, no serialized-byte change, no ENGINE_VERSION bump. Assigning
    // a tier whose mult crosses a rounding boundary (e.g. legendary on 3 → 4) would
    // fail here, flagging that a version bump + golden regen is now required.
    for (const spec of Object.values(WEAPON_SPECS)) {
      expect(toSimSpec(spec).damage).toBe(spec.damage);
    }
  });
});
