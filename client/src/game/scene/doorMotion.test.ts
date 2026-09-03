/**
 * The pure motion math behind a door's fx (`doorMotion.ts`), plus the two properties of the baked
 * fields that a live frame would never tell you about: that they are seamless in y, and that they
 * fade to nothing at their own left and right edges.
 *
 * Both of those are load-bearing and both are invisible when wrong in the way that matters. A
 * field that is not seamless scrolls a visible horizontal SEAM up the fire once per period — at
 * 1.7 s, which looking at a frame cannot catch and looking at the game for ten seconds can barely
 * catch. A field that does not fade at its x edges draws two hard vertical lines down the flame
 * band, which reads as a rectangle of light rather than as fire.
 *
 * The other half of this file is the Nyquist gate design/01 "Ambient animation rates" asks for and
 * has never had: the doc tabulates every ambient loop's rate and states the failure (`Pickup`'s
 * hover shipped at 19 Hz and reached a player as *"地上的东西闪得太快了"*), but nothing enforced the
 * band. `PERIODS_MS` is one exported table that the code itself aliases, so this cannot pass while
 * the code uses a different number.
 */
import { describe, it, expect } from 'vitest';
import {
  bakeField,
  bakeScanBar,
  breathe,
  FIELD_H,
  flameBandRect,
  FLAME_BAND,
  MOTE_COUNT,
  motePose,
  PERIODS_MS,
  pingPong,
  sawtooth,
} from './doorMotion';

/** The shipped locked leaf, at its real post-trim size (design/01: 221x320 -> 147x217). Every
 *  vertical number in `flameBandRect` goes through the leaf's own top crop, so a fictional art
 *  height here would make the cropped case below prove nothing. */
const ART_W = 147;
const ART_H = 217;

const alphaAt = (buf: Uint8Array, w: number, x: number, y: number): number => buf[(y * w + x) * 4 + 3]!;

describe('the ambient periods stay inside the band design/01 fixed, and are gated rather than tabulated', () => {
  // 60 fps, the phase step per frame at which a sine begins to alias against the display and what
  // renders is a beat frequency rather than the authored motion.
  const FRAME_MS = 1000 / 60;
  const NYQUIST_RAD = Math.PI;

  it('advances every loop by well under the Nyquist limit in one 60 fps frame', () => {
    const entries = Object.entries(PERIODS_MS);
    expect(entries.length).toBeGreaterThanOrEqual(9); // the table is the gate — an empty one passes
    for (const [name, periodMs] of entries) {
      const radPerFrame = (FRAME_MS / periodMs) * Math.PI * 2;
      expect(radPerFrame, `${name} (${periodMs} ms)`).toBeLessThan(NYQUIST_RAD / 10);
    }
  });

  it('keeps every loop in the 0.2-1.3 Hz band the scene already uses, so no door out-paces a pickup', () => {
    for (const [name, periodMs] of Object.entries(PERIODS_MS)) {
      const hz = 1000 / periodMs;
      expect(hz, `${name} too slow`).toBeGreaterThan(0.2);
      expect(hz, `${name} too fast`).toBeLessThan(1.3);
    }
  });

  it('gives the two flame layers periods that do not divide each other, so the pair has no visible loop', () => {
    const ratio = PERIODS_MS.flameB / PERIODS_MS.flameA;
    expect(ratio).toBeGreaterThan(1.3);
    // A ratio that lands on a simple fraction (3/2, 2/1) realigns every few seconds and the pair
    // reads as one shape again. Reject any n/m with m <= 4.
    for (let m = 1; m <= 4; m++) expect(Math.abs(ratio * m - Math.round(ratio * m))).toBeGreaterThan(0.02);
  });
});

