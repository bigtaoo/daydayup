import type { AudioBus, AudioCue } from '../types';
import { playCue } from '../audioSynth';

// WeChat audio backend (design/11).
//
// Drives the SAME procedural synth voice table as the web backend (../audioSynth.ts)
// through `wx.createWebAudioContext()` — WeChat's own docs describe it as implementing
// the standard Web Audio API surface, so no separate voice code is needed per platform.
// This is still "placeholder audio" in design/11's sense (no asset files, no
// licensing) — it just extends the SAME placeholder to WeChat instead of leaving it a
// pure no-op, closing the "the event→sound pipeline is unproven on WeChat" gap.
//
// What's still NOT done here (both explicitly flagged by design/11, both needing
// things this repo cannot produce/verify alone):
//   1. `wx.createWebAudioContext` isn't guaranteed on every base library (design/11's
//      own open question) — UNVERIFIED without a real device/DevTools session on the
//      LOWEST target base library (design/04's checklist item 2, still unchecked).
//      Absence falls back to a true no-op below, same as before this change.
//   2. Real authored music/ambience (`InnerAudioContext`-pooled file playback) needs
//      actual audio ASSETS (mp3s) + a licence check (design/11's "Sourcing" section) —
//      neither exists in this repo, so that half of design/11 stays a documented gap,
//      not silently faked here.
export class WeChatAudio implements AudioBus {
  private ctx: AudioContext | null = null;
  private sfx: GainNode | null = null;
  private sfxVolume = 0.5;
  private supported = true;

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (!this.supported || typeof wx.createWebAudioContext !== 'function') return null;
    try {
      this.ctx = wx.createWebAudioContext();
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = this.sfxVolume;
      this.sfx.connect(this.ctx.destination);
      return this.ctx;
    } catch {
      // Base library claims the API but construction failed — degrade to the no-op
      // path for the rest of this session rather than retrying every play() call.
      this.supported = false;
      this.ctx = null;
      this.sfx = null;
      return null;
    }
  }

  resume(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfx) this.sfx.gain.value = this.sfxVolume;
  }

  // Music not authored yet (design/11 reserved) — accept + ignore so settings
  // (design/10) can already wire a slider to it, same as WebAudio.
  setMusicVolume(_v: number): void {}

  play(cue: AudioCue): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx || ctx.state !== 'running') return;
    playCue(cue, ctx, this.sfx);
  }
}
