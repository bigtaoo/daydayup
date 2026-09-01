import type { AudioBus, AudioCue, MusicTrack } from '../types';
import { SampleBank } from '../../audio/SampleBank';
import { CueMixer } from '../../audio/CueMixer';
import { MusicPlayer } from '../../audio/MusicPlayer';
import { WeChatMusicDeck } from './weChatMusicDeck';
import { readBinaryAsset } from '../../render/assetHost';
import { packedPathFor } from '../../render/assetManifest';

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
//   3. That `InnerAudioContext` accepts a path inside a loaded SUBPACKAGE. The music files live
//      in the `music` pack (`render/assetPacks.json`), so their real src is
//      `packs/music/audio/music/menu.mp3`. Package files are package files and
//      `wx.loadSubpackage` has already resolved by the time `Game` exists, so this should
//      simply work — but "should" is the word every other item on this list started with.
//      A failure here is one `onError` line per deck and a silent bed, not a crash.
//
// MUSIC (design/11 "Music & ambience", built 2026-08-31) does NOT go through the context above.
// It runs on two long-lived `InnerAudioContext` streams (`weChatMusicDeck.ts`) driven by the
// same platform-agnostic `audio/MusicPlayer.ts` the web backend uses. Three consequences worth
// stating, because each is a place the two platforms genuinely diverge:
//
//   - **A base library with no `createWebAudioContext` loses the SFX samples and keeps the
//     music.** The two paths share no object, so item 1 above cannot take the bed down with it.
//   - **There is no audio graph, so there is no music bus node.** `setMusicVolume` multiplies
//     into each deck's own `.volume` alongside its crossfade level, which is why the two
//     backends' implementations of that one method can never be shared.
//   - **There is no autoplay gate on this path.** `WeChatAudio.play` waits for
//     `ctx.state === 'running'`; `updateMusic` does not have to wait for anything, so on this
//     target the menu bed starts on the first frame rather than on the first tap.
export class WeChatAudio implements AudioBus {
  private ctx: AudioContext | null = null;
  private sfx: GainNode | null = null;
  private sfxVolume = 0.5;
  private supported = true;
  private bank: SampleBank | null = null;
  private mixer: CueMixer | null = null;
  private musicVolume = 0.5;
  private player: MusicPlayer | null = null;
  private decks: readonly WeChatMusicDeck[] = [];
  /** Mirrors `supported` above, for the music path — see `ensureMusic`'s catch. */
  private musicSupported = true;

  constructor() {
    // Focus/interruption (design/11 "Focus/blur & interruption", never wired until 2026-08-31).
    // An incoming call is the case: this runtime has no DOM, so `visibilitychange` does not
    // exist and these two callbacks are the ONLY signal. Registered in the constructor rather
    // than lazily beside the decks, because an interruption can begin before any music has
    // played and the resume half has to be armed for it.
    //
    // Music is held, not stopped, exactly as on web. The cues need nothing: the longest is
    // 350 ms and would have finished before the handler ran.
    if (typeof wx !== 'undefined') {
      wx.onAudioInterruptionBegin?.(() => this.player?.setPaused(true));
      wx.onAudioInterruptionEnd?.(() => this.player?.setPaused(false));
    }
  }

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

  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    // No bus node to write once — see this class's header. Every deck re-derives
    // `.volume = bus * fade` from the pair.
    for (const deck of this.decks) deck.setBusVolume(this.musicVolume);
  }

  updateMusic(track: MusicTrack | null, dtMs: number): void {
    const player = this.ensureMusic();
    player?.update(track, dtMs);
  }

  /** `AudioBus.invalidateMusic` — reads `this.player` directly rather than `ensureMusic()`:
   *  with no player built yet nothing is playing, and this call must not be the thing that
   *  creates two `InnerAudioContext` streams. */
  invalidateMusic(): void {
    this.player?.invalidate();
  }

  /** Builds the two streaming decks on first use. Separate from `ensure()` on purpose: music
   *  must not be gated on `createWebAudioContext`, which is the one audio API on this platform
   *  design/11 records as unverified on the lowest base library. */
  private ensureMusic(): MusicPlayer | null {
    if (this.player) return this.player;
    if (!this.musicSupported) return null;
    if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') return null;
    try {
      const deck = () =>
        new WeChatMusicDeck({
          create: () => wx.createInnerAudioContext!(),
          // The path rewrite that makes music reachable here at all: `/audio/music/menu.mp3`
          // is in the `music` subpackage, so this returns `packs/music/audio/music/menu.mp3`.
          resolveSrc: packedPathFor,
        });
      const decks = [deck(), deck()] as const;
      for (const d of decks) d.setBusVolume(this.musicVolume);
      this.decks = decks;
      this.player = new MusicPlayer({ decks });
      return this.player;
    } catch (err) {
      // Same degrade rule as `ensure()`: give up on music for the session rather than retrying
      // construction on every frame. A silent bed is survivable; a per-frame throw is not.
      console.warn('music: InnerAudioContext unavailable, the game runs without a bed', err);
      // The latch, without which the comment above would be a lie: `player` stays null on
      // failure, so with nothing else to stop it this would re-attempt construction — and log —
      // on every one of 60 frames a second.
      this.musicSupported = false;
      this.decks = [];
      this.player = null;
      return null;
    }
  }

  play(cue: AudioCue, count = 1): void {
    const ctx = this.ensure();
    if (!ctx || !this.mixer || ctx.state !== 'running') return;
    this.mixer.play(cue, count);
  }
}