describe('pingPong / sawtooth / breathe', () => {
  it('ping-pongs 0 -> 1 -> 0 and never leaves the unit range, including for a negative clock', () => {
    expect(pingPong(0, 1000)).toBeCloseTo(0);
    expect(pingPong(500, 1000)).toBeCloseTo(1);
    expect(pingPong(1000, 1000)).toBeCloseTo(0);
    expect(pingPong(250, 1000)).toBeCloseTo(0.5);
    expect(pingPong(750, 1000)).toBeCloseTo(0.5);
    for (let t = -3000; t < 3000; t += 37) {
      const v = pingPong(t, 1000);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('reverses direction at the turn, which is what makes the bar bounce off a jamb', () => {
    // The whole point of a ping-pong over a wrap: the second half must come BACK, not restart.
    expect(pingPong(600, 1000)).toBeLessThan(pingPong(500, 1000));
    expect(pingPong(400, 1000)).toBeLessThan(pingPong(500, 1000));
  });

  it('saws 0 -> 1 and wraps, and is continuous within a period', () => {
    expect(sawtooth(0, 1000)).toBeCloseTo(0);
    expect(sawtooth(999, 1000)).toBeCloseTo(0.999);
    expect(sawtooth(1000, 1000)).toBeCloseTo(0);
    expect(sawtooth(-1, 1000)).toBeCloseTo(0.999); // a negative clock must not go negative
  });

  it('breathes between 0 and 1 with its extremes a quarter and three quarters through', () => {
    expect(breathe(0, 1000)).toBeCloseTo(0.5);
    expect(breathe(250, 1000)).toBeCloseTo(1);
    expect(breathe(750, 1000)).toBeCloseTo(0);
    for (let t = 0; t < 2000; t += 13) {
      expect(breathe(t, 1000)).toBeGreaterThanOrEqual(0);
      expect(breathe(t, 1000)).toBeLessThanOrEqual(1);
    }
  });
});

describe('motePose — the open state\'s "things come OUT of here" cue', () => {
  it('carries every mote from deep in the passage to past the threshold, monotonically', () => {
    let prev = -1;
    for (let ms = 0; ms < PERIODS_MS.mote; ms += 40) {
      const v = motePose(0, ms).v;
      expect(v).toBeGreaterThanOrEqual(prev); // never turns back — the direction IS the message
      prev = v;
    }
    expect(motePose(0, 0).v).toBeCloseTo(0, 3);
    expect(motePose(0, PERIODS_MS.mote - 1).v).toBeGreaterThan(0.99);
  });

  it('ACCELERATES out of the passage rather than falling at an even rate', () => {
    // The claim `motePose` is written on: slow while the mote is still deep in the dark, quickest
    // as it crosses the threshold toward the player. A linear `eased = v` satisfies every other
    // assertion in this describe — it is monotone, it spans 0..1, it spreads — so without this the
    // smoothstep is unmeasured. (Found by the 2026-09-03b mutation battery.)
    const at = (frac: number): number => motePose(0, PERIODS_MS.mote * frac).v;
    const firstQuarter = at(0.25) - at(0);
    const middle = at(0.6) - at(0.4);
    expect(middle).toBeGreaterThan(firstQuarter * 1.4);
    // ...and symmetric: it eases out at the far end too, rather than only ramping in.
    expect(1 - at(0.75)).toBeCloseTo(at(0.25), 3);
  });

  it('fades in and out, so no mote pops into existence or vanishes mid-flight', () => {
    expect(motePose(0, 0).alpha).toBeCloseTo(0, 3);
    expect(motePose(0, PERIODS_MS.mote / 2).alpha).toBeCloseTo(1, 2);
    expect(motePose(0, PERIODS_MS.mote - 1).alpha).toBeLessThan(0.01);
  });

  it('spreads the motes so no two are ever at the same point of their fall', () => {
    // design/01 "Give co-located instances different start phases" — five motes on one phase is
    // one bright dot travelling out, not dust in a beam.
    for (const t of [0, 431, 1777]) {
      const vs = Array.from({ length: MOTE_COUNT }, (_, i) => motePose(i, t).v);
      for (let i = 0; i < vs.length; i++) {
        for (let j = i + 1; j < vs.length; j++) expect(Math.abs(vs[i]! - vs[j]!)).toBeGreaterThan(0.02);
      }
    }
  });

  it('keeps every mote inside the arch hole and drifting, not falling in a straight line', () => {
    const us: number[] = [];
    for (let ms = 0; ms < PERIODS_MS.mote; ms += 50) {
      const u = motePose(1, ms).u;
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      us.push(u);
    }
    expect(Math.max(...us) - Math.min(...us)).toBeGreaterThan(0.1); // it actually drifts sideways
  });

  it('is a pure function of index and time — no Math.random, so two clients agree', () => {
    expect(motePose(2, 1234)).toEqual(motePose(2, 1234));
  });
});

describe('flameBandRect — the measured fire band, mapped through the leaf own top crop', () => {
  it('maps the fractions straight across for an opening the art fits without cropping', () => {
    const openingW = 64;
    const drawH = 94;
    const band = flameBandRect(openingW, drawH, 0, ART_H, ART_H);
    expect(band.x).toBeCloseTo(FLAME_BAND.x0 * openingW);
    expect(band.w).toBeCloseTo((FLAME_BAND.x1 - FLAME_BAND.x0) * openingW);
    expect(band.y).toBeCloseTo(-drawH + FLAME_BAND.y0 * drawH);
    expect(band.h).toBeCloseTo((FLAME_BAND.y1 - FLAME_BAND.y0) * drawH);
  });

  it('follows the crop DOWN on a kerb door, where most of the art is cut off the top', () => {
    // The real kerb case: 128 wide, cropped to the opening's height, so the fire's own top is gone.
    const openingW = 128;
    const drawH = 104;
    const srcH = (drawH / openingW) * ART_W; // `doorLeafFrame`'s own rule
    const srcY = ART_H - srcH;
    const band = flameBandRect(openingW, drawH, srcY, srcH, ART_H);
    // Still inside the opening, and still a real band rather than a hairline.
    expect(band.y).toBeGreaterThanOrEqual(-drawH);
    expect(band.y + band.h).toBeLessThanOrEqual(0.001);
    expect(band.h).toBeGreaterThan(drawH * 0.3);
    // And it is NOT the uncropped mapping — a version of this that ignored `srcY` would return the
    // same rect for both cases, which is exactly the bug this whole function exists to avoid.
    expect(band.y).not.toBeCloseTo(-drawH + FLAME_BAND.y0 * drawH, 1);
  });

  it('clamps to the opening rather than drawing flame over the lintel or the floor', () => {
    // A crop so aggressive that the band would map outside the opening on both sides.
    const band = flameBandRect(64, 40, ART_H * 0.5, ART_H * 0.05, ART_H);
    expect(band.y).toBeGreaterThanOrEqual(-40);
    expect(band.y + band.h).toBeLessThanOrEqual(0.001);
  });

  it('returns a zero-height band for a degenerate opening, so no flame layers are built at all', () => {
    expect(flameBandRect(64, 0, 0, ART_H, ART_H).h).toBe(0);
    expect(flameBandRect(64, 94, 0, 0, ART_H).h).toBe(0);
  });

  it('returns FINITE coordinates for a degenerate opening, which is what the guard is really for', () => {
    // The 2026-09-03b battery found the early return is equivalent as far as HEIGHT goes: with it
    // deleted, a zero `srcH` divides by zero, the clamps still collapse `h` to 0, and every
    // assertion above still passes. What the guard actually buys is a sane `y` — without it the
    // top clamp resolves to Infinity and the rect that comes back is unusable for anything but its
    // height. Pinning the finiteness is what makes the line load-bearing rather than decorative.
    for (const band of [
      flameBandRect(64, 0, 0, ART_H, ART_H),
      flameBandRect(64, 94, 0, 0, ART_H),
      flameBandRect(64, 94, ART_H * 0.5, 0, ART_H),
    ]) {
      expect(Number.isFinite(band.x)).toBe(true);
      expect(Number.isFinite(band.y)).toBe(true);
      expect(Number.isFinite(band.w)).toBe(true);
      expect(Number.isFinite(band.h)).toBe(true);
    }
  });
});

describe('the baked fields — seamless in y, faded at the x edges', () => {
  it('meets its own first row exactly at its last, so a scroll shows no horizontal seam', () => {
    for (const [key, tongues] of [['flame', 4], ['stream', 3]] as const) {
      const tex = bakeField(key, tongues);
      const buf = tex.source.resource as Uint8Array;
      const w = tex.width;
      // Row 0 is where row `h` would land after one full tile of scroll. A truly seamless field
      // has them within a linear step of each other at every column.
      const step: number[] = [];
      for (let x = 0; x < w; x++) {
        step.push(Math.abs(alphaAt(buf, w, x, 0) - alphaAt(buf, w, x, FIELD_H - 1)));
      }
      const worst = Math.max(...step);
      const typicalStep = Math.max(
        ...Array.from({ length: w }, (_, x) => Math.abs(alphaAt(buf, w, x, 1) - alphaAt(buf, w, x, 0))),
      );
      // The wrap is no bigger a jump than an ordinary neighbouring-row step, plus rounding.
      expect(worst, `${key} wrap`).toBeLessThanOrEqual(typicalStep + 3);
    }
  });

  it('fades to nothing at both x edges, so the band own sides are not two hard lines', () => {
    const tex = bakeField('flame', 4);
    const buf = tex.source.resource as Uint8Array;
    const w = tex.width;
    let maxEdge = 0;
    let maxMiddle = 0;
    for (let y = 0; y < FIELD_H; y++) {
      maxEdge = Math.max(maxEdge, alphaAt(buf, w, 0, y), alphaAt(buf, w, w - 1, y));
      maxMiddle = Math.max(maxMiddle, alphaAt(buf, w, w >> 1, y));
    }
    expect(maxEdge).toBeLessThan(12);
    expect(maxMiddle).toBeGreaterThan(120); // and the middle is a real field, not a blank bake
  });

  it('is uniform enough down its length that the density has to come from stacking, not the bake', () => {
    // The bias that used to live here ("fire is densest low") was a non-periodic vertical lift,
    // and it is the reason the seam test above failed the first time it ran. It now lives in
    // `doorFx.FLAME_B_OF_BAND` — a second layer over the band's lower part — so the FIELD must be
    // flat down its length, or the bias would travel with the scroll instead of staying at the
    // base of the doorway.
    const tex = bakeField('flame', 4);
    const buf = tex.source.resource as Uint8Array;
    const band = (y0: number, y1: number): number => {
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < tex.width; x++) {
          sum += alphaAt(buf, tex.width, x, y);
          n++;
        }
      }
      return sum / n;
    };
    const top = band(0, FIELD_H / 4);
    const bottom = band((FIELD_H * 3) / 4, FIELD_H);
    expect(Math.abs(bottom - top) / Math.max(top, bottom)).toBeLessThan(0.35);
  });

  it('caches one bake per distinct field, so two flame layers share one upload', () => {
    expect(bakeField('flame', 4)).toBe(bakeField('flame', 4));
    expect(bakeField('flame', 4)).not.toBe(bakeField('stream', 3));
    // The key has to encode every input that changes the pixels (`bakedField`'s own contract) —
    // without the tongue count in it, these two would be the same texture.
    expect(bakeField('probe', 3)).not.toBe(bakeField('probe', 4));
  });

  it('bakes a soft scan bar with a bright core and dark ends, on POT dimensions', () => {
    const tex = bakeScanBar();
    const buf = tex.source.resource as Uint8Array;
    const w = tex.width;
    const isPot = (n: number): boolean => (n & (n - 1)) === 0;
    // POT only: WebGL1 (WeChat) silently disables mipmapping on an NPOT texture.
    expect(isPot(w)).toBe(true);
    expect(isPot(tex.height)).toBe(true);
    const mid = alphaAt(buf, w, w >> 1, 0);
    expect(mid).toBeGreaterThan(200);
    expect(alphaAt(buf, w, 0, 0)).toBeLessThan(mid * 0.2);
    expect(alphaAt(buf, w, w - 1, 0)).toBeLessThan(mid * 0.2);
    // Uniform along its length — it is a bar, and any variation would strobe as it sweeps.
    for (let y = 1; y < tex.height; y++) expect(alphaAt(buf, w, w >> 1, y)).toBe(mid);
  });
});
