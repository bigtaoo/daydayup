/**
 * `WeChatMusicDeck`'s own contract, at the level `MusicPlayer` relies on it — the counterpart
 * of `platform/web/webMusicDeck.test.ts`, which this file did not have (written 2026-09-01).
 *
 * `audio/wechatMusicLoad.test.ts` already drives this class, but from the outside: real
 * catalogue, real player, a `wx` fake, and assertions about paths, volume products,
 * interruption and the degrade paths. What that leaves untested is exactly what the web deck's
 * mutation battery found missing on ITS side (daydayup-audio-pipeline-conventions memory):
 * `position()`'s null-when-idle contract, which no current caller can observe because the player
 * only reads the LIVE deck, and the small state machine around `playing` that decides whether
 * `stop()`, `setPaused()` and `position()` do anything at all.
 *
 * The one behaviour here with no web counterpart is `play()` with an unchanged path. The web
 * deck rewinds by seeking; this one has to `stop()` and `play()`, because assigning `src` is the
 * only rewind `InnerAudioContext` offers and re-assigning the same value is not guaranteed to
 * restart. That asymmetry is load-bearing for the loop wrap — it IS how the second deck starts
 * the same file from 0 — and nothing asserted it.
 *
 * The fake honours the documented surface: `currentTime` is read-only to the caller (the deck
 * must never write it), `stop()` rewinds where `pause()` does not, and level is the single
 * `volume` number, since there is no audio graph on this platform.
 */
import { describe, it, expect, vi } from 'vitest';
import { WeChatMusicDeck } from './weChatMusicDeck';

function build(opts: { createThrows?: boolean } = {}) {
  const calls: string[] = [];
  const inner = {
    src: '',
    loop: true, // wrong on purpose, so the constructor turning it off is observable
    volume: -1, // ditto: any real value proves the constructor wrote one
    obeyMuteSwitch: false,
    _time: 0,
    playing: false,
    srcHistory: [] as string[],
    errorHandlers: [] as ((res: { errMsg?: string }) => void)[],
    get currentTime(): number {
      return this._time;
    },
    play: vi.fn(function (this: typeof inner) {
      calls.push('play');
      this.playing = true;
    }),
    pause: vi.fn(function (this: typeof inner) {
      calls.push('pause');
      this.playing = false;
    }),
    stop: vi.fn(function (this: typeof inner) {
      calls.push('stop');
      this.playing = false;
      this._time = 0; // stop() rewinds; pause() does not
    }),
    destroy: vi.fn(),
    onError: vi.fn(function (this: typeof inner, cb: (res: { errMsg?: string }) => void) {
      this.errorHandlers.push(cb);
    }),
  };
  // Assigning src starts loading and resets position, like the real one.
  Object.defineProperty(inner, 'src', {
    get() {
      return this._src ?? '';
    },
    set(v: string) {
      this._src = v;
      this.srcHistory.push(v);
      this._time = 0;
      calls.push(`src=${v}`);
    },
    enumerable: true,
    configurable: true,
  });

  const warn = vi.fn();
  let created = 0;
  const deck = new WeChatMusicDeck({
    create: () => {
      created++;
      if (opts.createThrows) throw new Error('no InnerAudioContext');
      return inner as unknown as WxInnerAudioContext;
    },
    // The real one is `packedPathFor`; the subpackage rewrite itself is owned by
    // `audio/wechatMusicLoad.test.ts`. Here it only has to be visibly applied.
    resolveSrc: (p) => `packs/music${p}`,
    warn,
  });
  return { deck, inner, warn, calls, createdCount: () => created };
}

const MENU = '/audio/music/menu.mp3';
const BOSS = '/audio/music/boss.mp3';

describe('WeChatMusicDeck — construction', () => {
  it('opens exactly one stream, silent, with native looping off', () => {
    const { deck, inner, createdCount } = build();
    expect(createdCount()).toBe(1);
    expect(inner.loop).toBe(false); // the player crossfades the wrap
    expect(inner.volume).toBe(0);
    expect(inner.play).not.toHaveBeenCalled();
    expect(deck.position()).toBeNull();
  });

  it('obeys the phone mute switch, explicitly rather than by default', () => {
    expect(build().inner.obeyMuteSwitch).toBe(true);
  });

  it('arms its error handler before anything can fail', () => {
    expect(build().inner.onError).toHaveBeenCalledTimes(1);
  });
});

