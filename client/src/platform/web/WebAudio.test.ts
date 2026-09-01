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

// The sample loader reads through the art asset host (render/assetHost.ts) — faked here so
// these tests stay offline, and so the 50 real paths are not fetched 50 times per case.
vi.mock('../../render/assetHost', () => ({ readBinaryAsset: vi.fn(async () => new ArrayBuffer(8)) }));
import { readBinaryAsset } from '../../render/assetHost';
import { allSfxPaths } from '../../audio/cueCatalogue';

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
  gain = { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
  // Returns its destination, like the real `AudioNode.connect()`, so the mixer's
  // `src.connect(gain).connect(bus)` chain works against the fake too.
  connect = vi.fn((dest: unknown) => dest);
}

class FakeBufferSource {
  buffer: unknown = null;
  playbackRate = { value: 1 };
  connect = vi.fn((dest: unknown) => dest);
  start = vi.fn();
  stop = vi.fn();
}

const instances: FakeAudioContext[] = [];

class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination = {};
  currentTime = 0;
  /** Every gain node this context made, in order: the SFX bus first (ensure() builds it
   *  before anything else), then the mixer's per-voice gains. */
  gains: FakeGainNode[] = [];
  sources: FakeBufferSource[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  createGain = vi.fn(() => {
    const g = new FakeGainNode();
    this.gains.push(g);
    return g;
  });
  createBufferSource = vi.fn(() => {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  });
  // The promise form; `audio/decodeAudio.test.ts` covers the callback one this runtime may
  // hand us instead.
  decodeAudioData = vi.fn(async () => ({ duration: 0.1 }) as unknown as AudioBuffer);
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
    // The SFX bus is the FIRST gain node the context ever made, and the MUSIC bus (2026-08-31)
    // is the second — design/11's "two buses + settings volume", so a player can mute the bed
    // and keep the combat feedback. `muzzle`'s catalogue gain is not 1.0, so the mixer hands the
    // synth voice a trim node connected to the SFX bus rather than the bus itself; the volume
    // still has to land on the bus. Taken as first/last rather than by index so adding a node
    // between them fails on the assertion that is actually wrong, not on this destructuring.
    const gains = instances[0]!.gains;
    const bus = gains[0];
    const trim = gains.at(-1);
    expect(bus!.gain.value).toBe(0.75);
    expect(playCue).toHaveBeenCalledWith('muzzle', expect.anything(), trim);
    expect(trim!.connect).toHaveBeenCalledWith(bus);
  });
});

describe('WebAudio — preload() (design/11 boot preload)', () => {
  it('loads the whole shipped set through the asset host, WITHOUT waiting for a gesture', async () => {
    // The point of preloading on a suspended context: decode does not need the autoplay
    // gate, so the first shot of a run can already be a real sample.
    const audio = new WebAudio();
    await audio.preload();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.state).toBe('suspended');
    expect((readBinaryAsset as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort())
      .toEqual(allSfxPaths().slice().sort());
    expect(instances[0]!.decodeAudioData).toHaveBeenCalledTimes(50);
  });

  it('plays a decoded sample once resumed, instead of the synth voice', async () => {
    const audio = new WebAudio();
    await audio.preload();
    audio.resume();
    await Promise.resolve();
    audio.play('impact');
    expect(playCue).not.toHaveBeenCalled();
    expect(instances[0]!.sources).toHaveLength(1);
    expect(instances[0]!.sources[0]!.start).toHaveBeenCalled();
  });

  it('still plays SOMETHING when every read fails', async () => {
    (readBinaryAsset as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audio = new WebAudio();
    await expect(audio.preload()).resolves.toBeUndefined();
    audio.resume();
    await Promise.resolve();
    audio.play('impact');
    expect(playCue).toHaveBeenCalledTimes(1); // the synth voice carries it
    warn.mockRestore();
  });

  it('is a no-op (not a throw) where there is no AudioContext at all', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const audio = new WebAudio();
    await expect(audio.preload()).resolves.toBeUndefined();
    expect(readBinaryAsset).not.toHaveBeenCalled();
  });
});

describe('WebAudio — setMusicVolume', () => {
  // The rest of this method's behaviour — the value landing on the MUSIC bus, being retained
  // when set before the context exists, clamping, and a muted bus still running the decks — is
  // owned by `audio/musicPipeline.test.ts`, which has the whole graph to assert against. Until
  // 2026-09-01 the case here asserted "accepts a value and does nothing (music not authored
  // yet)", which stopped being true when music shipped: a passing test naming a contract the
  // class no longer has is worse than no case at all.

  it('does not build a context — the volume arrives at boot, the gesture has not happened', () => {
    // `settingsBinding.load()` calls this before any user gesture. Constructing the context here
    // would create a suspended one at boot and move where the autoplay gate is decided, and on
    // the WeChat side the equivalent slip opens two streams into a subpackage that may not have
    // landed. Cheap to assert, invisible if it regresses.
    const audio = new WebAudio();
    // NOT 0.5, which is the field's own default: the first version of this case used it, and a
    // mutation deleting the assignment entirely survived, because the bus was going to read 0.5
    // either way. A test value has to differ from the value the code would produce by doing
    // nothing (daydayup-test-assertion-craft memory).
    audio.setMusicVolume(0.3);
    expect(instances).toHaveLength(0);
    // ...and the value is not lost: the first real ensure() writes it to the music bus, which is
    // the SECOND gain node the context makes (the SFX bus is first).
    audio.resume();
    audio.play('muzzle');
    expect(instances[0]!.gains[1]!.gain.value).toBe(0.3);
  });
});
