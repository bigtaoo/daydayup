// New 2026-09-03 (CLAUDE.md form 1 — an independent function module split out of `doorFx.ts` when
// that file crossed the 500-line convention): the pure MOTION math a door's fx are composed from,
// plus the two procedurally baked fields they scroll. No Pixi display objects, no per-door state —
// `doorFx.ts` owns the layers and the clock, this owns what a clock reading turns into.
//
// Everything here is either a pure function of (index, time) or a cached bake, which is what makes
// the whole animation testable without a canvas and identical on every client (no `Math.random`,
// per design/06).
import { type Texture } from 'pixi.js';
import { bakedField, writeTexel } from '../../render/shadeRamp';

const TAU = Math.PI * 2;
/** Spreads co-located instances' start phases, per design/01 "Give co-located instances different
 *  start phases" — without it the two doors of one room breathe in unison and read as a single
 *  synchronised flash rather than as two fixtures. Deterministic (the door's index, never
 *  `Math.random`), so two clients draw the same room identically. Exported because `doorFx` uses
 *  it for the same purpose one level up, on a whole door's clock. */
export const PHI_FRAC = 0.6180339887498949;

/** How many motes drift out of an open doorway at once. Five, on one shared cycle at
 *  golden-angle-spaced phases, is `Portal.drawParticles`'s ten scaled to a doorway. */
export const MOTE_COUNT = 5;


/**
 * Every period in this file, in ms, and every one of them a PERIOD rather than a rate — design/01
 * "Ambient animation rates": `Pickup`'s hover shipped as a bare `0.12` rad/ms (19 Hz, 2 rad per
 * 60 fps frame) and reached a player as *"地上的东西闪得太快了"*, because a rate constant states
 * nothing a human can sanity-check. Slowest here is 4.2 s (0.24 Hz), fastest 1.4 s (0.71 Hz), all
 * of them inside the 0.48-1.27 Hz band the scene's existing loops already occupy — and all of them
 * gated against the Nyquist limit by `doorFx.test.ts` rather than only tabulated in the doc.
 *
 * Exported as ONE table, and every constant below is an alias into it, so that gate cannot go
 * vacuous: a new loop with a hand-rolled period would not appear in the table the test reads, and
 * a period the test does check cannot be a second, unused copy of the number the code uses.
 */
export const PERIODS_MS = {
  flameA: 1700,
  flameB: 2750, // ~1.618x flameA: the two never realign, so the loop has no visible period
  scan: 1400,
  lockedBreathe: 1750,
  streamA: 2600,
  streamB: 4200,
  openBreathe: 2400,
  mote: 2800,
  pulse: 2400,
} as const;

const MOTE_CYCLE_MS = PERIODS_MS.mote;

/** Scroll rates, world px per ms, derived from the periods above and the field's own tile height —
 *  one full tile per period, so "period" means what it says however the band is sized. */
export const FIELD_H = 128;

/**
 * Where the fire actually is inside `door_locked_raw.png`, as fractions of the art.
 *
 * The flame overlay has to sit ON TOP of the leaf (the hazard leaf is opaque, so an overlay behind
 * it would be invisible), which means it is the one layer in this file that cannot let the art's
 * own alpha mask it — the open state's streams sit BEHIND the leaf and get the arch's stone for
 * free, exactly as `drawThroughLight` documents. So the band is measured instead of guessed:
 * `doorArtBands.test.ts` re-derives these four numbers from the shipped PNG's own pixels every run
 * (saturation x value, the fire against the stone frame) and fails if the art moves under them —
 * the same contract `environmentArt.test.ts` puts on the portal arch's opening. Stable to +/-0.01 across
 * thresholds 0.3 to 0.4, i.e. this is a plateau, not a threshold artefact.
 */
export const FLAME_BAND = { x0: 0.197, x1: 0.803, y0: 0.184, y1: 0.816 } as const;
/**
 * The open arch's hole in `door_open_raw.png`, from its alpha channel — the MEAN span of the
 * jamb-bounded transparent run, not the widest, so a mote drifting at the edge of it still clears
 * the stone at every height. Same test, same contract.
 */
