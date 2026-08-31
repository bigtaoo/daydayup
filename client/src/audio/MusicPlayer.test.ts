/**
 * `MusicPlayer` against a recording `MusicDeck` pair — the two-deck crossfade, the loop wrap it
 * is reused for, and the four ways a transition can be interrupted.
 *
 * The deck fake records every call and reports a position the test controls, because BOTH things
 * the player does are decided from a deck's reported position rather than from an internal
 * clock, and a fake that made up its own position would only be testing the player against
 * itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MusicPlayer, type MusicDeck } from './MusicPlayer';
import { MUSIC_CATALOGUE, XFADE_S } from './musicCatalogue';

class FakeDeck implements MusicDeck {
  playedPaths: string[] = [];
  fades: number[] = [];
  stops = 0;
  paused: boolean | null = null;
  /** What `position()` reports. Null = not playing, which is also the real deck's answer for
   *  the frames between `play()` and the stream actually starting. */
  pos: number | null = null;
  playing = false;

  play(path: string): void {
    this.playedPaths.push(path);
    this.playing = true;
    this.pos = 0;
  }
  setFade(level: number): void {
    this.fades.push(level);
  }
  stop(): void {
    this.stops++;
    this.playing = false;
    this.pos = null;
  }
  position(): number | null {
    return this.playing ? this.pos : null;
  }
  setPaused(paused: boolean): void {
    this.paused = paused;
  }
  /** The level it is sitting at right now. */
  get fade(): number {
    return this.fades.at(-1) ?? 0;
  }
}

let a: FakeDeck;
let b: FakeDeck;
let player: MusicPlayer;
const warn = vi.fn();

/** One frame at 60 Hz. */
const FRAME_MS = 1000 / 60;

beforeEach(() => {
  warn.mockClear();
  a = new FakeDeck();
  b = new FakeDeck();
  player = new MusicPlayer({ decks: [a, b], warn });
});

/** Advance `ms` in 60 Hz frames, keeping every playing deck's position moving like a real
 *  stream — which is what makes the wrap assertions below mean anything. */
function run(track: Parameters<MusicPlayer['update']>[0], ms: number): void {
  const frames = Math.round(ms / FRAME_MS);
  for (let i = 0; i < frames; i++) {
    player.update(track, FRAME_MS);
    for (const d of [a, b]) if (d.playing && d.pos !== null) d.pos += FRAME_MS / 1000;
  }
}

