// Split out of skinFx.ts (2026-08-26, shell rewrite): the ONE texture the shield shader
// samples — a seamless HEX-CELL tile — and nothing else. A sibling of `shieldFx.ts` (which the
// shader itself moved into later the same day), imported by it, never the other way round.
//
// 2026-08-27: the pattern was irregular jittered "scales" until the report *"护盾中间的6边形看
// 不清，看起来还是一个圈"*. It is hexagons now, and the encoding changed with it — see
// `paintScaleTile` for the signed zero-mean contract, which is the half of that fix that
// actually made the pattern visible.
//
// Why this is generated rather than authored art (the question the 2026-08-26 session asked
// directly — *"或许那张鳞片细节图还是得出？"*). The tile has exactly two hard requirements:
// it must tile seamlessly on both axes, and its numeric range must be known, because the shader
// adds it to the shell's own brightness. Those are the two things an image model is worst at and
// a 40-line Voronoi is exact at — and the second one is now a stated contract with a measured
// mean, which no painted PNG could offer. Three further reasons, all specific to this repo:
//
//   - It ships zero bytes. `design/04`'s WeChat main package is capped at 4 MB, and a soft
//     translucent overlay is the least compressible thing there is.
//   - It sidesteps the whole art pipeline's known failure set for exactly this kind of content
//     — the invisible alpha veil (`alphaClamp.mjs`), defringe, and the haze a box-downsample
//     introduces into a soft mask. None of those can happen to a buffer we fill ourselves.
//   - Density has to be balanced against the shader's own UV compression at the limb, which is
//     a number you converge on by editing a number, not by editing a prompt.
//
// If the shield ever wants a MATERIAL rather than a pattern (dragon scale, hammered iron, carved
// runes), that is an art-direction decision and this file is the wrong tool. Today it is a
// pattern.
import type { Texture } from 'pixi.js';
import { bakedField } from '../../../render/shadeRamp';

/** Tile resolution. Power-of-two on purpose: WebGL1 (WeChat, design/04) silently drops both
 *  mipmapping and REPEAT wrapping on an NPOT texture, and this needs both. */
const TILE = 256;

/** Cells across and down.
 *
 * These two numbers are the whole reason the pattern is HEXAGONAL (2026-08-27; the previous
 * 7x5 jittered grid with a squashed metric produced irregular "scales", and the report was
 * *"护盾中间的6边形看不清，看起来还是一个圈"* — the pattern was not reading as cells at all).
 * A hex grid is not a special case that needs its own generator: the Voronoi diagram of a
 * TRIANGULAR lattice *is* a tiling of regular hexagons, so the machinery below is unchanged
 * and only the point placement moved — row `j` offset by half a column (`scaleCells`).
 *
 * The lattice is regular when rowSpacing / colSpacing = sqrt(3)/2 = 0.8660. Here that ratio is
 * CELLS_X / CELLS_Y = 7/8 = 0.8750, i.e. 1.0% off — the hexagons are imperceptibly taller than
 * regular, which is the price of an integer cell count in each axis, and `SCALE_TILE_SHAPE`
 * publishes the ratio so the suite measures that error rather than trusting this comment.
 *
 * CELLS_Y must stay EVEN. The row offset alternates with `j & 1`, so an odd count would put a
 * half-column step across the v = 0 wrap and the tile would seam — the one failure mode the
 * hex lattice has that the old jittered grid did not. */
const CELLS_X = 7;
const CELLS_Y = 8;

/** Width of the glowing border LINE, in the `d2 - d1` Voronoi edge metric — which is twice the
 *  perpendicular distance to the cell boundary, so this is the line's full on-tile width.
 *
 *  Set from the on-SCREEN width it produces, not from taste: at gameplay zoom the shell is
 *  ~190 px across and `MEMBRANE_TILE`'s projection puts ~0.0047 tile-units in a pixel at the
 *  wall band, so 0.018 is a ~3.8 px line inside a ~30 px cell. Both halves of that matter — a
 *  1 px line shimmers and a 7 px one closes the cell up. `shieldShellModel.test.ts` measures
 *  the resulting contrast; this file's suite measures the geometry. */
const LINE_W = 0.024;