describe('WeChatMusicDeck — position, the value the loop wrap is decided from', () => {
  it('reports null while idle, not 0', () => {
    // The web deck's equivalent mutation (return 0 for an idle deck) survived that file's whole
    // suite before its test existed. A deck answering 0 tells a caller a stopped stream is
    // sitting at the top of the file, which is precisely the evidence a wrap is looking for.
    const { deck } = build();
    expect(deck.position()).toBeNull();
  });

  it('reports the stream’s own clock while playing', () => {
    const { deck, inner } = build();
    deck.play(MENU);
    inner._time = 12.5;
    expect(deck.position()).toBe(12.5);
  });

  it('reports null for a non-finite currentTime', () => {
    // NaN before the stream has any duration. Handed to the player it would make every
    // comparison false, so a wrap would never fire and the bed would end in silence.
    const { deck, inner } = build();
    deck.play(MENU);
    inner._time = NaN;
    expect(deck.position()).toBeNull();
    inner._time = Infinity;
    expect(deck.position()).toBeNull();
  });

  it('reports null again after being stopped', () => {
    const { deck, inner } = build();
    deck.play(MENU);
    inner._time = 30;
    deck.stop();
    expect(deck.position()).toBeNull();
  });
});

describe('WeChatMusicDeck — pointing the stream at a file', () => {
  it('resolves the path through the deps and assigns it', () => {
    const { deck, inner } = build();
    deck.play(MENU);
    expect(inner.srcHistory).toEqual([`packs/music${MENU}`]);
    expect(inner.play).toHaveBeenCalledTimes(1);
  });

  it('re-assigns src when the file changes', () => {
    const { deck, inner } = build();
    deck.play(MENU);
    deck.play(BOSS);
    expect(inner.srcHistory).toEqual([`packs/music${MENU}`, `packs/music${BOSS}`]);
  });

  it('restarts the SAME file with stop() then play(), never a second src assignment', () => {
    // The asymmetry with the web deck, and the mechanism the loop wrap runs on: the second deck
    // is asked for the file it already holds and has to begin it from 0. Re-assigning an
    // unchanged `src` is not a documented restart, so the rewind goes through stop().
    const { deck, inner, calls } = build();
    deck.play(MENU);
    inner._time = 67;
    calls.length = 0;
    deck.play(MENU);
    expect(inner.srcHistory).toHaveLength(1); // still just the one assignment
    expect(calls).toEqual(['stop', 'play']); // in that order — play() before stop() would silence it
    expect(inner._time).toBe(0);
    expect(deck.position()).toBe(0); // playing again, at the top: not null
  });
});

describe('WeChatMusicDeck — level is a product, because there is no audio graph', () => {
  it('multiplies the settings volume by this deck’s fade', () => {
    const { deck, inner } = build();
    deck.setBusVolume(0.8);
    deck.setFade(0.5);
    expect(inner.volume).toBeCloseTo(0.4, 10);
  });

  it('re-derives the product when EITHER side changes', () => {
    const { deck, inner } = build();
    deck.setBusVolume(0.5);
    deck.setFade(1);
    expect(inner.volume).toBeCloseTo(0.5, 10);
    deck.setFade(0.25); // a crossfade frame
    expect(inner.volume).toBeCloseTo(0.125, 10);
    deck.setBusVolume(0.2); // the player dragging the settings slider mid-fade
    expect(inner.volume).toBeCloseTo(0.05, 10);
  });

  it('starts from the settings default rather than silence-until-told', () => {
    // Nothing has called setBusVolume, which is the state a deck built before
    // `WeChatAudio.setMusicVolume` ever ran would be in.
    const { deck, inner } = build();
    deck.setFade(1);
    expect(inner.volume).toBeCloseTo(0.5, 10);
  });

  it('clamps the settings volume, and the product, into [0, 1]', () => {
    // Recorded honestly: deleting the clamp inside `setBusVolume` survives this, and no test can
    // kill it. `applyVolume` clamps the product on every write, so an out-of-range `bus` can
    // never reach the stream, and `bus` itself is private. A genuine equivalent mutant — the
    // input clamp is defensive duplication, not a second behaviour. Reaching into the private
    // field to force a kill would be faking one (daydayup-mutation-battery memory).
    const { deck, inner } = build();
    deck.setBusVolume(5);
    deck.setFade(1);
    expect(inner.volume).toBe(1);
    deck.setBusVolume(-2);
    expect(inner.volume).toBe(0);
    deck.setBusVolume(1);
    deck.setFade(3); // a fade above 1 would otherwise reach the stream as >1
    expect(inner.volume).toBe(1);
  });

  it('keeps the stream running at volume 0 — silence is a level, not a stop', () => {
    const { deck, inner } = build();
    deck.play(MENU);
    deck.setBusVolume(0);
    expect(inner.volume).toBe(0);
    expect(inner.playing).toBe(true);
    expect(deck.position()).not.toBeNull(); // still the live deck, still driving the wrap
  });
});

