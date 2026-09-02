// One web music deck (design/11 "Music & ambience"): an `Audio` element streamed into the
// WebAudio graph.
//
// The chain is `Audio` element -> `createMediaElementSource` -> this deck's own `GainNode` ->
// `WebAudio`'s music bus gain -> destination. Two reasons it is a media element rather than a
// `SampleBank` entry like every cue:
//
//  1. **RAM.** A 69 s stereo loop decodes to ~26 MB of `AudioBuffer` at 48 kHz. Three tracks
//     resident would cost more than every texture in the game.
//  2. **`createMediaElementSource` may be called only ONCE per element**, which is exactly why
//     a deck is long-lived and re-pointed rather than constructed per track. Building a fresh
//     element per track would leak a node per loop wrap, once a minute, forever.
//
// The LEVEL lives in the graph, not on `el.volume`, and that is not a preference: `HTMLMediaElement.volume`
// is a no-op on iOS Safari (the OS owns media volume there), so a deck that faded with it would
// crossfade correctly on desktop and hard-cut on a phone — a platform difference that is
// inaudible in every test and obvious to one player.
import type { MusicDeck } from '../../audio/MusicPlayer';

export interface WebMusicDeckDeps {
  ctx: AudioContext;
  /** Where this deck's gain connects — `WebAudio`'s music bus node, never the destination, so
   *  the settings volume applies to both decks at once and a crossfade cannot change it. */
  bus: AudioNode;
  /** Public-relative path -> URL. `render/assetHost.ts`'s web host is the identity function;
   *  injected rather than imported so this file has no module-level platform assumption. */
  resolveUrl(path: string): string;
  /** Builds the element. Injected because `new Audio()` needs a DOM, and the one thing that
   *  must not happen is a backend that throws at construction in a DOM-less host. */
  createElement(): HTMLAudioElement;
}

export class WebMusicDeck implements MusicDeck {
  private readonly el: HTMLAudioElement;
  private readonly gain: GainNode;
  private playing = false;

  constructor(private readonly deps: WebMusicDeckDeps) {
    this.el = deps.createElement();
    // The player closes the loop with a crossfade; native looping would wrap sample-exactly at
    // an MP3 frame boundary the region was never cut to. Setting this true would produce a
    // click once a minute AND fight the deck the player starts for the wrap.
    this.el.loop = false;
    this.el.preload = 'auto';
    this.gain = deps.ctx.createGain();
    this.gain.gain.value = 0; // silent until the player fades it in
    deps.ctx.createMediaElementSource(this.el).connect(this.gain);
    this.gain.connect(deps.bus);
  }

  play(path: string): void {
    const url = this.deps.resolveUrl(path);
    // Re-assigning the same `src` restarts the download on some browsers, and a loop wrap
    // re-points a deck at the file it already holds every other minute — so only assign on a
    // real change, and rewind instead. `el.src` reads back as an ABSOLUTE url, hence the
    // suffix test rather than equality.
    if (!this.el.src || !this.el.src.endsWith(url)) this.el.src = url;
    else this.rewind();
    this.playing = true;
    // Rejects while the autoplay gate is closed. `WebAudio` only drives the player once its
    // context is `running`, so that is not the expected path — but a rejected promise with no
    // handler is an unhandled rejection in the console, which is noise that looks like a bug.
    void this.el.play().catch(() => {
      this.playing = false;
    });
  }

  setFade(level: number): void {
    this.gain.gain.value = level;
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.el.pause();
    this.rewind();
  }

  position(): number | null {
    if (!this.playing) return null;
    const t = this.el.currentTime;
    return Number.isFinite(t) ? t : null;
  }

  setPaused(paused: boolean): void {
    // Guarded on `playing`, so releasing a hold cannot start a deck that was stopped rather
    // than paused — which is the state the idle deck sits in for all but 2 s of every minute.
    if (!this.playing) return;
    if (paused) this.el.pause();
    else void this.el.play().catch(() => {});
  }

  private rewind(): void {
    // Seeking an unloaded stream throws `InvalidStateError` on some browsers, and 0 is the only
    // position this deck ever wants, so a failure here costs nothing worth reporting.
    try {
      this.el.currentTime = 0;
    } catch {
      /* not seekable yet — it starts at 0 anyway */
    }
  }
}
