/**
 * `VoiceBudget` — the concurrency cap, tested with plain numbers (it holds no WebAudio types
 * on purpose).
 *
 * The cases that matter are the ones where a cap misbehaves in a way nobody notices: a
 * budget that never releases finished voices goes permanently quiet after N cues, and a
 * budget that steals on EQUAL priority turns a stream of `muzzle`s into a stream of clipped
 * `muzzle`s. Both are here.
 */
import { describe, it, expect, vi } from 'vitest';
import { VoiceBudget } from './VoiceBudget';

const noop = () => {};

describe('VoiceBudget — under the cap', () => {
  it('grants every claim while slots remain', () => {
    const b = new VoiceBudget(3);
    expect(b.claim(10, 0, 1, noop)).toBe(true);
    expect(b.claim(10, 0, 1, noop)).toBe(true);
    expect(b.claim(10, 0, 1, noop)).toBe(true);
    expect(b.held).toBe(3);
  });
});

describe('VoiceBudget — at the cap', () => {
  it('refuses a cue of EQUAL priority, and steals nothing', () => {
    const stop = vi.fn();
    const b = new VoiceBudget(1);
    expect(b.claim(20, 0, 1, stop)).toBe(true);
    expect(b.claim(20, 0.1, 1, noop)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(b.held).toBe(1);
  });

  it('refuses a cue of LOWER priority', () => {
    const stop = vi.fn();
    const b = new VoiceBudget(1);
    b.claim(60, 0, 1, stop);
    expect(b.claim(20, 0.1, 1, noop)).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('steals the weakest slot for a HIGHER priority cue', () => {
    const weak = vi.fn();
    const strong = vi.fn();
    const b = new VoiceBudget(2);
    b.claim(20, 0, 1, weak); // muzzle-ish
    b.claim(60, 0, 1, strong); // impact-ish
    expect(b.claim(95, 0.1, 1, noop)).toBe(true); // deflect outranks both
    expect(weak).toHaveBeenCalledTimes(1);
    expect(strong).not.toHaveBeenCalled();
    expect(b.held).toBe(2); // the stolen slot was handed over, not added to
  });

  it('steals the OLDEST among equally weak voices', () => {
    const first = vi.fn();
    const second = vi.fn();
    const b = new VoiceBudget(2);
    b.claim(20, 0, 5, first);
    b.claim(20, 0, 5, second);
    b.claim(70, 1, 5, noop);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('VoiceBudget — retiring finished voices', () => {
  it('frees a slot once the voice has played out', () => {
    const stop = vi.fn();
    const b = new VoiceBudget(1);
    b.claim(20, 0, 0.14, stop); // a 140 ms muzzle
    expect(b.claim(20, 0.1, 0.24, noop)).toBe(false); // still sounding
    expect(b.claim(20, 0.14, 0.28, noop)).toBe(true); // finished exactly now
    expect(stop).not.toHaveBeenCalled(); // it ended on its own; nothing to cut short
    expect(b.held).toBe(1);
  });

  it('does not go permanently quiet: a long run of claims keeps being granted', () => {
    // The failure this guards is a purge that never runs — the mix would die after `cap`
    // cues and look exactly like "audio stopped working".
    const b = new VoiceBudget(4);
    let granted = 0;
    for (let i = 0; i < 100; i++) {
      // One 70 ms cue every 100 ms — never more than one voice should ever overlap.
      if (b.claim(60, i * 0.1, i * 0.1 + 0.07, noop)) granted++;
    }
    expect(granted).toBe(100);
    expect(b.held).toBe(1);
  });

  it('purges every expired voice, not just the first it finds', () => {
    const b = new VoiceBudget(3);
    b.claim(60, 0, 0.1, noop);
    b.claim(60, 0, 0.1, noop);
    b.claim(60, 0, 0.1, noop);
    expect(b.claim(60, 0.2, 0.3, noop)).toBe(true);
    expect(b.held).toBe(1);
  });
});