describe('MusicPlayer — starting and changing track', () => {
  it('starts the requested track on a deck and fades it in over the crossfade window', () => {
    player.update('menu', FRAME_MS);
    expect(a.playedPaths).toEqual([MUSIC_CATALOGUE.menu.path]);
    // The first frame sets it silent: a bed that snapped to full level would be a click at the
    // exact moment the autoplay gate opens, i.e. on the player's first tap of every session.
    expect(a.fade).toBe(0);
    // Two frames past the window rather than exactly on it: 120 frames of 1/60 s sum to
    // 0.99999... of it in floating point, so a test pinned to the exact boundary would be
    // testing the accumulator's rounding rather than the fade.
    run('menu', XFADE_S * 1000 + FRAME_MS * 2);
    expect(a.fade).toBeCloseTo(MUSIC_CATALOGUE.menu.gain, 5);
    expect(player.isCrossfading).toBe(false);
  });

  it('is a no-op when asked for the track already playing', () => {
    // The property the whole per-frame-derivation design rests on. If this were not a no-op the
    // director would restart the bed 60 times a second.
    run('menu', 3000);
    const playsBefore = a.playedPaths.length + b.playedPaths.length;
    run('menu', 3000);
    expect(a.playedPaths.length + b.playedPaths.length).toBe(playsBefore);
    expect(b.playedPaths).toEqual([]);
    expect(player.current).toBe('menu');
  });

  it('crossfades a track change onto the OTHER deck, with both audible in the middle', () => {
    run('menu', 5000);
    player.update('boss', FRAME_MS);
    expect(b.playedPaths).toEqual([MUSIC_CATALOGUE.boss.path]);
    // Halfway: equal power, so both sit near cos/sin of 45 degrees rather than at 0.5 each — a
    // linear pair would dip ~3 dB here, which on a loop wrap is heard once a minute forever.
    run('boss', (XFADE_S * 1000) / 2);
    expect(a.fade).toBeCloseTo(Math.SQRT1_2, 1);
    expect(b.fade).toBeCloseTo(Math.SQRT1_2, 1);
    expect(a.fade ** 2 + b.fade ** 2).toBeCloseTo(1, 1);
    // ...and at the end the outgoing deck is STOPPED, not just silenced: a media element held
    // at gain 0 keeps decoding, which on a phone is battery spent on nothing.
    run('boss', (XFADE_S * 1000) / 2 + FRAME_MS * 2);
    expect(b.fade).toBeCloseTo(MUSIC_CATALOGUE.boss.gain, 5);
    expect(a.fade).toBe(0);
    expect(a.stops).toBeGreaterThan(0);
    expect(a.playing).toBe(false);
  });

  it('alternates decks across three changes rather than reusing one', () => {
    run('menu', 5000);
    run('boss', 5000);
    run('menu', 5000);
    expect(a.playedPaths).toHaveLength(2);
    expect(b.playedPaths).toHaveLength(1);
  });

  it('fades out to silence when asked for no track at all', () => {
    run('menu', 5000);
    run(null, XFADE_S * 1000 + FRAME_MS * 2);
    expect(a.fade).toBe(0);
    expect(a.stops).toBeGreaterThan(0);
    expect(player.current).toBe(null);
  });
});

describe('MusicPlayer — closing the loop', () => {
  it('starts the second deck at length - XFADE_S and crossfades into it', () => {
    // The reason this class exists. `el.loop = true` cannot be used (MP3 frame padding denies a
    // sample-exact wrap), so the loop IS a track change onto the same file.
    const len = MUSIC_CATALOGUE.menu.lengthS;
    run('menu', 5000);
    a.pos = len - XFADE_S - 0.5; // just before the wrap point
    run('menu', 400);
    expect(b.playedPaths, 'wrapped too early').toEqual([]);
    run('menu', 200); // crosses length - XFADE_S
    expect(b.playedPaths).toEqual([MUSIC_CATALOGUE.menu.path]);
    expect(player.isCrossfading).toBe(true);
    // Same file on both decks, and the incoming one starts from ITS beginning while the
    // outgoing one plays out the measured tail.
    expect(b.pos).toBeLessThan(0.1);
    run('menu', XFADE_S * 1000 + FRAME_MS * 2);
    expect(b.fade).toBeCloseTo(MUSIC_CATALOGUE.menu.gain, 5);
    expect(a.playing).toBe(false);
  });

  it('wraps again and again, alternating decks, without drifting', () => {
    const len = MUSIC_CATALOGUE.menu.lengthS;
    run('menu', 3000);
    for (let wrap = 0; wrap < 4; wrap++) {
      const live = [a, b].find((d) => d.playing)!;
      live.pos = len - XFADE_S - 0.05;
      run('menu', XFADE_S * 1000 + 200);
    }
    expect(a.playedPaths.length + b.playedPaths.length).toBe(5); // the start plus four wraps
    expect(a.playedPaths.length).toBeGreaterThan(1);
    expect(b.playedPaths.length).toBeGreaterThan(1);
    expect([a, b].filter((d) => d.playing)).toHaveLength(1); // exactly one live deck after each
  });

  it('reads the wrap point from the deck, never from an accumulated clock', () => {
    // The distinction that matters after a stall, a backgrounded tab or an interruption: a
    // counter would have advanced with those frames and fired the wrap on its own schedule.
    // Here the deck's position is frozen, so 30 s of frames produce no wrap at all.
    run('menu', 3000);
    const live = [a, b].find((d) => d.playing)!;
    const frozen = 4.0;
    for (let i = 0; i < 1800; i++) {
      player.update('menu', FRAME_MS);
      live.pos = frozen; // a stream that is not advancing
    }
    expect(a.playedPaths.length + b.playedPaths.length).toBe(1);
  });

  it('does not wrap while a deck reports no position yet', () => {
    // The frames between `play()` and the stream starting report null on a real deck, and a
    // player that read that as 0 would be fine — but one that read it as "past the end" would
    // wrap immediately. Pinned because the guard is one line and its absence is inaudible until
    // a slow network makes the gap long enough to notice.
    player.update('menu', FRAME_MS);
    a.pos = null;
    run('menu', 5000);
    expect(b.playedPaths).toEqual([]);
  });
});

