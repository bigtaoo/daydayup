/**
 * WebAudio — the Web SFX backend (design/11). No real DOM/AudioContext here (plain-node
 * vitest, per daydayup-testing-conventions memory): `window` is a hand-rolled fake that
 * captures registered gesture listeners, and `globalThis.AudioContext` is stubbed with a
 * fake constructor recording its own calls. `../audioSynth`'s `playCue` is mocked so
 * these tests only exercise WebAudio's own ensure/resume/volume/gate logic, not the
 * synth voices themselves (covered by `audioSynth.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebAudio } from './WebAudio';

vi.mock('../audioSynth', () => ({ playCue: vi.fn() }));
import { playCue } from '../audioSynth';

type GestureHandler = () => void;

function fakeWindow() {
  const listeners: Record<string, GestureHandler[]> = {};
  return {
    addEventListener(type: string, fn: GestureHandler) {
      (listeners[type] ??= []).push(fn);
    },
    fire(type: string) {
      for (const fn of listeners[type] ?? []) fn();
    },
  };
}

class FakeGainNode {
  gain = { value: 0 };
  connect = vi.fn();
}

const instances: FakeAudioContext[] = [];

class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination = {};
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  createGain = vi.fn(() => new FakeGainNode());
  constructor() {
    instances.push(this);
  }
}

let win: ReturnType<typeof fakeWindow>;

beforeEach(() => {
  vi.clearAllMocks();
  instances.length = 0;
  win = fakeWindow();
  vi.stubGlobal('window', win);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

describe('WebAudio — construction / autoplay gate', () => {
  it.each(['pointerdown', 'keydown', 'touchstart'] as const)(
    "a '%s' gesture resumes a lazily-constructed context",
    async (gesture) => {
      new WebAudio();
      expect(instances).toHaveLength(0); // nothing constructed yet — WebAudio() alone doesn't ensure()
      win.fire(gesture);
      await Promise.resolve();
      expect(instances).toHaveLength(1);
      expect(instances[0]!.resume).toHaveBeenCalledTimes(1);
    },
  );

  it('does nothing (no throw) when window is undefined (SSR/non-browser)', () => {
    vi.stubGlobal('window', undefined);
    expect(() => new WebAudio()).not.toThrow();
  });
});

describe('WebAudio — ensure() guards a missing AudioContext', () => {
  it('play() is a silent no-op when neither AudioContext nor webkitAudioContext exists', () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const audio = new WebAudio();
    expect(() => audio.play('muzzle')).not.toThrow();
    expect(playCue).not.toHaveBeenCalled();
  });

  it('falls back to webkitAudioContext when AudioContext is absent', async () => {
    let constructed = 0;
    class CountingCtx extends FakeAudioContext {
      constructor() {
        super();
        constructed++;
      }
    }
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', CountingCtx);
    const audio = new WebAudio();
    audio.resume();
    await Promise.resolve();
    audio.play('muzzle');
    expect(constructed).toBe(1); // the fallback ctor, not AudioContext, actually built the context
    expect(playCue).toHaveBeenCalledTimes(1);
  });
});

describe('WebAudio — play() gates on ctx.state === "running"', () => {
  it('does NOT play while the context is still suspended', () => {
    const audio = new WebAudio();
    audio.play('muzzle'); // ensure() constructs the ctx, but it starts 'suspended'
    expect(playCue).not.toHaveBeenCalled();
  });

  it('plays once resumed (state flips to "running")', async () => {
    const audio = new WebAudio();
    audio.resume(); // constructs + resumes
    await Promise.resolve(); // let the fake async resume() settle
    audio.play('muzzle');
    expect(playCue).toHaveBeenCalledTimes(1);
    expect(playCue).toHaveBeenCalledWith('muzzle', expect.anything(), expect.anything());
  });

  it('the SAME context is reused across multiple play() calls — ensure() only constructs once', async () => {
    let constructed = 0;
    class CountingCtx extends FakeAudioContext {
      constructor() {
        super();
        constructed++;
      }
    }
    vi.stubGlobal('AudioContext', CountingCtx);
    const audio = new WebAudio();
    audio.resume();
    await Promise.resolve();
    audio.play('muzzle');
    audio.play('impact');
    expect(constructed).toBe(1);
  });
});

describe('WebAudio — setSfxVolume', () => {
  it('clamps to [0, 1] and is a no-op on the gain node before one exists', () => {
    const audio = new WebAudio();
    expect(() => audio.setSfxVolume(5)).not.toThrow(); // clamps, no ctx/gain yet — no throw
    expect(() => audio.setSfxVolume(-1)).not.toThrow();
  });

  it('updates the real gain node once the context has been constructed', async () => {
    const audio = new WebAudio();
    audio.resume();
    await Promise.resolve();
    audio.setSfxVolume(0.75);
    audio.play('muzzle'); // forces ensure() again to grab the (already-constructed) ctx/gain
    expect(playCue).toHaveBeenCalledWith('muzzle', expect.anything(), expect.objectContaining({ gain: { value: 0.75 } }));
  });
});

describe('WebAudio — setMusicVolume', () => {
  it('accepts a value and does nothing (music not authored yet)', () => {
    const audio = new WebAudio();
    expect(() => audio.setMusicVolume(0.5)).not.toThrow();
  });
});
