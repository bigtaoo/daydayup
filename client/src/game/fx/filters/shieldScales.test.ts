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

const { size: N, cellsX, cellsY, hexRatio, lineWidth } = SCALE_TILE_SHAPE;

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

  it('encodes a SIGNED pattern around mid-grey, with a mean of exactly a half', () => {
    // The contract `shieldFx.ts` reads the red channel through (2026-08-27): `r = 0.5 + 0.5 * p`
    // for a zero-mean `p`. It is what lets the shader ADD the pattern to the shell instead of
    // multiplying by it — the multiplicative form put the whole membrane inside a thin annulus,
    // because the shell's interior brightness is ~0.11 and there was nothing there to scale.
    //
    // Measured to within one 8-bit step of 0.5: the mean is subtracted in the generator rather
    // than tuned into the constants, so this is exact up to quantization and a version that
    // drifted (a changed LINE_AMP, a dropped centring pass) fails immediately rather than
    // quietly re-brightening the shell.
    const { r } = bake();
    expect(mean(r)).toBeGreaterThan(0.5 - 1 / 255);
    expect(mean(r)).toBeLessThan(0.5 + 1 / 255);
  });

  it('spends its positive half on thin lines and its negative half on wide cells', () => {
    // The asymmetry that makes a grid of glowing borders rather than a checkerboard, and it is
    // not a separate tuning — it falls out of subtracting the mean of a field that is mostly
    // cell interior. So: a full-strength peak, a shallow floor, and most of the tile near the
    // floor.
    const { r } = bake();
    expect(Math.max(...r)).toBeGreaterThan(250); // the line reaches the top of the range
    expect(Math.min(...r)).toBeGreaterThan(255 * 0.35); // ...while the floor stays shallow
    expect(Math.min(...r)).toBeLessThan(255 * 0.48); // ...but is a real subtraction, not zero
    const border = Array.from(r).filter((v) => v > 255 * 0.75).length / r.length;
    expect(border).toBeGreaterThan(0.03); // enough line to see
    expect(border).toBeLessThan(0.20); // ...and not so much that the cells close up
    // A gradient between the two, not a two-tone mask: the shoulder either side of each line is
    // the only anti-aliasing the membrane gets, and the limb is where it needs it most.
    const mid = Array.from(r).filter((v) => v > 255 * 0.55 && v < 255 * 0.75).length / r.length;
    expect(mid).toBeGreaterThan(0.05);
  });

  it('makes the line the width it was asked for, in tile units', () => {
    // `LINE_W` is set from the on-screen width it produces (~4 px at gameplay zoom), so a
    // generator that halved or doubled it would still look like a hex grid in isolation and be
    // wrong in the game. Measured along a scanline: the run of bright texels crossing a border.
    const { r, w, h } = bake();
    const runs: number[] = [];
    const y = Math.floor(h / 2);
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (r[y * w + x]! > 255 * 0.6) run++;
      else if (run > 0) { runs.push(run); run = 0; }
    }
    expect(runs.length).toBeGreaterThan(2);
    const median = runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)]!;
    // The bright run is the inner part of the band, so it lands under the declared width but
    // within a factor of two of it — a 2x error either way is the thing this excludes.
    expect(median / N).toBeLessThan(lineWidth);
    expect(median / N).toBeGreaterThan(lineWidth / 2.5);
  });

  it('has exactly the declared number of cells, none of them degenerate', () => {
    const { g } = bake();
    const counts = new Map<number, number>();
    for (const v of g) counts.set(v, (counts.get(v) ?? 0) + 1);
    expect(counts.size).toBe(cellsX * cellsY);
    // The lattice is regular, so every cell should hold very nearly the same area. An even
    // split would be 1/n each; this allows a 3x spread either way, which the jittered version
    // needed and a hex lattice clears by a mile.
    const even = 1 / (cellsX * cellsY);
    for (const share of [...counts.values()].map((c) => c / g.length)) {
      expect(share).toBeGreaterThan(even / 3);
      expect(share).toBeLessThan(even * 3);
    }
  });

  it('makes REGULAR HEXAGONS — six neighbours, all about the same distance away', () => {
    // The 2026-08-27 report was *"护盾中间的6边形看不清"* — hexagons, which the previous jittered
    // grid with a squashed metric never actually produced. A hex tiling is the Voronoi diagram of
    // a triangular lattice, so the property to measure is on the LATTICE: every cell has exactly
    // six near-equidistant neighbours. That is what makes the cells hexagons; measuring the
    // painted bounding boxes instead would pass for any roundish blob.
    const cells = scaleCells();
    const near = cells.map((c) => {
      const d = cells.filter((o) => o !== c).map((o) => {
        let dx = o.x - c.x; let dy = o.y - c.y;
        dx -= Math.round(dx); dy -= Math.round(dy);
        return Math.hypot(dx, dy);
      }).sort((a, b) => a - b);
      return d;
    });
    for (const d of near) {
      // Six neighbours within 2% of each other...
      expect(d[5]! / d[0]!).toBeLessThan(1.02);
      // ...and a clear gap before the seventh, or the cell is not a hexagon.
      expect(d[6]! / d[5]!).toBeGreaterThan(1.3);
    }
    // And the lattice is regular when rowSpacing / colSpacing is sqrt(3)/2. An integer cell
    // count in each axis cannot hit that exactly; 7/8 is 1% off, which is the error this bounds.
    expect(Math.abs(hexRatio - Math.sqrt(3) / 2)).toBeLessThan(0.02);
    // The row offset alternates with `j & 1`, so an odd row count would seam at v = 0 — the one
    // failure mode the hex lattice has that the jittered grid did not.
    expect(cellsY % 2).toBe(0);
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
    // happens the first time a shielded actor appears — i.e. mid-fight). It is correct because
    // the lattice's six neighbours are all one cell away in each axis; this is the assertion
    // that says so, against an oracle that checks every cell.
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
          const d = Math.hypot(dx, dy);
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
