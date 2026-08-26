// Split out of skinFx.ts (2026-08-26, shell rewrite): the ONE texture the shield shader
// samples — a seamless irregular-scale tile — and nothing else. A sibling of `shieldFx.ts`
// (which the shader itself moved into later the same day), imported by it, never the other
// way round.
//
// Why this is generated rather than authored art (the question the 2026-08-26 session asked
// directly — *"或许那张鳞片细节图还是得出？"*). The tile has exactly two hard requirements:
// it must tile seamlessly on both axes, and its grey range must be known, because the shader
// multiplies by it. Those are the two things an image model is worst at and a 40-line Voronoi
// is exact at. Three further reasons, all specific to this repo:
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

/** Cells across and down. Fewer down than across, with `SCALE_ASPECT` below, is what makes the
 *  cells read as overlapping scales rather than as a honeycomb. */
const CELLS_X = 7;
const CELLS_Y = 5;

/** Vertical squash applied to the distance metric — >1 makes each cell wider than it is tall. */
const SCALE_ASPECT = 1.55;

/** How close two cell centres have to be, in tile units, before the boundary between them is
 *  fully lit. Wider = softer ridges; this is the anti-aliasing budget at the limb, where the
 *  shader's UV compression is at its worst. */
const RIDGE_WIDTH = 0.055;

/** Radius of each cell's own dome, in tile units. */
const DOME_R = 0.13;

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

/** Jittered grid — a pure grid would read as a weave, pure noise as static. Jitter stays inside
 *  +/-0.28 of a cell, which is what makes the 3x3 neighbourhood search in `paintScaleTile`
 *  exact: no point can be nearer to a pixel than one two cells away. */
export function scaleCells(): Cell[] {
  const rnd = lcg(0x5eed);
  const out: Cell[] = [];
  for (let j = 0; j < CELLS_Y; j++) {
    for (let i = 0; i < CELLS_X; i++) {
      out.push({
        x: (i + 0.22 + 0.56 * rnd()) / CELLS_X,
        y: (j + 0.22 + 0.56 * rnd()) / CELLS_Y,
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
 * Fill one RGBA tile: `r` = the scale field (ridges + domes), `g` = the owning cell's random
 * constant, `b` unused, `a` = 1.
 *
 * Exported for the tests, which measure the buffer directly — a texture has no readback path
 * under vitest, and the properties worth pinning (seamlessness, range, cell count) are
 * properties of these bytes.
 */
export function paintScaleTile(rgba: Uint8Array, w: number, h: number): void {
  const pts = scaleCells();
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
      // actor appears — i.e. mid-fight, where 25 ms is a dropped frame.
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
          const d = Math.hypot(dx, dy * SCALE_ASPECT);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            owner = k;
          } else if (d < d2) {
            d2 = d;
          }
        }
      }
      // `d2 - d1` is 0 exactly on a boundary and grows inward — the standard Voronoi edge
      // distance. Squared so the ridge has a soft shoulder rather than a linear ramp.
      const ridge = 1 - Math.min(1, (d2 - d1) / RIDGE_WIDTH);
      const dome = Math.max(0, 1 - d1 / DOME_R);
      const field = 0.1 + 0.62 * ridge * ridge + 0.3 * dome * dome;
      const o = (py * w + px) * 4;
      const q = Math.round(Math.max(0, Math.min(1, field)) * 255);
      rgba[o] = q;
      rgba[o + 1] = Math.round(pts[owner]!.rank * 255);
      rgba[o + 2] = 0;
      rgba[o + 3] = 255;
    }
  }
}

/** The shield membrane tile, baked once per process. */
export function shieldScaleTexture(): Texture {
  return bakedField('shield-scales', TILE, TILE, paintScaleTile, { mipmap: true });
}

/** Grid dimensions and jitter bound, exported so the tests can measure the tile against the
 *  numbers that generated it rather than against a second copy of them. */
export const SCALE_TILE_SHAPE = { size: TILE, cellsX: CELLS_X, cellsY: CELLS_Y, aspect: SCALE_ASPECT } as const;
