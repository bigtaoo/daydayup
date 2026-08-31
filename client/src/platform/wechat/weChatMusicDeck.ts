// One WeChat music deck (design/11 "Music & ambience"): a long-lived `InnerAudioContext`.
//
// design/04 already called this shape: "keep a pool of reusable contexts for short SFX and a
// couple of long-lived contexts for music/ambience". The cues went the other way in the end
// (they run through `createWebAudioContext`'s standard graph, `WeChatAudio`), so this file is
// the only `InnerAudioContext` in the client — and it is deliberately independent of that
// context, because a base library that lacks `createWebAudioContext` should lose the SFX
// samples, not the music.
//
// THE ONE STRUCTURAL DIFFERENCE FROM WEB, and the reason `setMusicVolume` cannot be shared:
// there is no audio graph here. No `GainNode`, no `createMediaElementSource`, nothing to put
// between a stream and the output. So the two things that scale a deck's level — the settings
// music volume (one value for both decks) and this deck's crossfade level (per deck, rewritten
// every frame of a transition) — have to be MULTIPLIED and written into the single `.volume`
// property. `setBusVolume` and `setFade` are therefore both stored, and either one changing
// re-derives the product.
import type { MusicDeck } from '../../audio/MusicPlayer';

export interface WeChatMusicDeckDeps {
  /** Builds the stream. Injected rather than calling `wx.createInnerAudioContext()` here so a
   *  base library missing the API is handled once, by the caller, at the point where the
   *  degrade decision belongs (`WeChatAudio`). */
  create(): WxInnerAudioContext;
  /** Public-relative path -> the code-package path this runtime can read. Always
   *  `render/assetManifest.ts`'s `packedPathFor`: `/audio/music/menu.mp3` lives inside the
   *  `music` SUBPACKAGE, so its real path is `packs/music/audio/music/menu.mp3` and it does not
   *  resolve at all until `wx.loadSubpackage` has run for that pack (`render/packLoader.ts`
   *  does it inside `preloadCoreArt`, which both entries await before building `Game`). */
  resolveSrc(path: string): string;
  warn?(message: string, err: unknown): void;
}

export class WeChatMusicDeck implements MusicDeck {
  private readonly inner: WxInnerAudioContext;
  private playing = false;
  private fade = 0;
  private bus = 0.5;
  private src = '';

  constructor(private readonly deps: WeChatMusicDeckDeps) {
    this.inner = deps.create();
    this.inner.loop = false; // the player crossfades the wrap — see MusicPlayer's header
    this.inner.obeyMuteSwitch = true;
    this.inner.volume = 0;
    // One-shot per deck: a src that will not play is worth exactly one line in the log, and on
    // this target the most likely cause is a subpackage that has not landed, which is a real
    // diagnosis rather than noise.
    this.inner.onError((res) => {
      this.playing = false;
      this.warn(`music: InnerAudioContext failed on ${this.src}`, res?.errMsg ?? res);
    });
  }

  play(path: string): void {
    const next = this.deps.resolveSrc(path);
    // Re-assigning `src` restarts the stream from 0, which IS what a loop wrap wants — so
    // unlike the web deck there is no rewind branch, only the assignment.
    if (next !== this.src) {
      this.src = next;
      this.inner.src = next;
    } else {
      this.inner.stop(); // stop() rewinds; play() then starts from the beginning
    }
    this.playing = true;
    this.inner.play();
  }

  setFade(level: number): void {
    this.fade = level;
    this.applyVolume();
  }

  /** The settings music volume (design/10), pushed in by `WeChatAudio.setMusicVolume`. Not part
   *  of `MusicDeck`: on web the same value is one `GainNode` upstream of both decks, so putting
   *  it on the shared interface would invent a per-deck knob that platform does not have. */
  setBusVolume(v: number): void {
    this.bus = Math.max(0, Math.min(1, v));
    this.applyVolume();
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.inner.stop();
  }

  position(): number | null {
    if (!this.playing) return null;
    const t = this.inner.currentTime;
    return Number.isFinite(t) ? t : null;
  }

  setPaused(paused: boolean): void {
    if (!this.playing) return;
    if (paused) this.inner.pause();
    else this.inner.play();
  }

  private applyVolume(): void {
    this.inner.volume = Math.max(0, Math.min(1, this.bus * this.fade));
  }

  private warn(message: string, err: unknown): void {
    if (this.deps.warn) this.deps.warn(message, err);
    else console.warn(message, err);
  }
}
