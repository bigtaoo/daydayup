/**
 * The two measured constants in `doorMotion.ts`, re-derived from the SHIPPED door art every run.
 *
 * `FLAME_BAND` and `OPEN_HOLE` are the only numbers in the door fx that describe a PNG rather than
 * a decision, and they are the two that a regenerated asset silently invalidates. The flame
 * overlay is the case that matters: it is the one animated layer that cannot let the art's own
 * alpha mask it (the hazard leaf is opaque, so an overlay behind it would be invisible), so it is
 * confined to a rect derived from where the fire is. Move the fire in the file — a re-crop, a
 * re-trim, a regeneration at a different margin — and the flames animate over the stone frame
 * while every code test still passes.
 *
 * Same contract `environmentArt.test.ts` puts on the portal arch's opening ("re-derives them from the
 * file's own alpha channel every run and fails if they drift") and `doorStandCoverage.test.ts`
 * puts on the leaf's own dimensions. Sibling of `environmentArt.test.ts`, which measures these
 * same two files for tone and alpha rather than for geometry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { FLAME_BAND, OPEN_HOLE } from './doorMotion';

interface Img {
  width: number;
  height: number;
  data: Uint8Array;
}

const load = (rel: string): Img => decodePNG(readFileSync(new URL(rel, import.meta.url))) as Img;

const locked = load('../../../public/environment/door_locked_raw.png');
const open = load('../../../public/environment/door_open_raw.png');

/**
 * "Hot" — how much this pixel reads as FIRE rather than as stone: opacity times value times
 * saturation. The stone frame is a desaturated blue-grey (design/13's "environment desaturated"),
 * the fire is a saturated orange at high value, and the product separates them by roughly 4x with
 * no threshold tuning needed. Value alone does not: the frame's lit coping is as bright as the
 * flame's darker bands.
 */
function hot(img: Img, x: number, y: number): number {
  const i = (y * img.width + x) * 4;
  const r = img.data[i]!;
  const g = img.data[i + 1]!;
  const b = img.data[i + 2]!;
  const a = img.data[i + 3]!;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  return (a / 255) * (mx / 255) * sat;
}

/** Mean `hot` down one column / across one row. */
const colHot = (img: Img, x: number): number => {
  let s = 0;
  for (let y = 0; y < img.height; y++) s += hot(img, x, y);
  return s / img.height;
};
const rowHot = (img: Img, y: number): number => {
  let s = 0;
  for (let x = 0; x < img.width; x++) s += hot(img, x, y);
  return s / img.width;
};

/** The first and last index at which `f` reaches `t`, as fractions of `n`. */
function span(n: number, f: (i: number) => number, t: number): [number, number] {
  let lo = 0;
  let hi = n - 1;
  while (lo < n && f(lo) < t) lo++;
  while (hi >= 0 && f(hi) < t) hi--;
  return [lo / n, (hi + 1) / n];
}

describe('FLAME_BAND — where the fire is in door_locked_raw.png', () => {
  it('matches the shipped art to within a hundredth of the file', () => {
    const [x0, x1] = span(locked.width, (x) => colHot(locked, x), 0.35);
    const [y0, y1] = span(locked.height, (y) => rowHot(locked, y), 0.35);
    expect(x0).toBeCloseTo(FLAME_BAND.x0, 2);
    expect(x1).toBeCloseTo(FLAME_BAND.x1, 2);
    expect(y0).toBeCloseTo(FLAME_BAND.y0, 2);
    expect(y1).toBeCloseTo(FLAME_BAND.y1, 2);
  });

  it('is a plateau rather than a threshold artefact — the span barely moves from 0.3 to 0.4', () => {
    // The reason this can be a constant at all. If the fire faded gradually into the frame, any
    // number here would be a choice of threshold dressed up as a measurement.
    const at = (t: number): number[] => [
      ...span(locked.width, (x) => colHot(locked, x), t),
      ...span(locked.height, (y) => rowHot(locked, y), t),
    ];
    const lo = at(0.3);
    const hi = at(0.4);
    for (let i = 0; i < lo.length; i++) expect(Math.abs(lo[i]! - hi[i]!)).toBeLessThan(0.07);
  });

  it('sits well inside the art, so the overlay cannot reach the stone frame', () => {
    expect(FLAME_BAND.x0).toBeGreaterThan(0.15);
    expect(FLAME_BAND.x1).toBeLessThan(0.85);
    expect(FLAME_BAND.y0).toBeGreaterThan(0.12);
    expect(FLAME_BAND.y1).toBeLessThan(0.88);
    // And the frame really is cool stone where the band is not — the measurement's other half.
    const frameHot = colHot(locked, Math.round(locked.width * 0.06));
    const fireHot = colHot(locked, Math.round(locked.width * 0.5));
    expect(fireHot).toBeGreaterThan(frameHot * 3);
  });
});

describe('OPEN_HOLE — the arch opening in door_open_raw.png', () => {
  /** For each row whose centre pixel is transparent, the jamb-bounded clear run containing it.
   *  Rows where the run reaches an outer edge are the art's transparent MARGIN, not the hole. */
  function holeSpans(): { l: number; r: number }[] {
    const clear = (x: number, y: number): boolean => open.data[(y * open.width + x) * 4 + 3]! < 24;
    const out: { l: number; r: number }[] = [];
    const cx = open.width >> 1;
    for (let y = 0; y < open.height; y++) {
      if (!clear(cx, y)) continue;
      let l = cx;
      while (l > 0 && clear(l - 1, y)) l--;
      let r = cx;
      while (r < open.width - 1 && clear(r + 1, y)) r++;
      if (l === 0 || r === open.width - 1) continue;
      out.push({ l: l / open.width, r: (r + 1) / open.width });
    }
    return out;
  }

  it('matches the mean jamb-bounded span of the shipped arch', () => {
    const rows = holeSpans();
    expect(rows.length).toBeGreaterThan(open.height * 0.5); // there IS a hole to measure
    const meanL = rows.reduce((a, s) => a + s.l, 0) / rows.length;
    const meanR = rows.reduce((a, s) => a + s.r, 0) / rows.length;
    expect(meanL).toBeCloseTo(OPEN_HOLE.x0, 2);
    expect(meanR).toBeCloseTo(OPEN_HOLE.x1, 2);
  });

  it('is the MEAN and not the widest span, so a mote at its edge still clears the jambs', () => {
    // The arch narrows toward its crown. Taking the widest run would put the outermost motes
    // over stone for the upper half of their travel — visible only on a frame, and only if you
    // were looking at the right door.
    const rows = holeSpans();
    const widestL = Math.min(...rows.map((s) => s.l));
    const widestR = Math.max(...rows.map((s) => s.r));
    expect(OPEN_HOLE.x0).toBeGreaterThan(widestL);
    expect(OPEN_HOLE.x1).toBeLessThan(widestR);
  });

  it('has a genuinely transparent middle, not an opaque grey one', () => {
    // The failure `alpha-audit.mjs` exists for, and one this project has actually shipped: an
    // opaque-grey background and a real alpha channel look identical in a preview. The open
    // state's whole "the stone masks the light for free" contract depends on this being real.
    const cx = open.width >> 1;
    const cy = Math.round(open.height * 0.75);
    expect(open.data[(cy * open.width + cx) * 4 + 3]!).toBeLessThan(24);
  });
});
