import type { AudioBus, AudioCue } from '../types';

// Web audio backend (design/11).
//
// A placeholder SFX bus that SYNTHESISES every cue with the WebAudio API — no asset
// files, no licensing, no download. This exists to prove the event→sound pipeline
// (design/08/11) end-to-end on web; real/authored audio replaces the synth voices
// later behind this same AudioBus interface. Music is reserved (setMusicVolume is a
// no-op until tracks are authored).
//
// Determinism: this reads engine events on the render clock and plays. It never
// touches GameState, never draws from the sim PRNG (any jitter uses Math.random,
// which is fine render-side), so it cannot desync (design/06/11).
export class WebAudio implements AudioBus {
  private ctx: AudioContext | null = null;
  private sfx: GainNode | null = null;
  private sfxVolume = 0.5;

  constructor() {
    // WebAudio starts suspended until a user gesture (autoplay policy). Resume on the
    // first pointer/key/touch (design/11 autoplay gate).
    if (typeof window !== 'undefined') {
      const onGesture = () => this.resume();
      for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
        window.addEventListener(ev, onGesture, { passive: true });
      }
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    // Guard: some environments (SSR, tests) lack AudioContext.
    const Ctor: typeof AudioContext | undefined =
      (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.sfx = this.ctx.createGain();
    this.sfx.gain.value = this.sfxVolume;
    this.sfx.connect(this.ctx.destination);
    return this.ctx;
  }

  resume(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfx) this.sfx.gain.value = this.sfxVolume;
  }

  // Music not authored yet (design/11 reserved) — accept + ignore so settings (design/10)
  // can already wire a slider to it.
  setMusicVolume(_v: number): void {}

  play(cue: AudioCue): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx || ctx.state !== 'running') return;
    VOICES[cue](this, ctx, this.sfx);
  }

  // ---- synth primitives (render-side, quick and cheap) ----

  /** A pitched blip; optional linear glide to `slideTo` over its life. */
  tone(
    ctx: AudioContext,
    bus: GainNode,
    freq: number,
    type: OscillatorType,
    dur: number,
    gain: number,
    slideTo?: number,
  ): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) osc.frequency.linearRampToValueAtTime(slideTo, t + dur);
    // Fast attack, exponential-ish decay via a linear ramp to ~0.
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A short filtered noise burst (impacts / crackle). */
  noise(ctx: AudioContext, bus: GainNode, dur: number, gain: number, cutoff = 3000): void {
    const t = ctx.currentTime;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(lp).connect(g).connect(bus);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}

// One synth voice per cue. Kept intentionally small/quiet — combat emits a lot, and
// the caller already coalesces duplicates per frame (design/11). Element cues follow
// the colour law's mood (design/13): fire = crackle, ice = high sine, shock = buzz,
// poison = low wobble.
const VOICES: Record<AudioCue, (a: WebAudio, ctx: AudioContext, bus: GainNode) => void> = {
  muzzle: (a, c, b) => a.tone(c, b, 220, 'square', 0.06, 0.12, 120),
  impact: (a, c, b) => { a.noise(c, b, 0.07, 0.18, 2600); a.tone(c, b, 160, 'triangle', 0.06, 0.1, 90); },
  deflect: (a, c, b) => a.tone(c, b, 700, 'triangle', 0.14, 0.2, 1400), // signature parry ping (design/03/05)
  clash: (a, c, b) => { a.tone(c, b, 520, 'square', 0.05, 0.1); a.tone(c, b, 780, 'square', 0.05, 0.08); },
  'shield.break': (a, c, b) => { a.tone(c, b, 420, 'sawtooth', 0.16, 0.16, 180); setTone(a, c, b, 620, 0.1, 0.1); },
  'status.burn': (a, c, b) => a.noise(c, b, 0.12, 0.09, 1800),
  'status.chill': (a, c, b) => a.tone(c, b, 1200, 'sine', 0.12, 0.09, 900),
  'status.shock': (a, c, b) => a.tone(c, b, 300, 'sawtooth', 0.08, 0.1, 600),
  'status.poison': (a, c, b) => a.tone(c, b, 180, 'sine', 0.16, 0.09, 140),
  death: (a, c, b) => a.tone(c, b, 300, 'sawtooth', 0.22, 0.14, 70),
  'pickup.heal': (a, c, b) => a.tone(c, b, 660, 'sine', 0.12, 0.13, 990),
  'pickup.weapon': (a, c, b) => a.tone(c, b, 520, 'triangle', 0.14, 0.13, 780),
  'pickup.material': (a, c, b) => a.tone(c, b, 880, 'square', 0.08, 0.1, 1320),
  'pickup.buff': (a, c, b) => { a.tone(c, b, 587, 'triangle', 0.12, 0.12); setTone(a, c, b, 880, 0.12, 0.1); },
  'wave-clear': (a, c, b) => { a.tone(c, b, 523, 'triangle', 0.12, 0.14); setTone(a, c, b, 784, 0.12, 0.09); },
  win: (a, c, b) => { a.tone(c, b, 523, 'triangle', 0.16, 0.15); setTone(a, c, b, 659, 0.16, 0.12); setTone(a, c, b, 784, 0.2, 0.12); },
};

// A tiny helper for multi-note cues — schedules a note without WebAudio timeline math
// leaking into the voice table (each tone() already self-schedules from currentTime,
// so stacking them plays a quick chord/arp; good enough for placeholders).
function setTone(a: WebAudio, ctx: AudioContext, bus: GainNode, freq: number, dur: number, gain: number): void {
  a.tone(ctx, bus, freq, 'triangle', dur, gain);
}
