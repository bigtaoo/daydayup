// The music runtime (design/11 "Music & ambience"), platform-agnostic half.
//
// Two long-lived decks and one rule: **every change of what is heard is an equal-power
// crossfade between them.** Both things this player has to do are that same operation:
//
//   1. **Closing the loop.** `el.loop = true` is not usable here. An MP3 stream is padded to a
//      frame boundary at both ends, so sample-exact wrapping is unavailable no matter how the
//      region was cut — and every native looping API wraps sample-exactly or not at all. So the
//      player starts the OTHER deck at `length - XFADE_S` and fades across. That is why the two
//      shipped loops were gated on `xfade_band_diff` (head and tail tonally compatible over
//      2 s) instead of `audit.py`'s older `loop` class (`step_db <= -50`, the last sample
//      sitting next to the first): a much weaker requirement, and the only achievable one.
//   2. **Changing track.** Same mechanism, different file on the incoming deck.
//
// Because the loop reuses the transition machinery, there is exactly one envelope in this file
// and both behaviours are exercised by the same tests. `XFADE_S` is shared with the asset
// pipeline — see `musicCatalogue.ts` for why it must not be changed on one side alone.
//
// WHERE THE WRAP HAPPENS IS READ BACK, NOT COUNTED. `update` takes a `dtMs` and uses it for the
// envelope only; the loop trigger comes from the playing deck's own `position()`. An
// accumulated clock drifts from the stream on every stalled frame, backgrounded tab and audio
// interruption, and it drifts SILENTLY — the symptom would be a crossfade that starts before or
// after the seam it was measured for, which sounds like a badly cut loop rather than like a bug
// in a counter.
//
// DETERMINISM (design/06/11): nothing here reads or writes `GameState`, and music is explicitly
// not determinism-relevant, so free wall-clock timing is allowed.
import type { MusicTrack } from '../platform/types';
import { MUSIC_CATALOGUE, XFADE_S } from './musicCatalogue';

/**
 * One streaming deck: a single long-lived audio stream that can be pointed at a file, faded,
 * held and stopped. Narrow on purpose (this repo's narrow-dependency convention) — it is the
 * whole platform surface music needs, and the two implementations share none of it:
 *
 *  - web (`platform/web/webMusicDeck.ts`): an `Audio` element through
 *    `createMediaElementSource` into a per-deck `GainNode`, which is where `setFade` lands.
 *  - WeChat (`platform/wechat/weChatMusicDeck.ts`): an `InnerAudioContext`, which has no audio
 *    graph at all, so `setFade` has to be multiplied into `.volume` together with the bus
 *    volume.
 */
export interface MusicDeck {
  /**
   * Point this deck at `path` and start playing it FROM THE BEGINNING.
   *
   * There is no offset parameter, and the loop does not need one: the wrap starts the second
   * deck at the moment the first reaches `length - XFADE_S`, playing its own file from 0 while
   * the outgoing deck plays out its measured tail. Seeking a streamed media element before its
   * metadata has arrived is unreliable on both targets, so not needing to is a feature.
   */
  play(path: string): void;
  /** 0..1 deck-local level. The player writes this every frame during a transition. */
  setFade(level: number): void;
  /** Stop and release the stream. The deck itself stays reusable. */
  stop(): void;
  /** Seconds into the file this deck is playing, or `null` when it is not playing (or has not
   *  yet reported a position — the frames before a stream starts are indistinguishable from
   *  not playing, and both mean "no wrap decision can be made yet"). */
  position(): number | null;
  /** Hold or release playback without losing position — focus loss on web, an audio
   *  interruption on WeChat. Not the same as `stop`: a held deck resumes mid-bar. */
  setPaused(paused: boolean): void;
}

export interface MusicPlayerDeps {
  /** Exactly two. One is not enough to crossfade, and a third would only ever be idle: a
   *  transition has two ends, and a transition arriving mid-transition reuses the deck that is
   *  already fading out (see `begin`). */
  decks: readonly [MusicDeck, MusicDeck];
  /** Where a deck failure is reported. Defaults to `console.warn`; tests pass their own. */
  warn?(message: string, err: unknown): void;
}

type DeckIndex = 0 | 1;