/** Radius of the faint dome at each cell's own centre, in tile units, against an inradius of
 *  ~0.071. Not the pattern's carrier — that is the line — just enough internal shading that a
 *  cell reads as a panel with a middle rather than as a hole. */
const DOME_R = 0.055;

/** Weights of the two terms in the raw field, before the zero-mean remap below. The line is the
 *  pattern; the dome is a hint. */
const LINE_AMP = 1.0;
const DOME_AMP = 0.35;

/** Deterministic, so the tile is identical on every device and in every test run — the same
 *  reason `Particles.ts` never reaches for `Math.random` in anything the sim can see. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface Cell {
  x: number;
  y: number;
  /** This cell's place in the extinction order, 0..1, published in the tile's GREEN channel so
   *  the shader can put out whole scales one at a time as the shield pool drains (design/13's
   *  dual-channel law: the damage state must change the SHAPE, not only the brightness).
   *
   *  A shuffled RANK, not a random draw. Two reasons, and the first is a real defect the tile
   *  test caught: at 35 cells quantized into a 256-level channel, independent draws collide
   *  with ~90% probability (birthday), and a collision means two scales that always go out
   *  together. The second is that ranks are evenly spaced, so the fraction of the membrane
   *  still lit tracks the shield ratio linearly instead of coming apart in lumps. */
  rank: number;
}

/** The triangular lattice whose Voronoi diagram is the hex grid. Rows alternate a half-column
 *  offset; there is deliberately NO jitter — jitter is what turned this into irregular scales,
 *  and a manufactured energy membrane wants the regularity (it is also what makes the 3x3
 *  neighbourhood search in `paintScaleTile` exact by inspection rather than by a bound). */
export function scaleCells(): Cell[] {
  const rnd = lcg(0x5eed);
  const out: Cell[] = [];
  for (let j = 0; j < CELLS_Y; j++) {
    for (let i = 0; i < CELLS_X; i++) {
      out.push({
        x: (i + 0.5 + 0.5 * (j & 1)) / CELLS_X,
        y: (j + 0.5) / CELLS_Y,
        rank: 0,
      });
    }
  }
  // Fisher-Yates over the same stream, so the extinction order is scattered across the tile
  // rather than sweeping it row by row — a shield failing top-to-bottom reads as a wipe.
  const order = out.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  order.forEach((cell, place) => {
    out[cell]!.rank = (place + 0.5) / out.length;
  });
  return out;
}

/** Wrapped index into the `CELLS_X * CELLS_Y` grid. */
const cellAt = (i: number, j: number): number =>
  (((j % CELLS_Y) + CELLS_Y) % CELLS_Y) * CELLS_X + (((i % CELLS_X) + CELLS_X) % CELLS_X);

/**
 * Fill one RGBA tile: `r` = the SIGNED hex field, `g` = the owning cell's extinction rank,
 * `b` unused, `a` = 1.
 *
 * The red channel's contract, which `shieldFx.ts` depends on and this file's suite pins:
 *
 *   r = 0.5 + 0.5 * p,  where p is ZERO-MEAN over the tile and peaks at exactly +1.
 *
 * p > 0 is a cell BORDER (the glowing line), p < 0 a cell interior (the hollow). The zero mean
 * is the load-bearing half and it is enforced here, by measuring the raw field and subtracting
 * its own average, not by hand-tuning constants until it looks balanced. Two things fall out of
 * it (2026-08-27):
 *
 *   - The shader can add the pattern to the shell's brightness INSTEAD of multiplying the shell
 *     by it. Multiplying was why the membrane was invisible: the shell's interior brightness is
 *     deliberately ~0.11 (it has to composite over `Entity`'s ground shadow without hiding it),
 *     so a multiplicative pattern there swung the output by ~9 of 255 — under a tenth of what
 *     the eye needs. An additive one is set by its own gain.
 *   - It can do that WITHOUT brightening the shell on average, so the ground-shadow budget the
 *     multiplicative version was protecting is still protected: over any patch of membrane the
 *     added light sums to zero. The lines get their contrast by taking it from the cells.
 *
 * Because the mean is subtracted rather than assumed, `p`'s negative floor is small (~-0.2, the
 * area-weighted mean of a field that is mostly cell interior) while its positive peak is 1.0 —
 * which is exactly the asymmetry a grid of thin bright lines on a dark field should have.
 *
 * Exported for the tests, which measure the buffer directly — a texture has no readback path
 * under vitest, and the properties worth pinning (seamlessness, the contract above, cell count,
 * hexagonality) are properties of these bytes.
 */
