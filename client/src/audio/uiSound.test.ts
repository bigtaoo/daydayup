/**
 * The UI cue sink (`uiSound.ts`) — small, but it is the only thing standing between ~40
 * buttons and the audio bus, and every way it can break is inaudible rather than loud:
 * an unattached sink drops every click silently, and a `play` that skips `resume` leaves a
 * WeChat session muted for its whole first screen with nothing in the console.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setUiAudio, playUiCue, type UiCue } from './uiSound';
import { ALL_CUES } from './cueCatalogue';
import type { AudioBus } from '../platform/types';

/** A bus that records the ORDER of calls, not just that they happened — `resume` before
 *  `play` is the part with consequences. */
function fakeBus() {
  const calls: string[] = [];
  const bus: AudioBus = {
    preload: async () => {},
    play: (cue, count) => { calls.push(count === undefined ? `play:${cue}` : `play:${cue}:${count}`); },
    setSfxVolume: () => {},
    setMusicVolume: () => {},
    updateMusic: () => {},
    resume: () => { calls.push('resume'); },
  };
  return { bus, calls };
}

// Module state outlives a test; leaving a bus attached would let one case observe another's.
afterEach(() => setUiAudio(null));

describe('uiSound — the sink', () => {
  it('is a silent no-op with nothing attached', () => {
    // The normal state in widget tests and in any headless boot that never builds `Game`.
    expect(() => playUiCue('ui.tap')).not.toThrow();
  });

  it('resumes the context BEFORE playing, every time', () => {
    // A tap is the user gesture design/11's autoplay gate wants, and on WeChat it is the only
    // one — `WeChatAudio` registers no global listeners the way `WebAudio` does. Dropping the
    // resume would leave the mini-game suspended until the player reached a `Game.confirm()`.
    const { bus, calls } = fakeBus();
    setUiAudio(bus);
    playUiCue('ui.tap');
    playUiCue('ui.back');
    expect(calls).toEqual(['resume', 'play:ui.tap', 'resume', 'play:ui.back']);
  });

  it('plays one voice per call — a UI cue is never coalesced', () => {
    // `count` is the engine path's frame-coalescing knob (EventReactor). A UI cue answers one
    // finger, so it must reach the mixer at gain ×1, not boosted.
    const { bus, calls } = fakeBus();
    setUiAudio(bus);
    playUiCue('ui.toggle');
    expect(calls).toEqual(['resume', 'play:ui.toggle']);
  });

  it('stops playing once detached', () => {
    const { bus, calls } = fakeBus();
    setUiAudio(bus);
    playUiCue('ui.tap');
    setUiAudio(null);
    playUiCue('ui.tap');
    expect(calls).toEqual(['resume', 'play:ui.tap']);
  });

  it('sends to the CURRENT bus after a re-attach', () => {
    const first = fakeBus();
    const second = fakeBus();
    setUiAudio(first.bus);
    setUiAudio(second.bus);
    playUiCue('ui.denied');
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(['resume', 'play:ui.denied']);
  });
});

describe('uiSound — the cue family', () => {
  it('is exactly the four ui.* cues, and each is a real catalogued cue', () => {
    // `UiCue` is derived from `AudioCue` by prefix, so this pins the OTHER direction: that the
    // family the UI actually plays is the one the catalogue, the shipped files and
    // `audioSynth`'s voice table were all built for. A fifth `ui.*` cue added to the union
    // reaches here before it reaches a player.
    const family = ALL_CUES.filter((c) => c.startsWith('ui.'));
    expect(family).toEqual(['ui.tap', 'ui.back', 'ui.toggle', 'ui.denied']);
    // Compile-time half: every member of the runtime list is assignable to `UiCue`.
    const typed: UiCue[] = family as UiCue[];
    expect(typed).toHaveLength(4);
  });

  it('passes the cue through untouched — no remapping between the widget and the bus', () => {
    const { bus, calls } = fakeBus();
    setUiAudio(bus);
    for (const cue of ALL_CUES.filter((c) => c.startsWith('ui.')) as UiCue[]) playUiCue(cue);
    expect(calls.filter((c) => c !== 'resume'))
      .toEqual(['play:ui.tap', 'play:ui.back', 'play:ui.toggle', 'play:ui.denied']);
  });

  it('survives a bus that throws, and says so exactly once', () => {
    // This runs inside a Pixi `pointertap` emit, after the button's own handler — an escaping
    // throw would break the rest of that emit in exchange for a sound. The message is asserted
    // because it is the guard's ONLY observable effect: without it, deleting the try/catch
    // still passes everything else here.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus: AudioBus = { ...fakeBus().bus, resume: () => { throw new Error('no context'); } };
    setUiAudio(bus);
    expect(() => { playUiCue('ui.tap'); playUiCue('ui.tap'); }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1); // not once per press
    expect(String(warn.mock.calls[0]![0])).toContain('ui.tap');
    // A fresh attach is a fresh session's worth of warnings.
    setUiAudio(bus);
    playUiCue('ui.tap');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
