import type { AudioBus, AudioCue } from '../types';
import { SampleBank } from '../../audio/SampleBank';
import { CueMixer } from '../../audio/CueMixer';
import { readBinaryAsset } from '../../render/assetHost';

// Web audio backend (design/11).
//
// Owns the WebAudio context and the SFX bus gain node. What a cue actually SOUNDS like is
// `audio/CueMixer.ts`'s decision — the shipped mp3 set if it has loaded, ../audioSynth.ts's
// procedural voice if not — shared with WeChatAudio so the two backends differ only in how
// the context is obtained and how asset bytes are read. Music is reserved (setMusicVolume is
// a no-op until tracks are authored).
//
// Determinism: this reads engine events on the render clock and plays. It never
// touches GameState, never draws from the sim PRNG (any jitter uses Math.random,
// which is fine render-side), so it cannot desync (design/06/11).
export class WebAudio implements AudioBus {
  private ctx: AudioContext | null = null;
  private sfx: GainNode | null = null;
  private sfxVolume = 0.5;
  private bank: SampleBank | null = null;
  private mixer: CueMixer | null = null;

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
    this.bank = new SampleBank({ ctx: this.ctx, readBinary: readBinaryAsset });
    this.mixer = new CueMixer({ ctx: this.ctx, bus: this.sfx, bank: this.bank });
    return this.ctx;
  }

  // Decoding does NOT need the autoplay gate cleared — a suspended context decodes fine — so
  // this runs at boot and is usually finished long before the first gesture (design/11
  // "preload the core SFX set at boot").
  async preload(): Promise<void> {
    if (!this.ensure() || !this.bank) return;
    await this.bank.load();
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

  play(cue: AudioCue, count = 1): void {
    const ctx = this.ensure();
    if (!ctx || !this.mixer || ctx.state !== 'running') return;
    this.mixer.play(cue, count);
  }
}