describe('MusicPlayer — interruptions', () => {
  it('holds both decks and stops advancing anything while paused', () => {
    run('menu', 5000);
    player.setPaused(true);
    expect(a.paused).toBe(true);
    expect(b.paused).toBe(true);
    // Frozen: the wrap check must not run on a held deck. A deck paused ON the wrap point would
    // otherwise fire the moment it was released, on evidence gathered while it was silent.
    const live = [a, b].find((d) => d.playing)!;
    live.pos = MUSIC_CATALOGUE.menu.lengthS - 0.1;
    run('menu', 5000);
    expect(b.playedPaths).toEqual([]);
    player.setPaused(false);
    expect(a.paused).toBe(false);
    run('menu', 100);
    expect(b.playedPaths).toEqual([MUSIC_CATALOGUE.menu.path]); // resumes and wraps as normal
  });

  it('does not re-issue a pause that is already in effect', () => {
    // `visibilitychange` and `onAudioInterruptionBegin` can both fire more than once, and
    // WeChat's pair in particular arrives in bursts.
    run('menu', 1000);
    player.setPaused(true);
    a.paused = null;
    player.setPaused(true);
    expect(a.paused).toBe(null);
  });

  it('survives a track change arriving mid-crossfade', () => {
    // Two decks and three streams is impossible, so the deck already fading out is reclaimed.
    // Real case: crossing the boss room threshold twice inside two seconds.
    run('menu', 5000);
    player.update('boss', FRAME_MS);
    run('boss', 500); // mid-fade
    player.update('menu', FRAME_MS);
    run('menu', XFADE_S * 1000 + FRAME_MS * 2);
    expect(player.current).toBe('menu');
    expect(player.isCrossfading).toBe(false);
    // Exactly one deck is live and it is at full level; nothing is orphaned at a partial gain
    // with nothing driving it.
    const live = [a, b].filter((d) => d.playing);
    expect(live).toHaveLength(1);
    expect(live[0]!.fade).toBeCloseTo(MUSIC_CATALOGUE.menu.gain, 5);
    expect([a, b].filter((d) => !d.playing)[0]!.fade).toBe(0);
  });

  it('stop() silences both decks with no fade and forgets the track', () => {
    run('menu', 5000);
    player.stop();
    expect(a.playing).toBe(false);
    expect(b.playing).toBe(false);
    expect(player.current).toBe(null);
    expect(player.isCrossfading).toBe(false);
  });
});

describe('MusicPlayer — a deck that throws', () => {
  it('reports and carries on rather than taking the frame down', () => {
    // This runs inside `GameLoop.update`, ahead of the sim step. A throw here would cost the
    // frame in exchange for a sound, and the realistic sources (a media element, an
    // `InnerAudioContext`) are all on design/11's unverified-on-device list.
    a.play = () => {
      throw new Error('no media element');
    };
    expect(() => player.update('menu', FRAME_MS)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to start'), expect.anything());
    // And the player still believes it is on that track, so it will not thrash retrying.
    expect(player.current).toBe('menu');
  });

  it('keeps fading the other deck when one deck cannot set its level', () => {
    a.setFade = () => {
      throw new Error('gain node is gone');
    };
    run('menu', 3000);
    expect(() => run('boss', 3000)).not.toThrow();
    expect(b.fade).toBeCloseTo(MUSIC_CATALOGUE.boss.gain, 5);
  });
});