export const OPEN_HOLE = { x0: 0.239, x1: 0.769 } as const;

/** A rect in the fixture's own local space (x from the opening's west edge, y negative upward from
 *  the threshold) — what `flameBandRect` resolves the fractions above into. */
export interface BandRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `FLAME_BAND` resolved into fixture-local px for one opening.
 *
 * The leaf is fit by WIDTH and cropped off the TOP (`doorLeaf.doorLeafFrame`), so the horizontal
 * fractions map straight across but the vertical ones have to go through the crop: art row `ry`
 * lands at `-drawH + (ry - srcY) / srcH * drawH`. On a kerb door, where `srcY` can cut away most of
 * the art, the band clamps to whatever of the fire is still on screen — and returns zero height if
 * none of it is, which is the caller's cue to build no flame layers at all.
 *
 * Pure: no Pixi, no textures. Exported for tests.
 */
export function flameBandRect(openingW: number, drawH: number, srcY: number, srcH: number, artH: number): BandRect {
  const x = FLAME_BAND.x0 * openingW;
  const w = (FLAME_BAND.x1 - FLAME_BAND.x0) * openingW;
  if (srcH <= 0 || drawH <= 0) return { x, y: 0, w, h: 0 };
  const toLocal = (ry: number): number => -drawH + ((ry - srcY) / srcH) * drawH;
  const top = Math.max(-drawH, toLocal(FLAME_BAND.y0 * artH));
  const bottom = Math.min(0, toLocal(FLAME_BAND.y1 * artH));
  return { x, y: top, w, h: Math.max(0, bottom - top) };
}

/** 0 -> 1 -> 0, linear, once per `periodMs`. The scan bar's sweep: a ping-pong rather than a
 *  wrap, because a bar that reappears on the far side reads as a second bar, and because bouncing
 *  off the jambs is itself the "you are contained" statement. Exported for tests. */
export function pingPong(t: number, periodMs: number): number {
  // TWO modulos, not one. `(t % p + p)` only rescues a NEGATIVE clock; it does not wrap a positive
  // one, so the first version of this returned 1.5 at half a period and swept the bar off to
  // `2 - 3 = -1`. `doorMotion.test.ts` caught it before a frame did — live, the scan bar would
  // have vanished past a jamb for the whole second half of every sweep.
  const p = (((t % periodMs) + periodMs) % periodMs) / periodMs;
  return p < 0.5 ? p * 2 : 2 - p * 2;
}

/** 0 -> 1, once per `periodMs`, discontinuous at the wrap — the pulse rings, whose alpha is 0 at
 *  the wrap so the discontinuity is never drawn. Exported for tests. */
export function sawtooth(t: number, periodMs: number): number {
  return (((t % periodMs) + periodMs) % periodMs) / periodMs;
}

/** A sine mapped to 0..1 — every breathe in this file. Exported for tests. */
export function breathe(t: number, periodMs: number): number {
  return 0.5 + 0.5 * Math.sin((t / periodMs) * TAU);
}

/** One mote's pose at time `t`, in 0..1 across the arch hole and 0..1 along its fall out of the
 *  passage. Deterministic in `i` and `t` — no `Math.random`, so two clients draw the same doorway
 *  identically, the same rule `Portal.drawParticles` follows. Exported for tests. */
export function motePose(i: number, t: number): { u: number; v: number; alpha: number } {
  const phase = (((t + (i * MOTE_CYCLE_MS) / MOTE_COUNT) % MOTE_CYCLE_MS) + MOTE_CYCLE_MS) % MOTE_CYCLE_MS;
  const v = phase / MOTE_CYCLE_MS;
  // Accelerating out of the passage: slow while it is still deep in the dark, quickest as it
  // crosses the threshold toward the player.
  const eased = v * v * (3 - 2 * v);
  const u = 0.5 + 0.34 * Math.sin(TAU * (v * 0.8 + i * PHI_FRAC));
  return { u, v: eased, alpha: Math.sin(Math.PI * v) };
}

