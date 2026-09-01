import type { AudioBus, AudioCue, MusicTrack } from '../types';
import { SampleBank } from '../../audio/SampleBank';
import { CueMixer } from '../../audio/CueMixer';
import { MusicPlayer } from '../../audio/MusicPlayer';
import { WebMusicDeck } from './webMusicDeck';
import { readBinaryAsset, resolveAssetUrl } from '../../render/assetHost';

// Web audio backend (design/11).
//
// Owns the WebAudio context and the two bus gain nodes. What a cue actually SOUNDS like is
// `audio/CueMixer.ts`'s decision — the shipped mp3 set if it has loaded, ../audioSynth.ts's
// procedural voice if not — shared with WeChatAudio so the two backends differ only in how
// the context is obtained and how asset bytes are read.
//
// MUSIC (design/11 "Music & ambience", built 2026-08-31) runs on a separate, parallel path and
// deliberately shares nothing with the cue path but the context:
//
//   Audio element -> createMediaElementSource -> deck gain -> MUSIC bus gain -> destination
//
// Two decks (`webMusicDeck.ts`), driven by the platform-agnostic `audio/MusicPlayer.ts`, which
// crossfades between them both to change track and to close the loop. It streams rather than
// decoding because a 69 s stereo loop is ~26 MB of `AudioBuffer`.
//
// The music path is gated on `ctx.state === 'running'` exactly like `play()` is, which is what
// makes the autoplay gate a non-event: `updateMusic` is called every frame from boot, does
// nothing while the gate is closed, and starts on the first frame after the first gesture
// resumes the context. Nothing queues, nothing retries, nothing has to be remembered.
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
  private music: GainNode | null = null;
  private musicVolume = 0.5;
  private player: MusicPlayer | null = null;

  constructor() {
    // WebAudio starts suspended until a user gesture (autoplay policy). Resume on the
    // first pointer/key/touch (design/11 autoplay gate).
    if (typeof window !== 'undefined') {
      const onGesture = () => this.resume();
      for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
        window.addEventListener(ev, onGesture, { passive: true });
      }
    }
    // Focus loss (design/11 "Focus/blur & interruption", never wired until 2026-08-31). Music
    // is HELD, not stopped: a tab-away and back should return mid-bar, and the WeChat side does
    // the same thing off `wx.onAudioInterruptionBegin`.
    //
    // Only music. The cues are one-shots tens of ms long — the longest is 350 ms — so there is
    // nothing to pause that would not have finished before the handler ran, and a 69 s bed
    // playing on in a backgrounded tab is the thing a player actually notices. (Browsers throttle
    // or suspend a hidden tab's audio inconsistently, so this makes the behaviour ours.)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        this.player?.setPaused(document.hidden === true);
      });
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
    // A SECOND bus, not a shared one: design/11's "two buses + settings volume" is what lets a
    // player mute the bed and keep the combat feedback, and it is also what keeps the music's
    // continuous level out of the cue coalescing gain.
    this.music = this.ctx.createGain();
    this.music.gain.value = this.musicVolume;
    this.music.connect(this.ctx.destination);
    this.player = this.buildPlayer(this.ctx, this.music);
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

  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.music) this.music.gain.value = this.musicVolume;
  }

  updateMusic(track: MusicTrack | null, dtMs: number): void {
    const ctx = this.ensure();
    // The autoplay gate, and the whole reason this needs no retry logic: while the context is
    // suspended a media element's `play()` is refused too, so there is nothing useful to do —
    // and the frame after `resume()` lands, the same per-frame call simply starts the track.
    if (!ctx || !this.player || ctx.state !== 'running') return;
    this.player.update(track, dtMs);
  }

  /** `AudioBus.invalidateMusic` — no-op before the player exists, since nothing can be
   *  playing yet. */
  invalidateMusic(): void {
    this.player?.invalidate();
  }

  /** Null when this host cannot build media elements — jsdom-less vitest, SSR. Music is then
   *  simply absent, the same best-effort rule the art and SFX preloads follow, rather than a
   *  throw out of the audio constructor. */
  private buildPlayer(ctx: AudioContext, bus: GainNode): MusicPlayer | null {
    if (typeof Audio !== 'function') return null;
    const deck = () =>
      new WebMusicDeck({
        ctx,
        bus,
        // Through the asset host, not a bare path: it is the identity function on web today,
        // and going through it is what would let a future CDN/base-path move the music with
        // the art instead of leaving one loader behind.
        resolveUrl: resolveAssetUrl,
        createElement: () => new Audio(),
      });
    return new MusicPlayer({ decks: [deck(), deck()] });
  }

  play(cue: AudioCue, count = 1): void {
    const ctx = this.ensure();
    if (!ctx || !this.mixer || ctx.state !== 'running') return;
    this.mixer.play(cue, count);
  }
}
