/**
 * `CueMixer` — the sample-or-synth decision, the catalogue's mix, and the voice cap, against
 * a hand-rolled node graph (no real AudioContext; `connect()` returns its destination exactly
 * as `AudioNode.connect()` does, so `a.connect(b).connect(c)` chains like production).
 * `../platform/audioSynth`'s `playCue` is mocked — the voices themselves are
 * `audioSynth.test.ts`'s subject; what matters here is WHEN it is reached and with what gain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CueMixer, coalesceBoost } from './CueMixer';
import { CUE_CATALOGUE } from './cueCatalogue';
import type { AudioCue } from '../platform/types';
import type { SampleBank } from './SampleBank';

vi.mock('../platform/audioSynth', () => ({ playCue: vi.fn() }));
import { playCue } from '../platform/audioSynth';

function fakeGain() {
  return {
    gain: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn((dest: unknown) => dest),
  };
}
type FakeGain = ReturnType<typeof fakeGain>;

function fakeSource(withRate = true) {
  return {
    buffer: null as AudioBuffer | null,
    playbackRate: withRate ? { value: 1 } : undefined,
    connect: vi.fn((dest: unknown) => dest),
    start: vi.fn(),
    stop: vi.fn(),
  };
}
type FakeSource = ReturnType<typeof fakeSource>;

function fakeCtx(withRate = true) {
  const gains: FakeGain[] = [];
  const sources: FakeSource[] = [];
  return {
    currentTime: 0,
    gains,
    sources,
    createGain: vi.fn(() => {
      const g = fakeGain();
      gains.push(g);
      return g;
    }),
    createBufferSource: vi.fn(() => {
      const s = fakeSource(withRate);
      sources.push(s);
      return s;
    }),
  };
}
type FakeCtx = ReturnType<typeof fakeCtx>;

/** A buffer tagged with its variant index, so variant CHOICE is assertable. */
const buf = (i: number, duration = 0.1) => ({ duration, index: i }) as unknown as AudioBuffer;

function bankWith(loaded: Partial<Record<AudioCue, AudioBuffer[]>>): SampleBank {
  return { variantsOf: (cue: AudioCue) => loaded[cue] } as unknown as SampleBank;
}

interface Rig {
  ctx: FakeCtx;
  bus: FakeGain;
  mixer: CueMixer;
}
function rig(
  loaded: Partial<Record<AudioCue, AudioBuffer[]>> = {},
  opts: { cap?: number; random?: () => number; withRate?: boolean } = {},
): Rig {
  const ctx = fakeCtx(opts.withRate ?? true);
  const bus = fakeGain();
  const mixer = new CueMixer({
    ctx: ctx as unknown as AudioContext,
    bus: bus as unknown as GainNode,
    bank: bankWith(loaded),
    cap: opts.cap,
    random: opts.random ?? (() => 0.5),
  });
  return { ctx, bus, mixer };
}

beforeEach(() => vi.clearAllMocks());

describe('CueMixer — no sample loaded (cold boot, or a synth-only cue)', () => {
  it('plays the synth voice straight into the bus when the cue gain is exactly 1', () => {
    const { bus, mixer, ctx } = rig();
    mixer.play('impact'); // catalogue gain 1.0
    expect(playCue).toHaveBeenCalledWith('impact', ctx, bus);
    expect(ctx.createGain).not.toHaveBeenCalled(); // no pointless trim node
  });

  it('trims the synth voice through a gain node when the catalogue asks for one', () => {
    // The asymmetry that would otherwise bite: the shipped files were peak-matched to these
    // synth voices, so a cue whose sample is turned down must have its synth turned down too
    // or the fallback is louder than the thing it stands in for.
    const { bus, mixer, ctx } = rig();
    mixer.play('muzzle'); // catalogue gain 0.8
    const trim = ctx.gains[0]!;
    expect(trim.gain.value).toBeCloseTo(0.8);
    expect(trim.connect).toHaveBeenCalledWith(bus);
    expect(playCue).toHaveBeenCalledWith('muzzle', ctx, trim);
  });

  it('applies the coalesce boost to the synth path too', () => {
    const { mixer, ctx } = rig();
    mixer.play('impact', 10);
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(1.5);
  });
});

describe('CueMixer — sample playback', () => {
  it('plays a decoded variant instead of the synth voice', () => {
    const { ctx, bus, mixer } = rig({ impact: [buf(0), buf(1)] });
    mixer.play('impact');
    expect(playCue).not.toHaveBeenCalled();
    const src = ctx.sources[0]!;
    const gain = ctx.gains[0]!;
    expect(src.buffer).toBeDefined();
    expect(src.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(bus);
    expect(src.start).toHaveBeenCalledWith(0);
  });

  it('sets the voice gain from the catalogue', () => {
    const { ctx, mixer } = rig({ deflect: [buf(0)] });
    mixer.play('deflect'); // 1.15 — the one cue deliberately above its placeholder
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(CUE_CATALOGUE.deflect.gain);
  });

  it('raises the gain for a coalesced frame instead of playing the cue twice', () => {
    const { ctx, mixer } = rig({ impact: [buf(0)] });
    mixer.play('impact', 10);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.gains[0]!.gain.value).toBeCloseTo(1.5);
  });

  it('jitters the pitch within +/-3%, and survives a host without playbackRate', () => {
    const hi = rig({ impact: [buf(0)] }, { random: () => 1 });
    hi.mixer.play('impact');
    expect(hi.ctx.sources[0]!.playbackRate!.value).toBeCloseTo(1.03);
    const lo = rig({ impact: [buf(0)] }, { random: () => 0 });
    lo.mixer.play('impact');
    expect(lo.ctx.sources[0]!.playbackRate!.value).toBeCloseTo(0.97);
    // WeChat's node surface is documented, not verified — a missing param costs the jitter.
    const bare = rig({ impact: [buf(0)] }, { withRate: false });
    expect(() => bare.mixer.play('impact')).not.toThrow();
    expect(bare.ctx.sources[0]!.start).toHaveBeenCalled();
  });
});

