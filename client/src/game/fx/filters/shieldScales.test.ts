/**
 * The shield membrane tile, measured from its bytes.
 *
 * This is the half of the membrane that `shieldShellModel.test.ts` deliberately cannot see: that
 * file interprets the shader, and the shader's view of the tile is one `texture()` call it treats
 * as a parameter. Everything the tile itself has to be true about — seamless, in range, actually
 * cellular — is a property of this buffer, so it is measured here.
 *
 * Two of these exist because the tile is GENERATED. Authored art gets looked at; a generator gets
 * a wrong constant and produces something plausible-looking that is subtly not tiling, which is
 * exactly the class of defect nobody catches by eye on a shell that is also moving, glowing and
 * 30% opaque.
 */
import { describe, it, expect } from 'vitest';
import { paintScaleTile, scaleCells, shieldScaleTexture, SCALE_TILE_SHAPE } from './shieldScales';

const { size: N, cellsX, cellsY, aspect } = SCALE_TILE_SHAPE;

/** Mean of a byte channel, 0..1. */
const mean = (a: Uint8Array): number => a.reduce((s, v) => s + v, 0) / a.length / 255;

/** One baked tile, as `[r, g]` per texel. */
function bake(w: number = N, h: number = N): { r: Uint8Array; g: Uint8Array; w: number; h: number } {
  const rgba = new Uint8Array(w * h * 4);
  paintScaleTile(rgba, w, h);
  const r = new Uint8Array(w * h);
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    r[i] = rgba[i * 4]!;
    g[i] = rgba[i * 4 + 1]!;
  }
  return { r, g, w, h };
}

