/**
 * `WebMusicDeck`'s own contract, at the level the player relies on it.
 *
 * Written because a mutation battery (2026-08-31) found this file's `position()` unguarded by any
 * test: reporting `0` instead of `null` for an idle deck survived the whole suite. It survived for
 * a reason that will not last — `MusicPlayer` only ever reads the LIVE deck's position today, so
 * the idle deck's answer is currently unobservable. The contract is what the player is written
 * against ("`null` when it is not playing"), and a deck that answered 0 would tell any future
 * caller that a stopped stream is sitting at the top of the file.
 *
 * The element fake is deliberately unhelpful in the two ways a real one is: `src` reads back
 * ABSOLUTE, and seeking an unloaded stream throws.
 */
import { describe, it, expect, vi } from 'vitest';
import { WebMusicDeck } from './webMusicDeck';

function build(opts: { seekThrows?: boolean } = {}) {
  const el = {
    loop: true, // wrong on purpose, so the constructor setting it false is observable
    preload: '',
    _src: '',
    _time: 0,
    playing: false,
    plays: 0,
    pauses: 0,
    srcHistory: [] as string[],
    get src(): string {
      return this._src === '' ? '' : `https://example.test${this._src}`;
    },
    set src(v: string) {
      this._src = v;
      this.srcHistory.push(v);
      this._time = 0;
    },
    get currentTime(): number {
      return this._time;
    },
    set currentTime(v: number) {
      if (opts.seekThrows) throw new Error('InvalidStateError');
      this._time = v;
    },
    play: vi.fn(async function (this: { playing: boolean; plays: number }) {
      this.playing = true;
      this.plays++;
    }),
    pause: vi.fn(function (this: { playing: boolean; pauses: number }) {
      this.playing = false;
      this.pauses++;
    }),
  };
  const gain = { gain: { value: -1 }, connect: vi.fn() };
  const source = { connect: vi.fn() };
  const destination = { id: 'destination' };
  const bus = { id: 'bus' };
  const ctx = {
    destination,
    createGain: vi.fn(() => gain),
    createMediaElementSource: vi.fn(() => source),
  } as unknown as AudioContext;
  const deck = new WebMusicDeck({
    ctx,
    bus: bus as unknown as AudioNode,
    resolveUrl: (p) => p,
    createElement: () => el as unknown as HTMLAudioElement,
  });
  return { deck, el, gain, source, bus, ctx };
}

describe('WebMusicDeck — construction', () => {
  it('builds the graph once and starts silent', () => {
    const { gain, source, bus, ctx } = build();
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(bus);
    // Silent, not full: the player fades a deck in, and a deck that started at 1.0 would blare
    // for the frame before the first `setFade`.
    expect(gain.gain.value).toBe(0);
  });

  it('turns native looping off', () => {
    expect(build().el.loop).toBe(false);
  });
});

describe('WebMusicDeck — position, the value the loop wrap is decided from', () => {
  it('reports null while idle, not 0', () => {
    // The mutant this file was written for. `null` means "no wrap decision can be made"; `0`
    // means "at the top of the file", and the two are not interchangeable to any caller.
    const { deck } = build();
    expect(deck.position()).toBe(null);
    deck.play('/audio/music/menu.mp3');
    expect(deck.position()).toBe(0);
    deck.stop();
    expect(deck.position()).toBe(null);
  });

  it('reports null for a non-finite currentTime', () => {
    // A media element reports NaN before its metadata lands. Passed through, that would make
    // every comparison in `checkWrap` false — which happens to be safe — but `Number.isFinite`
    // says so on purpose rather than by luck.
    const { deck, el } = build();
    deck.play('/audio/music/menu.mp3');
    el._time = Number.NaN;
    expect(deck.position()).toBe(null);
  });
});

describe('WebMusicDeck — re-pointing the same stream', () => {
  it('rewinds instead of re-assigning src when the file has not changed', () => {
    // Reached on the second wrap onto the same deck (A -> B -> A), i.e. about two minutes into a
    // menu. Re-assigning an identical `src` restarts the DOWNLOAD on some browsers, which on a
    // phone is a megabyte re-fetched once a minute for no audible difference.
    const { deck, el } = build();
    deck.play('/audio/music/menu.mp3');
    el._time = 40;
    deck.stop();
    deck.play('/audio/music/menu.mp3');
    expect(el.srcHistory).toEqual(['/audio/music/menu.mp3']);
    expect(el.currentTime).toBe(0); // rewound, so the wrap plays the head and not the tail
    expect(el.plays).toBe(2);
  });

  it('assigns src when the file DOES change', () => {
    const { deck, el } = build();
    deck.play('/audio/music/menu.mp3');
    deck.play('/audio/music/boss.mp3');
    expect(el.srcHistory).toEqual(['/audio/music/menu.mp3', '/audio/music/boss.mp3']);
  });

  it('compares by suffix, because src reads back absolute', () => {
    // A real element turns '/audio/music/menu.mp3' into 'https://host/audio/music/menu.mp3'. An
    // equality test against the path would therefore never match, and every wrap would re-assign.
    const { deck, el } = build();
    deck.play('/audio/music/menu.mp3');
    expect(el.src).toContain('https://');
    deck.play('/audio/music/menu.mp3');
    expect(el.srcHistory).toHaveLength(1);
  });

  it('survives an element that refuses to seek', () => {
    // Seeking an unloaded stream throws `InvalidStateError` in some browsers, and 0 is the only
    // position this deck ever wants — it starts there anyway.
    const { deck, el } = build({ seekThrows: true });
    expect(() => deck.play('/audio/music/menu.mp3')).not.toThrow();
    expect(() => deck.stop()).not.toThrow();
    expect(el.plays).toBe(1);
  });
});

describe('WebMusicDeck — holding', () => {
  it('does not resume a deck that was stopped rather than paused', () => {
    // The idle deck is in exactly this state for all but 2 s of every minute, so a blanket
    // resume on focus return would start a second stream on top of the bed.
    const { deck, el } = build();
    deck.play('/audio/music/menu.mp3');
    deck.stop();
    deck.setPaused(true);
    deck.setPaused(false);
    expect(el.plays).toBe(1);
    expect(el.playing).toBe(false);
  });

  it('holds and releases a live deck without losing its position', () => {
    const { deck, el } = build();
    deck.play('/audio/music/menu.mp3');
    el._time = 12.5;
    deck.setPaused(true);
    expect(el.playing).toBe(false);
    deck.setPaused(false);
    expect(el.playing).toBe(true);
    expect(el.currentTime).toBe(12.5);
  });

  it('stop() on an idle deck is a no-op, not a second pause', () => {
    const { deck, el } = build();
    deck.stop();
    expect(el.pauses).toBe(0);
  });
});
