/**
 * WeChatAudio — the WeChat SFX backend (design/11), driving the same synth voice table
 * as `WebAudio` through `wx.createWebAudioContext()`. No real DOM/wx runtime here
 * (plain-node vitest): `wx` is a hand-rolled fake exposing just
 * `createWebAudioContext`, and `../audioSynth`'s `playCue` is mocked so these tests
 * only exercise WeChatAudio's own ensure/resume/volume/gate/degrade logic — mirrors
 * `WebAudio.test.ts`'s own structure, since the two classes are near-identical apart
 * from how the `AudioContext` is obtained.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WeChatAudio } from './WeChatAudio';

vi.mock('../audioSynth', () => ({ playCue: vi.fn() }));
import { playCue } from '../audioSynth';

// The sample loader reads through the art asset host (render/assetHost.ts), which on this
// platform is `FileSystemManager.readFileSync` — faked here so these tests stay off both the
// filesystem and the wx runtime.
vi.mock('../../render/assetHost', () => ({ readBinaryAsset: vi.fn(async () => new ArrayBuffer(8)) }));
import { readBinaryAsset } from '../../render/assetHost';
import { allSfxPaths } from '../../audio/cueCatalogue';

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

beforeEach(() => {
  vi.clearAllMocks();
  instances.length = 0;
  vi.stubGlobal('wx', { createWebAudioContext: () => new FakeAudioContext() });
});

describe('WeChatAudio — ensure() guards an unsupported base library', () => {
  it('play() is a silent no-op when wx.createWebAudioContext is absent', () => {
    vi.stubGlobal('wx', {});
    const audio = new WeChatAudio();
    expect(() => audio.play('muzzle')).not.toThrow();
    expect(playCue).not.toHaveBeenCalled();
  });

  it('degrades to the no-op path (and stays there) if construction throws once', () => {
    let calls = 0;
    vi.stubGlobal('wx', {
      createWebAudioContext: () => {
        calls++;
        throw new Error('base library claims support but construction failed');
      },
    });
    const audio = new WeChatAudio();
    expect(() => audio.play('muzzle')).not.toThrow();
    expect(() => audio.play('impact')).not.toThrow(); // second call must NOT retry
    expect(calls).toBe(1); // `supported = false` after the first failure short-circuits ensure()
    expect(playCue).not.toHaveBeenCalled();
  });
});

describe('WeChatAudio — play() gates on ctx.state === "running"', () => {
  it('does NOT play while the context is still suspended', () => {
    const audio = new WeChatAudio();
    audio.play('muzzle');
    expect(playCue).not.toHaveBeenCalled();
  });

  it('plays once resumed (state flips to "running")', async () => {
    const audio = new WeChatAudio();
    audio.resume();
    await Promise.resolve();
    audio.play('muzzle');
    expect(playCue).toHaveBeenCalledTimes(1);
    expect(playCue).toHaveBeenCalledWith('muzzle', expect.anything(), expect.anything());
  });

  it('the SAME context is reused across multiple play() calls — ensure() only constructs once', async () => {
    const audio = new WeChatAudio();
    audio.resume();
    await Promise.resolve();
    audio.play('muzzle');
    audio.play('impact');
    expect(instances).toHaveLength(1);
  });
});

describe('WeChatAudio — resume()', () => {
  it('calls ctx.resume() only when suspended', async () => {
    const audio = new WeChatAudio();
    audio.resume();
    await Promise.resolve();
    expect(instances[0]!.resume).toHaveBeenCalledTimes(1);
    audio.resume(); // already running — must not call resume() again
    expect(instances[0]!.resume).toHaveBeenCalledTimes(1);
  });
});

describe('WeChatAudio — setSfxVolume', () => {
  it('clamps to [0, 1] and is a no-op before a context exists', () => {
    const audio = new WeChatAudio();
    expect(() => audio.setSfxVolume(5)).not.toThrow();
    expect(() => audio.setSfxVolume(-1)).not.toThrow();
  });

  it('updates the real gain node once the context has been constructed', async () => {
    const audio = new WeChatAudio();
    audio.resume();
    await Promise.resolve();
    audio.setSfxVolume(0.75);
    audio.play('muzzle');
    // Same as the web backend: the bus is the context's first gain node, and `muzzle`'s
    // sub-1.0 catalogue gain means the synth voice reaches it through a trim node.
    const [bus, trim] = instances[0]!.gains;
    expect(bus!.gain.value).toBe(0.75);
    expect(playCue).toHaveBeenCalledWith('muzzle', expect.anything(), trim);
    expect(trim!.connect).toHaveBeenCalledWith(bus);
  });
});

describe('WeChatAudio — preload() (design/11 boot preload)', () => {
  it('loads the whole shipped set through the asset host', async () => {
    // Preloading matters more here than on web: design/11 expects a first-play decode stall
    // on this runtime, which is exactly what a cold `deflect` must not pay.
    const audio = new WeChatAudio();
    await audio.preload();
    expect((readBinaryAsset as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort())
      .toEqual(allSfxPaths().slice().sort());
    expect(instances[0]!.decodeAudioData).toHaveBeenCalledTimes(50);
  });

  it('plays a decoded sample once resumed, instead of the synth voice', async () => {
    const audio = new WeChatAudio();
    await audio.preload();
    audio.resume();
    await Promise.resolve();
    audio.play('impact');
    expect(playCue).not.toHaveBeenCalled();
    expect(instances[0]!.sources).toHaveLength(1);
    expect(instances[0]!.sources[0]!.start).toHaveBeenCalled();
  });

  it('is a no-op on a base library without createWebAudioContext', async () => {
    vi.stubGlobal('wx', {});
    const audio = new WeChatAudio();
    await expect(audio.preload()).resolves.toBeUndefined();
    expect(readBinaryAsset).not.toHaveBeenCalled();
  });
});

describe('WeChatAudio — setMusicVolume', () => {
  // As on web, the substance of this method — the settings volume multiplied into each stream's
  // own `.volume` alongside that deck's crossfade level, applied to decks built later, and a
  // muted stream that keeps running — is owned by `audio/wechatMusicLoad.test.ts`, which has
  // both real files and a `wx` fake. Until 2026-09-01 the case here asserted "accepts a value
  // and does nothing (music not authored yet)": no longer true, and green.

  it('does not open a stream — the volume arrives at boot, before the subpackage has landed', () => {
    // The decks are built lazily on the first `updateMusic` for a reason: their `src` lives in
    // the `music` subpackage and does not resolve until `wx.loadSubpackage` has run. Opening
    // them from the settings slider instead would put two `InnerAudioContext` streams — and two
    // onError logs — ahead of the pack that makes them playable.
    const createInnerAudioContext = vi.fn();
    vi.stubGlobal('wx', { createWebAudioContext: () => new FakeAudioContext(), createInnerAudioContext });
    const audio = new WeChatAudio();
    audio.setMusicVolume(0.5);
    expect(createInnerAudioContext).not.toHaveBeenCalled();
    expect(instances).toHaveLength(0); // nor the SFX context, which is a separate path entirely
  });

  // Not asserted, because it cannot be: this method's own `Math.max/min` clamp is unobservable.
  // Every value it stores reaches the streams through `WeChatMusicDeck.setBusVolume`, which
  // clamps again, and through `applyVolume`, which clamps the product — so deleting the clamp
  // here changes nothing any test can see. An equivalent mutant, left recorded rather than
  // killed by reaching into a private field. `weChatMusicDeck.test.ts` owns the clamp that does
  // the work.

  it('survives being told a volume on a base library with no streaming API at all', () => {
    vi.stubGlobal('wx', { createWebAudioContext: () => new FakeAudioContext() });
    const audio = new WeChatAudio();
    audio.updateMusic('menu', 16); // takes the degrade path: no decks exist and none will
    expect(() => audio.setMusicVolume(0.5)).not.toThrow();
  });
});
