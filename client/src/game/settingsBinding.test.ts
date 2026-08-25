/**
 * `SettingsBinding` (2026-08-25) — the persisted settings and the four places a change to them
 * has to land.
 *
 * The bug shape this exists to prevent, and the reason it is a class rather than four private
 * methods on `Game`: a setting that applies on CHANGE but not at BOOT. That is a two-call-site
 * invariant, and it has to be kept by hand every time a new setting is added — quality was the
 * fifth. So every case below checks both paths, not one.
 */
import { describe, it, expect } from 'vitest';
import { SettingsBinding, type SettingsBindingDeps } from './settingsBinding';
import { MemorySettingsStore, defaultSettingsState, type SettingsState } from '../settings';
import { getLocale, resetLocaleForTests } from '../i18n';

function harness(initial: Partial<SettingsState> = {}) {
  const audio = { sfx: -1, music: -1 };
  const input = { mirrored: null as boolean | null };
  const quality = { applied: [] as string[], pinned: [] as string[] };
  const deps: SettingsBindingDeps = {
    audio: {
      setSfxVolume: (v) => { audio.sfx = v; },
      setMusicVolume: (v) => { audio.music = v; },
    },
    input: { setControlMirror: (m) => { input.mirrored = m; } },
    quality: {
      apply: (s) => quality.applied.push(s),
      pin: (s) => quality.pinned.push(s),
    },
  };
  const store = new MemorySettingsStore({ ...defaultSettingsState(), ...initial });
  return { binding: new SettingsBinding(deps, store), audio, input, quality, store };
}

describe('SettingsBinding.load — everything takes effect at boot', () => {
  it('applies volume, control layout and quality from the persisted state', () => {
    const h = harness({ master: 1, sfx: 0.25, music: 0.75, controlLayout: 'mirrored', quality: 'low' });
    h.binding.load();
    expect(h.audio.sfx).toBe(0.25);
    expect(h.audio.music).toBe(0.75);
    expect(h.input.mirrored).toBe(true);
    expect(h.quality.applied).toEqual(['low']);
  });

  it('sets the live locale mirror, not just the stored copy', () => {
    resetLocaleForTests();
    const h = harness({ locale: 'ru' });
    h.binding.load();
    expect(getLocale()).toBe('ru');
    resetLocaleForTests();
  });

  it('honours mute at boot rather than only after the first mute tap', () => {
    const h = harness({ muted: true, sfx: 0.9, music: 0.9 });
    h.binding.load();
    expect(h.audio.sfx).toBe(0);
    expect(h.audio.music).toBe(0);
  });

  it('tolerates a host with no control mirror at all', () => {
    // A test fake, or any InputSource with no touch controls. Not an error — there is simply
    // nothing to mirror.
    const store = new MemorySettingsStore({ ...defaultSettingsState(), controlLayout: 'mirrored' });
    const binding = new SettingsBinding(
      { audio: { setSfxVolume: () => {}, setMusicVolume: () => {} }, input: {}, quality: { apply: () => {}, pin: () => {} } },
      store,
    );
    expect(() => binding.load()).not.toThrow();
  });
});

describe('SettingsBinding.update — a change persists and applies', () => {
  it('writes to the store and re-applies the audio buses', () => {
    const h = harness();
    h.binding.load();
    h.binding.update({ ...h.binding.state, sfx: 0.1, music: 0.2 });
    expect(h.audio.sfx).toBeCloseTo(0.1);
    expect(h.audio.music).toBeCloseTo(0.2);
    expect(h.store.load().sfx).toBeCloseTo(0.1);
  });

  it('pins the quality tier only when the quality actually changed', () => {
    const h = harness({ quality: 'auto' });
    h.binding.load();
    h.binding.update({ ...h.binding.state, muted: true });
    // `pin` can reallocate the renderer's backing buffer — a volume drag must not pay for one
    // on every frame of the drag.
    expect(h.quality.pinned).toEqual([]);
    h.binding.update({ ...h.binding.state, quality: 'low' });
    expect(h.quality.pinned).toEqual(['low']);
  });

  it('exposes the new state immediately, so the screen re-renders what it just reported', () => {
    const h = harness();
    h.binding.load();
    h.binding.update({ ...h.binding.state, quality: 'high', controlLayout: 'mirrored' });
    expect(h.binding.state.quality).toBe('high');
    expect(h.binding.state.controlLayout).toBe('mirrored');
    expect(h.input.mirrored).toBe(true);
  });
});