describe('CueMixer — variant choice', () => {
  const indexOf = (ctx: FakeCtx, n: number) =>
    (ctx.sources[n]!.buffer as unknown as { index: number }).index;

  it('never plays the same variant twice in a row', () => {
    // Even with an RNG that always returns the same number — which is exactly the case a
    // naive `floor(random * n)` gets wrong, and the case a real RNG hits regularly on a
    // 2-variant cue.
    const { ctx, mixer } = rig({ 'pickup.heal': [buf(0), buf(1)] }, { random: () => 0 });
    for (let i = 0; i < 6; i++) mixer.play('pickup.heal');
    const played = ctx.sources.map((_, i) => indexOf(ctx, i));
    expect(played).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('can still reach every variant of a 5-way cue', () => {
    const seen = new Set<number>();
    // A real pseudo-random stream, and specifically a Lehmer one. Two earlier versions of
    // this test failed for reasons that were the TEST's and not the code's: a fixed step
    // (r += 0.17) is periodic and only ever walks a few of the five slots, and the textbook
    // (1103515245 * seed) multiplier overflows 2^53 in JS, losing the low bits that carry
    // the spread. Lehmer keeps every product exact.
    let seed = 1;
    const lcg = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const { ctx, mixer } = rig(
      { impact: [buf(0), buf(1), buf(2), buf(3), buf(4)] },
      { random: lcg },
    );
    for (let i = 0; i < 40; i++) mixer.play('impact');
    for (let i = 0; i < ctx.sources.length; i++) seen.add(indexOf(ctx, i));
    expect(seen.size).toBe(5);
  });

  it('a single-variant cue just repeats it', () => {
    const { ctx, mixer } = rig({ win: [buf(0)] });
    mixer.play('win');
    mixer.play('win');
    expect(ctx.sources).toHaveLength(2);
    expect(indexOf(ctx, 1)).toBe(0);
  });
});

describe('CueMixer — the voice cap', () => {
  it('drops a cue that does not outrank what is already sounding', () => {
    const { ctx, mixer } = rig({ impact: [buf(0)], muzzle: [buf(0)] }, { cap: 1 });
    mixer.play('impact'); // priority 60
    mixer.play('muzzle'); // priority 20 — dropped
    expect(ctx.sources).toHaveLength(1);
  });

  it('steals a weaker voice, fading it out rather than cutting it dead', () => {
    const { ctx, mixer } = rig({ muzzle: [buf(0)], deflect: [buf(0)] }, { cap: 1 });
    mixer.play('muzzle');
    const stolen = ctx.sources[0]!;
    ctx.currentTime = 0.02;
    mixer.play('deflect'); // priority 95 outranks 20
    expect(ctx.sources).toHaveLength(2);
    expect(stolen.stop).toHaveBeenCalledWith(0.032); // 0.02 + the 12 ms fade
    expect(ctx.gains[0]!.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 0.032);
  });

  it('frees the slot once a sample has played out', () => {
    const { ctx, mixer } = rig({ impact: [buf(0, 0.14)] }, { cap: 1 });
    mixer.play('impact');
    ctx.currentTime = 0.05;
    mixer.play('impact'); // still sounding, equal priority → dropped
    expect(ctx.sources).toHaveLength(1);
    ctx.currentTime = 0.2;
    mixer.play('impact');
    expect(ctx.sources).toHaveLength(2);
  });

  it('does not cap the synth fallback', () => {
    // Documented asymmetry: the budget needs a stop handle, and the synth voices have none.
    // It only matters before the preload lands (and for `status.burn`, which has no sample by
    // decision), so the cap is on the path that can actually flood the mix.
    const { mixer } = rig({}, { cap: 0 });
    mixer.play('status.burn');
    mixer.play('status.burn');
    expect(playCue).toHaveBeenCalledTimes(2);
  });

  it('a cap of 0 silences every SAMPLE voice (the budget is really consulted)', () => {
    const { ctx, mixer } = rig({ win: [buf(0)] }, { cap: 0 });
    mixer.play('win');
    expect(ctx.sources).toHaveLength(0);
    expect(ctx.createGain).not.toHaveBeenCalled(); // refused before any node was built
  });
});

describe('coalesceBoost', () => {
  it('is 1 for a single event and log-shaped above it, capped', () => {
    expect(coalesceBoost(0)).toBe(1);
    expect(coalesceBoost(1)).toBe(1);
    expect(coalesceBoost(2)).toBeCloseTo(1.15);
    expect(coalesceBoost(4)).toBeCloseTo(1.3);
    expect(coalesceBoost(10)).toBeCloseTo(1.498);
    expect(coalesceBoost(1000)).toBe(1.5); // the cap, not 1 + 0.15*log2(1000)
  });
});
