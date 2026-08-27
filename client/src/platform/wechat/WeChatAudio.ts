import type { AudioBus, AudioCue } from '../types';
import { SampleBank } from '../../audio/SampleBank';
import { CueMixer } from '../../audio/CueMixer';
import { readBinaryAsset } from '../../render/assetHost';

// WeChat audio backend (design/11).
//
// Drives the SAME cue pipeline as the web backend (../../audio/CueMixer.ts — the shipped mp3
// set if it has loaded, ../audioSynth.ts's procedural voice if not) through
// `wx.createWebAudioContext()`, which WeChat's own docs describe as implementing the standard
// Web Audio API surface. Nothing about a cue is decided per platform; only the context, and
// how sample bytes are read (`FileSystemManager.readFileSync` through the asset host, since a
// mini-game has no `fetch`).
//
// What's still NOT verified here (design/11's own open items, all needing a device this repo
// cannot drive):
//   1. `wx.createWebAudioContext` isn't guaranteed on every base library — UNVERIFIED
//      without a real device/DevTools session on the LOWEST target base library
//      (design/04's checklist item 2, still unchecked). Absence falls back to a true no-op
//      below, same as before.
//   2. Whether that context's `decodeAudioData` is the promise or the callback form varies
//      by base library, so `audio/decodeAudio.ts` accepts either. Which one a real device
//      takes is unverified; a decode failure costs the samples, not the sound — the
//      procedural voices keep playing.
//   3. Music/ambience still do not exist as assets, so that half of design/11 stays a
//      documented gap rather than being silently faked here.
export class WeChatAudio implements AudioBus {
  private ctx: AudioContext | null = null;
  private sfx: GainNode | null = null;
  private sfxVolume = 0.5;
  private supported = true;
  private bank: SampleBank | null = null;
  private mixer: CueMixer | null = null;

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (!this.supported || typeof wx.createWebAudioContext !== 'function') return null;
    try {
      this.ctx = wx.createWebAudioContext();
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = this.sfxVolume;
      this.sfx.connect(this.ctx.destination);
      this.bank = new SampleBank({ ctx: this.ctx, readBinary: readBinaryAsset });
      this.mixer = new CueMixer({ ctx: this.ctx, bus: this.sfx, bank: this.bank });
      return this.ctx;
    } catch {
      // Base library claims the API but construction failed — degrade to the no-op
      // path for the rest of this session rather than retrying every play() call.
      this.supported = false;
      this.ctx = null;
      this.sfx = null;
      this.bank = null;
      this.mixer = null;
      return null;
    }
  }

  // Reads come off the code package (synchronously, inside the asset host) and decode on the
  // still-suspended context, so this needs neither the network nor a user gesture. Preloading
  // matters MORE here than on web: design/11 expects higher input-to-sound latency on this
  // runtime, and a first-play decode stall is exactly what it warns about.
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

  // Music not authored yet (design/11 reserved) — accept + ignore so settings
  // (design/10) can already wire a slider to it, same as WebAudio.
  setMusicVolume(_v: number): void {}

  play(cue: AudioCue, count = 1): void {
    const ctx = this.ensure();
    if (!ctx || !this.mixer || ctx.state !== 'running') return;
    this.mixer.play(cue, count);
  }
}