/**
 * A seamless-in-y field of soft vertical tongues, white and premultiplied, for the flame overlay
 * and the light streams to be tinted and scrolled.
 *
 * Seamless by construction rather than by blending two crossfading copies: every vertical term is
 * a sine of an INTEGER number of cycles over the tile's height, so the last row meets the first
 * exactly. That is the whole reason this is baked rather than prompted — a tileable field is a
 * falloff you converge on by editing a number, and `slashArc.ts` already states the rule for that
 * case ("an image model brings a MATERIAL, and there is no material here").
 *
 * **No vertical bias lives in here, and that is not an oversight.** Fire is densest low, and the
 * first version said so with a `0.35 + 0.65 * (1 - y/h)` lift — which is NOT periodic in y, so it
 * put a hard step at the tile's own wrap and the "seamless" field scrolled a visible seam up the
 * fire once per period. `doorMotion.test.ts` caught it before a frame ever did. The bias is a
 * SCREEN-space property anyway ("dense at the base of the band"), not a texture-space one: baked
 * in, it would travel with the scroll. `doorFx` gets it by stacking the second flame layer over
 * the band's lower part instead, which pins it where it belongs and leaves both bakes wrappable.
 */
export function bakeField(key: string, tongues: number): Texture {
  const W = 64;
  // The key must encode every input that changes the pixels (`bakedField`'s own contract), so
  // the flame pair and the stream pair are two bakes and not four, and never one.
  return bakedField(`doorfx:${key}:${tongues}`, W, FIELD_H, (rgba, w, h) => {
    for (let y = 0; y < h; y++) {
      const yn = y / h;
      for (let x = 0; x < w; x++) {
        const xn = x / w;
        // Vertical structure: two integer-cycle waves per tile, the second at 3x, so the tongues
        // have both a length and a flicker without ever repeating within one tile.
        const wave = 0.55 + 0.28 * Math.sin(TAU * (yn + xn * 1.7)) + 0.17 * Math.sin(TAU * (3 * yn - xn * 2.3));
        // Horizontal structure: `tongues` soft columns, each wandering sideways as it rises.
        const wander = 0.13 * Math.sin(TAU * (2 * yn + xn));
        const tongue = 0.5 + 0.5 * Math.cos(TAU * (xn * tongues + wander));
        // The band's own left/right edges are faded IN THE TEXTURE, and the caller sets
        // `tileScale.x` so exactly one copy spans the band — so the field never repeats
        // horizontally and these edges are the layer's edges, not a seam.
        // Over `w - 1`, not `w`: with `x / w` the LAST column lands at sin(0.984 pi) = 0.05,
        // which is a 12/255 hairline down the band's right side and nothing down its left. The
        // field never repeats horizontally (`doorFx.buildField` fits exactly one copy across), so
        // an inclusive span is the correct one here.
        const edge = Math.sin(Math.PI * (x / (w - 1)));
        const a = Math.max(0, Math.min(1, wave * tongue * tongue * edge));
        writeTexel(rgba, y * w + x, { r: a, g: a, b: a, a });
      }
    }
  });
}

/** The scan bar: one soft-edged vertical bar, white and premultiplied. Its own tiny bake rather
 *  than a `Graphics` rect for the reason every ramp in `doorLights.ts` is banded — a hard-edged
 *  rect sliding across an opening reads as a rendering artefact, not as light. */
export function bakeScanBar(): Texture {
  const W = 32;
  const H = 8;
  return bakedField('doorfx:scan', W, H, (rgba, w, h) => {
    for (let x = 0; x < w; x++) {
      const t = (x + 0.5) / w;
      // Gaussian-ish across, with a bright hairline core so the bar has a value peak instead of
      // one flat wash — same shape reasoning as `FxController.muzzleFlare`'s near-white core.
      const soft = Math.exp(-((t - 0.5) * (t - 0.5)) / 0.02);
      const core = Math.exp(-((t - 0.5) * (t - 0.5)) / 0.0012);
      const a = Math.max(0, Math.min(1, soft * 0.7 + core * 0.35));
      for (let y = 0; y < h; y++) writeTexel(rgba, y * w + x, { r: a, g: a, b: a, a });
    }
  });
}