describe('WeChatMusicDeck — holding and stopping', () => {
  it('holds and releases a live deck without rewinding it', () => {
    const { deck, inner } = build();
    deck.play(MENU);
    inner._time = 20;
    deck.setPaused(true);
    expect(inner.pause).toHaveBeenCalledTimes(1);
    expect(inner._time).toBe(20); // pause() is not stop()
    deck.setPaused(false);
    expect(inner.play).toHaveBeenCalledTimes(2);
    expect(deck.position()).toBe(20);
  });

  it('does not resume a deck that was stopped rather than paused', () => {
    // An interruption ending while only one deck is live must not start the idle one — on this
    // platform that would be a second bed, at full volume, over the first.
    const { deck, inner } = build();
    deck.setPaused(true);
    deck.setPaused(false);
    expect(inner.play).not.toHaveBeenCalled();
    expect(inner.pause).not.toHaveBeenCalled();
  });

  it('stop() on an idle deck is a no-op, not a second stop', () => {
    const { deck, inner } = build();
    deck.stop();
    expect(inner.stop).not.toHaveBeenCalled();
    deck.play(MENU);
    deck.stop();
    deck.stop();
    expect(inner.stop).toHaveBeenCalledTimes(1);
  });
});

describe('WeChatMusicDeck — a stream that fails', () => {
  it('reports through the injected warn, naming the src it could not play', () => {
    // The message is the whole observable effect, so it is the thing asserted: on this target
    // the likeliest cause is a subpackage that has not landed, and the path says so.
    const { deck, inner, warn } = build();
    deck.play(MENU);
    inner.errorHandlers[0]!({ errMsg: 'errMsg: down' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(`packs/music${MENU}`);
    expect(warn.mock.calls[0]![1]).toBe('errMsg: down');
  });

  it('passes the whole response through when it carries no errMsg', () => {
    const { deck, inner, warn } = build();
    deck.play(MENU);
    const res = { errCode: 10001 };
    inner.errorHandlers[0]!(res as { errMsg?: string });
    expect(warn.mock.calls[0]![1]).toBe(res);
  });

  it('stops claiming a position once the stream has failed', () => {
    // The player decides the wrap from `position()`. A failed deck that kept answering would
    // hold the crossfade against a stream that is not advancing.
    const { deck, inner } = build();
    deck.play(MENU);
    inner._time = 5;
    expect(deck.position()).toBe(5);
    inner.errorHandlers[0]!({ errMsg: 'gone' });
    expect(deck.position()).toBeNull();
  });

  it('falls back to console.warn when no warn is injected', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inner = {
      src: '',
      loop: false,
      volume: 0,
      obeyMuteSwitch: false,
      currentTime: 0,
      duration: 0,
      paused: true,
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      onError: vi.fn(),
    };
    const deck = new WeChatMusicDeck({
      create: () => inner as unknown as WxInnerAudioContext,
      resolveSrc: (p) => p,
    });
    deck.play(MENU);
    const handler = inner.onError.mock.calls[0]![0] as (res: { errMsg?: string }) => void;
    handler({ errMsg: 'boom' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain(MENU);
    spy.mockRestore();
  });

  it('lets a create() failure out, because the caller owns the degrade decision', () => {
    // `WeChatAudio.ensureMusic` catches this and latches music off for the session
    // (`audio/wechatMusicLoad.test.ts` owns that half). Swallowing it here would hand back a
    // deck with no stream behind it.
    expect(() => build({ createThrows: true })).toThrow(/no InnerAudioContext/);
  });
});
