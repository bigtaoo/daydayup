/**
 * audioSynth — the shared procedural SFX voice table (design/11 placeholder audio)
 * both `WebAudio`/`WeChatAudio` drive through a real (or fake) WebAudio-API-shaped
 * `AudioContext`/`GainNode` pair. No real AudioContext needed — a hand-rolled fake
 * graph (nodes that record their own calls, `connect()` returning whatever was
 * passed in, matching real `AudioNode.connect()`'s own return-the-destination
 * behavior so `a.connect(b).connect(c)` chains exactly like the production code)
 * exercises the actual `tone`/`noise`/`playCue` functions directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { tone, noise, playCue } from './audioSynth';
// The cue list comes from `audio/cueCatalogue.ts`'s exhaustive `Record` (a type can't be
// iterated at runtime, but that table can) so every voice in the VOICES table gets
// exercised, not just the ones a handful of hand-picked assertions happen to touch.
import { ALL_CUES } from '../audio/cueCatalogue';
import type { AudioCue } from './types';

function fakeParam(initial = 0) {
  return { value: initial, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
}

function fakeNode() {
  return { connect: vi.fn((dest: unknown) => dest) };
}

function fakeOscillator() {
  return { ...fakeNode(), type: 'sine' as OscillatorType, frequency: fakeParam(), start: vi.fn(), stop: vi.fn() };
}

function fakeGainNode() {
  return { ...fakeNode(), gain: fakeParam() };
}

function fakeBufferSource() {
  return { ...fakeNode(), buffer: null as unknown, start: vi.fn(), stop: vi.fn() };
}

function fakeBiquadFilter() {
  return { ...fakeNode(), type: 'allpass' as BiquadFilterType, frequency: { value: 0 } };
}

function fakeCtx(currentTime = 0, sampleRate = 44100) {
  const oscillators: ReturnType<typeof fakeOscillator>[] = [];
  const gains: ReturnType<typeof fakeGainNode>[] = [];
  const sources: ReturnType<typeof fakeBufferSource>[] = [];
  const filters: ReturnType<typeof fakeBiquadFilter>[] = [];
  const buffers: { channels: number; length: number; sampleRate: number; data: Float32Array }[] = [];
  return {
    currentTime,
    sampleRate,
    createOscillator: vi.fn(() => {
      const o = fakeOscillator();
      oscillators.push(o);
      return o;
    }),
    createGain: vi.fn(() => {
      const g = fakeGainNode();
      gains.push(g);
      return g;
    }),
    createBufferSource: vi.fn(() => {
      const s = fakeBufferSource();
      sources.push(s);
      return s;
    }),
    createBiquadFilter: vi.fn(() => {
      const f = fakeBiquadFilter();
      filters.push(f);
      return f;
    }),
    createBuffer: vi.fn((channels: number, length: number, sr: number) => {
      const data = new Float32Array(length);
      const rec = { channels, length, sampleRate: sr, data };
      buffers.push(rec);
      return { getChannelData: () => data };
    }),
    oscillators,
    gains,
    sources,
    filters,
    buffers,
  };
}

type FakeCtx = ReturnType<typeof fakeCtx>;

describe('tone()', () => {
  it('creates an oscillator + gain, sets type/frequency, envelopes the gain, connects osc->gain->bus, and schedules start/stop', () => {
    const ctx = fakeCtx(5);
    const bus = fakeGainNode();
    tone(ctx as unknown as AudioContext, bus as unknown as GainNode, 440, 'square', 0.1, 0.2);

    expect(ctx.oscillators).toHaveLength(1);
    const osc = ctx.oscillators[0]!;
    expect(osc.type).toBe('square');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(440, 5);
    expect(osc.frequency.linearRampToValueAtTime).not.toHaveBeenCalled(); // no slideTo

    const gain = ctx.gains[0]!;
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 5);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(1, 0.2, 5 + 0.005);
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(2, 0, 5 + 0.1);

    // osc.connect(gain).connect(bus) — real AudioNode.connect() returns the
    // destination, so this only chains correctly if the fake mirrors that.
    expect(osc.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(bus);

    expect(osc.start).toHaveBeenCalledWith(5);
    expect(osc.stop).toHaveBeenCalledWith(5 + 0.1 + 0.02);
  });

  it('a slideTo pitch-bends the oscillator frequency over its life', () => {
    const ctx = fakeCtx(0);
    const bus = fakeGainNode();
    tone(ctx as unknown as AudioContext, bus as unknown as GainNode, 220, 'triangle', 0.06, 0.1, 90);
    const osc = ctx.oscillators[0]!;
    expect(osc.frequency.linearRampToValueAtTime).toHaveBeenCalledWith(90, 0.06);
  });
});

describe('noise()', () => {
  it('creates a filtered noise burst: buffer sized sampleRate*dur, connects source->filter->gain->bus', () => {
    const ctx = fakeCtx(2, 1000); // sampleRate=1000 for round numbers
    const bus = fakeGainNode();
    noise(ctx as unknown as AudioContext, bus as unknown as GainNode, 0.1, 0.3, 1234);

    expect(ctx.buffers).toHaveLength(1);
    const buf = ctx.buffers[0]!;
    expect(buf.channels).toBe(1);
    expect(buf.length).toBe(100); // 1000 * 0.1
    expect(buf.data).toHaveLength(100);
    // Every sample is in [-1, 1] scaled by a decaying envelope — the very first
    // sample has the full envelope (close to +-1 possible), the last is ~0.
    expect(Math.abs(buf.data[0]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(buf.data[99]!)).toBeLessThan(0.02); // envelope ≈ 1/100 at the tail

    const filter = ctx.filters[0]!;
    expect(filter.type).toBe('lowpass');
    expect(filter.frequency.value).toBe(1234);

    const source = ctx.sources[0]!;
    expect(source.buffer).not.toBeNull();
    expect(source.connect).toHaveBeenCalledWith(filter);
    expect(filter.connect).toHaveBeenCalledWith(ctx.gains[0]);
    expect(ctx.gains[0]!.connect).toHaveBeenCalledWith(bus);
    expect(ctx.gains[0]!.gain.value).toBe(0.3);

    expect(source.start).toHaveBeenCalledWith(2);
    expect(source.stop).toHaveBeenCalledWith(2 + 0.1 + 0.02);
  });

  it('cutoff defaults to 3000Hz when not given', () => {
    const ctx = fakeCtx();
    noise(ctx as unknown as AudioContext, fakeGainNode() as unknown as GainNode, 0.05, 0.1);
    expect(ctx.filters[0]!.frequency.value).toBe(3000);
  });
});

describe('playCue()', () => {
  function play(ctx: FakeCtx, cue: AudioCue) {
    playCue(cue, ctx as unknown as AudioContext, fakeGainNode() as unknown as GainNode);
  }

  it('every cue in the vocabulary plays without throwing and produces at least one sound', () => {
    for (const cue of ALL_CUES) {
      const ctx = fakeCtx();
      expect(() => play(ctx, cue)).not.toThrow();
      expect(ctx.oscillators.length + ctx.sources.length).toBeGreaterThan(0);
    }
  });

  it("'muzzle' is a single square-wave blip sliding to 120Hz", () => {
    const ctx = fakeCtx();
    play(ctx, 'muzzle');
    expect(ctx.oscillators).toHaveLength(1);
    const osc = ctx.oscillators[0]!;
    expect(osc.type).toBe('square');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(220, 0);
    expect(osc.frequency.linearRampToValueAtTime).toHaveBeenCalledWith(120, 0.06);
  });

  it("'impact' layers a noise burst AND a tone — the one two-primitive voice besides shield.break/pickup.buff/wave-clear/win", () => {
    const ctx = fakeCtx();
    play(ctx, 'impact');
    expect(ctx.sources).toHaveLength(1); // the noise burst
    expect(ctx.oscillators).toHaveLength(1); // the low tone under it
  });

  it("'deflect' is the signature parry ping — a high triangle tone sliding way up", () => {
    const ctx = fakeCtx();
    play(ctx, 'deflect');
    const osc = ctx.oscillators[0]!;
    expect(osc.type).toBe('triangle');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(700, 0);
    expect(osc.frequency.linearRampToValueAtTime).toHaveBeenCalledWith(1400, 0.14);
  });

  it("'win' is the biggest cue — 3 stacked tones (arp/chord)", () => {
    const ctx = fakeCtx();
    play(ctx, 'win');
    expect(ctx.oscillators).toHaveLength(3);
  });
});