export function paintScaleTile(rgba: Uint8Array, w: number, h: number): void {
  const pts = scaleCells();
  // Pass 1: the raw unsigned field. Held as floats because pass 2 needs the tile's own mean and
  // peak, and quantizing before centring would bake a rounding bias into the "zero" above.
  const raw = new Float32Array(w * h);
  let sum = 0;
  for (let py = 0; py < h; py++) {
    const v = (py + 0.5) / h;
    const gj = Math.floor(v * CELLS_Y);
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w;
      const gi = Math.floor(u * CELLS_X);
      let d1 = Infinity;
      let d2 = Infinity;
      let owner = 0;
      // 3x3 around the pixel's own cell, not all `CELLS_X * CELLS_Y`. At 256^2 that is the
      // difference between ~6 ms and ~25 ms, and the bake happens the first time a shielded
      // actor appears — i.e. mid-fight, where 25 ms is a dropped frame. Exact for this lattice:
      // the only points that can be nearest are the two in-row and the four half-offset ones in
      // the rows above and below, and all six are inside the 3x3.
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const k = cellAt(gi + di, gj + dj);
          // Wrapped to the unit torus in BOTH axes — this, and only this, is what makes the
          // tile seamless. Rounding the delta to the nearest integer picks the shorter way
          // round, so a cell near u=0.98 is a neighbour of a pixel at u=0.02.
          let dx = pts[k]!.x - u;
          let dy = pts[k]!.y - v;
          dx -= Math.round(dx);
          dy -= Math.round(dy);
          const d = Math.hypot(dx, dy);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            owner = k;
          } else if (d < d2) {
            d2 = d;
          }
        }
      }
      // `d2 - d1` is 0 exactly on a cell boundary and grows inward — the standard Voronoi edge
      // distance, and for this lattice the boundary is a hexagon's six sides. Squared so the
      // line has a soft shoulder rather than a hard step: that shoulder IS the anti-aliasing,
      // and the limb is where the shader's own UV compression needs it most.
      const line = 1 - Math.min(1, (d2 - d1) / LINE_W);
      const dome = Math.max(0, 1 - d1 / DOME_R);
      const field = LINE_AMP * line * line + DOME_AMP * dome * dome;
      raw[py * w + px] = field;
      sum += field;
      rgba[(py * w + px) * 4 + 1] = Math.round(pts[owner]!.rank * 255);
    }
  }
  // Pass 2: centre on the tile's own mean and normalize the positive peak to +1, then encode
  // into 0..1 around mid-grey. `peak` is measured after centring rather than before, so the
  // contract holds whatever LINE_AMP / DOME_AMP are set to.
  const mean = sum / (w * h);
  let peak = 1e-6;
  for (let i = 0; i < raw.length; i++) peak = Math.max(peak, Math.abs(raw[i]! - mean));
  for (let i = 0; i < raw.length; i++) {
    const p = (raw[i]! - mean) / peak;
    rgba[i * 4] = Math.round(Math.max(0, Math.min(1, 0.5 + 0.5 * p)) * 255);
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = 255;
  }
}

/** The shield membrane tile, baked once per process. */
export function shieldScaleTexture(): Texture {
  return bakedField('shield-scales', TILE, TILE, paintScaleTile, { mipmap: true });
}

/**
 * Grid dimensions and derived shape, exported so the tests can measure the tile against the
 * numbers that generated it rather than against a second copy of them.
 *
 * `hexRatio` is rowSpacing / colSpacing; a triangular lattice's Voronoi cells are REGULAR
 * hexagons when it equals sqrt(3)/2, so this is the one number that says how close the pattern
 * is to actual hexagons — the property the 2026-08-27 report was about.
 */
export const SCALE_TILE_SHAPE = {
  size: TILE,
  cellsX: CELLS_X,
  cellsY: CELLS_Y,
  hexRatio: CELLS_X / CELLS_Y,
  lineWidth: LINE_W,
} as const;