/** A transition in flight. `t` runs 0 -> 1 over `XFADE_S`. Either end may be absent: starting
 *  from silence has no `outIdx`, and fading to silence has no `inIdx`. */
interface Transition {
  inIdx: DeckIndex | null;
  outIdx: DeckIndex | null;
  /** The outgoing track's `gain`, remembered because a crossfade BETWEEN tracks has a different
   *  catalogue gain at each end and the outgoing entry may already have been replaced. */
  outGain: number;
  inGain: number;
  t: number;
}

/** Equal-power pair: `cos`/`sin` of a quarter turn, so the two levels sum to unity in POWER
 *  rather than in amplitude. A linear pair dips ~3 dB in the middle of every fade, which on a
 *  loop wrap is heard once per minute forever. */
function equalPower(t: number): { out: number; in: number } {
  const a = Math.max(0, Math.min(1, t)) * (Math.PI / 2);
  return { out: Math.cos(a), in: Math.sin(a) };
}

export class MusicPlayer {
  /** The deck carrying `track`, or null when nothing is playing. */
  private liveIdx: DeckIndex | null = null;
  private track: MusicTrack | null = null;
  private transition: Transition | null = null;
  private paused = false;

  constructor(private readonly deps: MusicPlayerDeps) {}

  /** What the player believes is playing. Test/diagnostic surface — the game asks for a track,
   *  it never asks what is playing. */
  get current(): MusicTrack | null {
    return this.track;
  }

  /** Whether a crossfade is in flight. Same status-only role as `current`. */
  get isCrossfading(): boolean {
    return this.transition !== null;
  }

  /**
   * One render frame. `desired` is what SHOULD be sounding (see `AudioBus.updateMusic`);
   * passing the track that is already playing is a no-op, which is the property that lets the
   * caller be a per-frame derivation rather than an event hook.
   */
  update(desired: MusicTrack | null, dtMs: number): void {
    // A held player does nothing at all — not the envelope, and especially not the wrap check:
    // a paused deck's position stands still, so a wrap decided while held would fire the
    // instant it is released, on stale evidence.
    if (this.paused) return;
    if (this.transition) this.advance(dtMs / 1000);
    if (desired !== this.track) this.change(desired);
    else if (!this.transition) this.checkWrap();
  }

