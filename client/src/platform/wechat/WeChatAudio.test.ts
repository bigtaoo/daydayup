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
    expect(playCue).toHaveBeenCalledWith('muzzle', expect.anything(), expect.objectContaining({ gain: { value: 0.75 } }));
  });
});

describe('WeChatAudio — setMusicVolume', () => {
  it('accepts a value and does nothing (music not authored yet)', () => {
    const audio = new WeChatAudio();
    expect(() => audio.setMusicVolume(0.5)).not.toThrow();
  });
});