describe('the shield membrane tile', () => {
  it('is deterministic — the same bytes on every device and every run', () => {
    // The tile is baked at runtime rather than shipped, so "the same on every device" is a
    // property of the generator, not of a file. A `Math.random` anywhere in it would make two
    // clients in the same PvP match wear visibly different shields.
    const a = bake(64, 64);
    const b = bake(64, 64);
    expect(Array.from(a.r)).toEqual(Array.from(b.r));
    expect(Array.from(a.g)).toEqual(Array.from(b.g));
  });

  it('tiles seamlessly — the wrap seam is no sharper than any interior column', () => {
    // The whole reason the generator wraps its distance metric to a torus. A tile that fails
    // this shows a hard vertical and horizontal line on the shell, which on a curved, moving,
    // half-transparent surface reads as "some artifact" rather than as "the tile does not wrap".
    const { r, w, h } = bake();
    const colStep = (a: number, b: number): number => {
      let worst = 0;
      for (let y = 0; y < h; y++) worst = Math.max(worst, Math.abs(r[y * w + a]! - r[y * w + b]!));
      return worst;
    };
    const rowStep = (a: number, b: number): number => {
      let worst = 0;
      for (let x = 0; x < w; x++) worst = Math.max(worst, Math.abs(r[a * w + x]! - r[b * w + x]!));
      return worst;
    };
    // The sharpest step between any two neighbouring interior columns — the tile is cellular, so
    // this is not zero, and a bound pulled out of the air would be meaningless. The seam has to
    // sit inside the population it belongs to.
    const interiorCols = Math.max(...Array.from({ length: w - 2 }, (_, i) => colStep(i, i + 1)));
    const interiorRows = Math.max(...Array.from({ length: h - 2 }, (_, i) => rowStep(i, i + 1)));
    expect(colStep(w - 1, 0)).toBeLessThanOrEqual(interiorCols);
    expect(rowStep(h - 1, 0)).toBeLessThanOrEqual(interiorRows);
  });

  it('uses its range: dark recesses, bright ridges, and something in between', () => {
    const { r } = bake();
    const min = Math.min(...r);
    const max = Math.max(...r);
    expect(min).toBeLessThan(60); // real recesses, not a grey plate
    expect(max).toBeGreaterThan(200); // real ridges
    const mid = Array.from(r).filter((v) => v > 80 && v < 180).length / r.length;
    expect(mid).toBeGreaterThan(0.15); // ...and a gradient between them, not a two-tone mask
    // Mostly RECESS. The shader multiplies the shell by this, so a tile whose average is high
    // reads as a uniform brightening with some texture in it rather than as scales on a surface.
    // Squaring the ridge term is what buys the soft shoulder; without it the mean lands at 0.35.
    expect(mean(r)).toBeLessThan(0.32);
  });

  it('has exactly the declared number of cells, none of them degenerate', () => {
    const { g } = bake();
    const counts = new Map<number, number>();
    for (const v of g) counts.set(v, (counts.get(v) ?? 0) + 1);
    expect(counts.size).toBe(cellsX * cellsY);
    // Jitter is bounded, so no cell should collapse to a sliver or swallow its neighbours. An
    // even split would be 1/n each; this allows a 3x spread either way.
    const even = 1 / (cellsX * cellsY);
    for (const share of [...counts.values()].map((c) => c / g.length)) {
      expect(share).toBeGreaterThan(even / 3);
      expect(share).toBeLessThan(even * 3);
    }
  });

  it('makes cells wider than tall — scales, not a honeycomb', () => {
    // `SCALE_ASPECT` squashes the metric vertically, which stretches the cells horizontally. This
    // measures the resulting shape rather than re-reading the constant: a sign error on it would
    // produce tall cells and still "use" the number.
    const { g, w, h } = bake();
    const box = new Map<number, { x0: number; x1: number; y0: number; y1: number }>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const id = g[y * w + x]!;
        const b = box.get(id) ?? { x0: x, x1: x, y0: y, y1: y };
        box.set(id, { x0: Math.min(b.x0, x), x1: Math.max(b.x1, x), y0: Math.min(b.y0, y), y1: Math.max(b.y1, y) });
      }
    }
    // Cells that touch the wrap seam have a bounding box spanning the whole tile, which measures
    // nothing; only the interior ones carry the shape.
    const interior = [...box.values()].filter((b) => b.x0 > 0 && b.x1 < w - 1 && b.y0 > 0 && b.y1 < h - 1);
    expect(interior.length).toBeGreaterThan(4);
    const ratios = interior.map((b) => (b.x1 - b.x0 + 1) / (b.y1 - b.y0 + 1));
    const median = ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)]!;
    expect(median).toBeGreaterThan(1);
    expect(aspect).toBeGreaterThan(1); // ...and it is the declared squash doing it
  });

  it('puts its ridges ON the cell boundaries', () => {
    // The field's bright pixels must be the Voronoi edges. A generator that computed `d1` but not
    // `d2` (or subtracted them the wrong way round) still produces a perfectly plausible cellular
    // texture — of blobs with dark edges instead of ridges — and nothing else in this file
    // notices.
    const { r, g, w, h } = bake();
    const onBoundary: number[] = [];
    const interiorPx: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const id = g[y * w + x]!;
        const edge = g[y * w + x - 1] !== id || g[y * w + x + 1] !== id
          || g[(y - 1) * w + x] !== id || g[(y + 1) * w + x] !== id;
        (edge ? onBoundary : interiorPx).push(r[y * w + x]!);
      }
    }
    const avg = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
    expect(onBoundary.length).toBeGreaterThan(100);
    expect(avg(onBoundary)).toBeGreaterThan(avg(interiorPx) * 1.5);
  });

  it('the 3x3 neighbourhood search finds the same owner brute force does', () => {
    // The optimisation that keeps the bake off the frame budget (~6 ms instead of ~25 ms, and it
    // happens the first time a shielded actor appears — i.e. mid-fight). It is only correct
    // because the jitter is bounded; this is the assertion that says so, against an oracle that
    // checks every cell.
    const { g, w, h } = bake(64, 64);
    const pts = scaleCells();
    let checked = 0;
    for (let y = 0; y < h; y += 3) {
      for (let x = 0; x < w; x += 3) {
        const u = (x + 0.5) / w;
        const v = (y + 0.5) / h;
        let best = Infinity;
        let owner = -1;
        for (let k = 0; k < pts.length; k++) {
          let dx = pts[k]!.x - u;
          let dy = pts[k]!.y - v;
          dx -= Math.round(dx);
          dy -= Math.round(dy);
          const d = Math.hypot(dx, dy * aspect);
          if (d < best) {
            best = d;
            owner = k;
          }
        }
        expect(g[y * w + x]).toBe(Math.round(pts[owner]!.rank * 255));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it('keeps every cell constant distinct, so the damage dropout is per-scale', () => {
    // The shader reads the GREEN channel as this cell's place in the extinction order and
    // compares it against the shield ratio. Two cells sharing a constant go out together — and
    // with independent random draws that is not a rare edge case: 35 cells in a 256-level
    // channel collide about nine times out of ten. This is what sent the generator to a shuffled
    // rank (see `Cell.rank`), and it is the assertion that stops it drifting back.
    const ids = scaleCells().map((c) => Math.round(c.rank * 255));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('extinguishes an even fraction of the membrane as the pool drains, not lumps', () => {
    // Ranks are evenly spaced, so "how much of the shield is still lit" is close to linear in
    // the shield ratio. Random constants clump, and a shield that loses half its scales between
    // 60% and 55% reads as a glitch rather than as damage.
    const ranks = scaleCells().map((c) => c.rank).sort((a, b) => a - b);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]! - ranks[i - 1]!).toBeCloseTo(1 / ranks.length, 9);
    }
  });

  it('scatters that order across the tile instead of sweeping it', () => {
    // A shield that goes out row by row reads as a wipe. Measured as: neighbouring cells in the
    // grid are not neighbouring in the extinction order.
    const cells = scaleCells();
    const adjacentInOrder = cells.filter((c, i) => {
      const right = i % cellsX === cellsX - 1 ? null : cells[i + 1];
      return right ? Math.abs(right.rank - c.rank) < 1.5 / cells.length : false;
    }).length;
    expect(adjacentInOrder).toBeLessThan(cells.length / 4);
  });

  it('is a power of two, or WebGL1 silently drops both mipmaps and REPEAT', () => {
    // design/04's WeChat target is WebGL1. On an NPOT texture it does not fail — it quietly
    // disables mipmapping and forces CLAMP_TO_EDGE, which turns the membrane into a moire ring
    // with a visible seam. Nothing on that device would report it, and the simulator (WebGL2)
    // would look fine, which is the same trap that hid two other WeChat-only bugs.
    expect(Math.log2(N) % 1).toBe(0);
  });

  it('bakes ONE texture for the whole process, however many shielded actors there are', () => {
    // Eight shielded seats in a PvP match must not mean eight bakes and eight 256KB textures.
    // The cache is in `bakedField`; this is the assertion that the shield actually uses it.
    expect(shieldScaleTexture()).toBe(shieldScaleTexture());
    expect(shieldScaleTexture().source.autoGenerateMipmaps).toBe(true);
  });

  it('scales with the requested tile size rather than baking in one resolution', () => {
    // The cell grid is in unit coordinates, so a smaller tile is the same pattern at lower
    // resolution — not a crop, and not a different number of cells.
    const small = bake(64, 64);
    expect(new Set(small.g).size).toBe(cellsX * cellsY);
  });
});
