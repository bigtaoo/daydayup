// New 2026-08-28: the ground BEYOND the wall — the surface the void's far side is made of.
// Free functions over a colour, Pixi-free apart from the bake (CLAUDE.md form (1)); `Terrain.ts`
// owns the plane that tiles this and the fog over it.
//
// **WHY THIS IS GENERATED AND NOT A PNG.** Two reasons, and the second is the binding one:
//
//  1. It is not stone. Every shipped `biome/*.png` is masonry — a floor swatch or a wall
//     elevation — and the whole point of the far side is that it must NOT read as more floor
//     (a walkable-looking void is worse than a black one). Re-tinting `floor_*.png` down would
//     have given the right value and exactly the wrong texture: the same mortar grid the player
//     has learned means "you can stand here".
//  2. **The WeChat main package is at 3.41 MB of a 4.00 MB cap** (design/04). A new biome-sized
//     PNG is a real cost against that budget, and this surface is coarse noise with no authored
//     detail in it — the one shape of art where generating is strictly better than shipping.
//
// It goes through `shadeRamp.bakedField`, not the `capLight.ts` canvas path. `bakedField` fills a
// `BufferImageSource` directly, so there is no `DOMAdapter`, no 2D context, and therefore no
// canvas-free fallback to maintain: it produces identical bytes under plain vitest, in a browser,
// and on the wx runtime. `capLight` needs a canvas because it reads an existing texture's pixels
// back; nothing here reads anything back.
import type { Texture } from 'pixi.js';
import { bakedField } from '../../render/shadeRamp';

/** Tile size. POT on purpose — `bakedField`'s mipmap note: WebGL1 (WeChat) silently disables
 *  mipmapping on an NPOT texture, and this plane is minified hard at low zoom. */
export const TERRAIN_TILE_PX = 128;

/** Lattice cells across the tile, coarsest to finest. Each must DIVIDE `TERRAIN_TILE_PX` or the
 *  noise stops tiling seamlessly — `terrainSwatch.test.ts` pins that.
 *
 *  THREE octaves and a 128 px tile, not two and 64, and that is a fix from a real frame rather
 *  than a preference. The first version tiled a 64 px two-octave swatch and the repeat was plainly
 *  legible in the void: the dominant term was the coarsest lattice, whose period IS the tile, so
 *  the eye locked onto a regular grid of identical blobs and read "texture bug" instead of
 *  "ground". Doubling the tile halves that frequency on screen, and the third octave puts detail
 *  at 4 px — below the scale the repeat lives at — so there is something for the eye to hold that
 *  is not the period. */
const OCTAVES: ReadonlyArray<{ cells: number; weight: number }> = [
  { cells: 4, weight: 0.5 },
  { cells: 16, weight: 0.3 },
  { cells: 32, weight: 0.2 },
];

/** Peak-to-peak value swing as a fraction of the base colour. Enough that the surface has
 *  legible grain at play zoom, small enough that no texel of it approaches the lit floor —
 *  the bound `Terrain.ts` argues and `terrainSwatch.test.ts` measures. */
export const TERRAIN_CONTRAST = 0.42;

/** Deterministic 2-D integer hash on a WRAPPED lattice, so the tile's east edge samples the same
 *  lattice points as its west. Uses the full 32 bits (`>>> 0`), never a low-bit slice — the engine
 *  LCG's degenerate low-order bits are a documented trap in this repo and the habit is worth
 *  keeping even where the generator is different. */
function hashCell(ix: number, iy: number, cells: number): number {
  const x = ((ix % cells) + cells) % cells;
  const y = ((iy % cells) + cells) % cells;
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep — bilinear alone leaves visible diamond seams on a lattice this coarse. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0,1) at pixel `px,py` of a `TERRAIN_TILE_PX` tile, on a `cells` lattice. */
function valueNoise(px: number, py: number, cells: number): number {
  const step = TERRAIN_TILE_PX / cells;
  const fx = px / step;
  const fy = py / step;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fade(fx - ix);
  const ty = fade(fy - iy);
  const a = hashCell(ix, iy, cells);
  const b = hashCell(ix + 1, iy, cells);
  const c = hashCell(ix, iy + 1, cells);
  const d = hashCell(ix + 1, iy + 1, cells);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}

/** The octave sum, normalised to [0,1) — the weights total 1 by construction, which
 *  `terrainSwatch.test.ts` checks rather than trusts. */
export function terrainNoiseAt(px: number, py: number): number {
  let n = 0;
  for (const o of OCTAVES) n += valueNoise(px, py, o.cells) * o.weight;
  return n;
}

/** The octave table, for the tests that check divisibility and the weight sum. */
export const TERRAIN_OCTAVES = OCTAVES;

/**
 * The far-side ground, tiled from `color`.
 *
 * Opaque, so premultiplied and straight RGBA are the same bytes here — `bakedField` hands out a
 * premultiplied buffer and this never writes an alpha below 255.
 */
export function terrainSwatch(color: number): Texture {
  return bakedField(
    `terrain:${color.toString(16)}`,
    TERRAIN_TILE_PX,
    TERRAIN_TILE_PX,
    (rgba, w, h) => {
      const br = (color >> 16) & 0xff;
      const bg = (color >> 8) & 0xff;
      const bb = color & 0xff;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // Centred on 1.0, so the mean of the plane is the base colour and the contrast
          // constant is a true peak-to-peak rather than a brightening.
          const k = 1 - TERRAIN_CONTRAST / 2 + TERRAIN_CONTRAST * terrainNoiseAt(x, y);
          const i = (y * w + x) * 4;
          rgba[i] = Math.min(255, Math.round(br * k));
          rgba[i + 1] = Math.min(255, Math.round(bg * k));
          rgba[i + 2] = Math.min(255, Math.round(bb * k));
          rgba[i + 3] = 255;
        }
      }
    },
    { mipmap: true },
  );
}
