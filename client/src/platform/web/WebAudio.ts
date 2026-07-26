import type { AudioBus, AudioCue } from '../types';
import { playCue } from '../audioSynth';

// Web audio backend (design/11).
//
// A placeholder SFX bus that SYNTHESISES every cue with the WebAudio API — no asset
// files, no licensing, no download. This exists to prove the event→sound pipeline
// (design/08/11) end-to-end on web; real/authored audio replaces the synth voices
// later behind this same AudioBus interface. Music is reserved (setMusicVolume is a
// no-op until tracks are authored). The synth voice table itself lives in
// ../audioSynth.ts — WeChatAudio drives the SAME cues through
// `wx.createWebAudioContext()`, which implements the identical Web Audio API surface.
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
    playCue(cue, ctx, this.sfx);
  }
}
