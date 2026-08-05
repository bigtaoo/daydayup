/**
 * SettingsState (design/10 volume persistence) — `defaultSettingsState` already gets
 * indirect coverage via store.test.ts's import of it; this file covers
 * `effectiveVolume`'s own branches only.
 */
import { describe, it, expect } from 'vitest';
import { effectiveVolume, defaultSettingsState } from './SettingsState';

describe('effectiveVolume', () => {
  it('returns 0 for both buses when muted, regardless of the stored slider values', () => {
    const s = { ...defaultSettingsState(), master: 1, sfx: 0.8, music: 0.6, muted: true };
    expect(effectiveVolume(s, 'sfx')).toBe(0);
    expect(effectiveVolume(s, 'music')).toBe(0);
  });

  it('multiplies master by the per-bus slider when unmuted', () => {
    const s = { ...defaultSettingsState(), master: 0.5, sfx: 0.8, music: 0.4, muted: false };
    expect(effectiveVolume(s, 'sfx')).toBeCloseTo(0.4);
    expect(effectiveVolume(s, 'music')).toBeCloseTo(0.2);
  });

  it('clamps the product down to 1 if it would otherwise exceed it', () => {
    // Not reachable through the normal 0..1 slider UI, but defends against a corrupt
    // or hand-edited save the same way store.ts's own migrate() defends elsewhere.
    const s = { ...defaultSettingsState(), master: 2, sfx: 2, music: 2, muted: false };
    expect(effectiveVolume(s, 'sfx')).toBe(1);
    expect(effectiveVolume(s, 'music')).toBe(1);
  });

  it('clamps a negative product up to 0', () => {
    const s = { ...defaultSettingsState(), master: -1, sfx: 0.5, music: 0.5, muted: false };
    expect(effectiveVolume(s, 'sfx')).toBe(0);
    expect(effectiveVolume(s, 'music')).toBe(0);
  });

  it('unmuting restores the effective volume from the still-stored slider values', () => {
    const muted = { ...defaultSettingsState(), master: 1, sfx: 0.7, music: 0.3, muted: true };
    expect(effectiveVolume(muted, 'sfx')).toBe(0);
    const unmuted = { ...muted, muted: false };
    expect(effectiveVolume(unmuted, 'sfx')).toBeCloseTo(0.7);
  });
});