  /** Hold/release both decks (web `visibilitychange`, WeChat `onAudioInterruption*`). */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    for (const deck of this.deps.decks) {
      try {
        deck.setPaused(paused);
      } catch (err) {
        this.warn(`music: deck failed to ${paused ? 'pause' : 'resume'}`, err);
      }
    }
  }

  /** Stop both decks immediately, with no fade. Not a lifecycle the game uses today; here so a
   *  torn-down backend does not leave a stream running. */
  stop(): void {
    this.transition = null;
    this.liveIdx = null;
    this.track = null;
    for (const deck of this.deps.decks) {
      try {
        deck.stop();
      } catch (err) {
        this.warn('music: deck failed to stop', err);
      }
    }
  }

  /**
   * Forget what is playing (`AudioBus.invalidateMusic`) — the same reset as `stop`, under the
   * name that says why it is called.
   *
   * Deliberately NOT a fade: nothing is audible to fade. The case this exists for is a deck
   * that was handed a path inside a subpackage that had not downloaded yet, reported an error
   * and produced silence, while this player went on believing the track was live. Clearing
   * `track` is what makes the next `update` treat the desired track as a change again.
   */
  invalidate(): void {
    this.stop();
  }

  // ---- transitions ------------------------------------------------------------------------

  private change(next: MusicTrack | null): void {
    const outIdx = this.liveIdx;
    const outGain = this.track ? MUSIC_CATALOGUE[this.track].gain : 0;
    this.track = next;
    if (next === null) {
      this.liveIdx = null;
      this.begin({ inIdx: null, outIdx, inGain: 0, outGain, t: 0 });
      return;
    }
    const def = MUSIC_CATALOGUE[next];
    const inIdx = this.freeDeck(outIdx);
    this.liveIdx = inIdx;
    this.begin({ inIdx, outIdx, inGain: def.gain, outGain, t: 0 }, def.path);
  }

  /** The loop wrap: the same transition, with the same file on the incoming deck. */
  private checkWrap(): void {
    if (this.track === null || this.liveIdx === null) return;
    const def = MUSIC_CATALOGUE[this.track];
    const pos = this.deps.decks[this.liveIdx].position();
    if (pos === null) return;
    if (pos < def.lengthS - XFADE_S) return;
    const outIdx = this.liveIdx;
    const inIdx = this.freeDeck(outIdx);
    this.liveIdx = inIdx;
    this.begin({ inIdx, outIdx, inGain: def.gain, outGain: def.gain, t: 0 }, def.path);
  }

  /**
   * Which deck the incoming end of a transition uses: the one that is not carrying the
   * outgoing stream.
   *
   * With two decks, a transition that arrives while one is still in flight has to reuse the
   * deck already fading out — so that deck is hard-stopped first (`begin`). This is a real case
   * rather than a theoretical one: crossing the boss room's threshold twice inside 2 s does it.
   * The alternative, refusing the new track until the fade finishes, would make the music lag
   * the situation by up to 2 s, and a bed that arrives late is worse than a fade that is cut
   * short — the fade is already most of the way to silent by the time this happens.
   */
  private freeDeck(outIdx: DeckIndex | null): DeckIndex {
    if (outIdx !== null) return outIdx === 0 ? 1 : 0;
    // Nothing is playing, so the only stream that can still be busy is one a fade-to-silence
    // is draining. Prefer the other deck; if that fade is on the deck we end up taking anyway,
    // `begin` hard-stops it. (Reachable only through `updateMusic(null, …)`, which the shipped
    // director never asks for — it always names at least `menu` — so this is a correctness
    // guarantee for the API rather than a path the game walks.)
    const busy = this.transition?.outIdx ?? null;
    if (busy !== null) return busy === 0 ? 1 : 0;
    return 0;
  }

  private begin(next: Transition, path?: string): void {
    // Retire whatever the previous transition was still holding, so no deck is orphaned at a
    // non-zero level with nothing driving it.
    const stale = this.transition;
    if (stale) {
      for (const idx of [stale.inIdx, stale.outIdx]) {
        if (idx !== null && idx !== next.inIdx && idx !== next.outIdx) this.silence(idx);
      }
      // The deck the new transition wants to fade IN is the one the old one was fading out.
      if (stale.outIdx !== null && stale.outIdx === next.inIdx) this.silence(stale.outIdx);
    }
    this.transition = next;
    if (next.inIdx !== null && path !== undefined) {
      try {
        this.deps.decks[next.inIdx].play(path);
      } catch (err) {
        this.warn(`music: deck failed to start ${path}`, err);
      }
    }
    this.applyLevels(next);
  }

  private advance(dtS: number): void {
    const tr = this.transition!;
    tr.t += dtS / XFADE_S;
    if (tr.t < 1) {
      this.applyLevels(tr);
      return;
    }
    // Settled. The incoming deck goes to its full catalogue gain and the outgoing one is
    // stopped rather than left at zero: a media element held at gain 0 keeps decoding, which on
    // a phone is battery spent on something inaudible.
    this.transition = null;
    if (tr.inIdx !== null) this.setFade(tr.inIdx, tr.inGain);
    if (tr.outIdx !== null && tr.outIdx !== tr.inIdx) this.silence(tr.outIdx);
  }

  private applyLevels(tr: Transition): void {
    const g = equalPower(tr.t);
    if (tr.inIdx !== null) this.setFade(tr.inIdx, g.in * tr.inGain);
    if (tr.outIdx !== null && tr.outIdx !== tr.inIdx) this.setFade(tr.outIdx, g.out * tr.outGain);
  }

  private silence(idx: DeckIndex): void {
    this.setFade(idx, 0);
    try {
      this.deps.decks[idx].stop();
    } catch (err) {
      this.warn('music: deck failed to stop', err);
    }
  }

  private setFade(idx: DeckIndex, level: number): void {
    try {
      this.deps.decks[idx].setFade(Math.max(0, Math.min(1, level)));
    } catch (err) {
      this.warn('music: deck failed to set its level', err);
    }
  }

  private warn(message: string, err: unknown): void {
    if (this.deps.warn) this.deps.warn(message, err);
    else console.warn(message, err);
  }
}
