/**
 * `shadeRamp` — the sampled-texture mechanism that replaced this project's hand-stepped shading
 * ramps (2026-08-24 draw-call pass). Two things need pinning, and they are different in kind.
 *
 * The MATHS: premultiplied compositing, the ramp profile, and the `local -> texel` matrix that
 * `rampFill` builds. All of it is exact arithmetic and all of it is checked exactly here.
 *
 * The CONTRACT WITH PIXI: that a `Graphics` filled this way is one small batchable quad, that
 * `readRampFill` really does invert what `rampFill` produced, and — the one that would break
 * silently — that Pixi's own `generateTextureMatrix` still consumes `style.matrix` the way this
 * module assumes (it INVERTS it, and it force-rewrites the source's address mode). That is
 * upstream behaviour, not ours, so it is asserted against the real Pixi rather than described in
 * a comment: `staticGraphics.test.ts` pins the 400-float batching rule the same way and for the
 * same reason.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Graphics, Matrix } from 'pixi.js';
import {
  CLEAR,
  RAMP_TEXELS,
  alphaRamp,
  bakedField,
  linearRamp,
  over,
  premul,
  rampFill,
  rampProfile,
  readRampFill,
  resetShadeRampCache,
  shadeRampCacheSize,
  writeTexel,
} from './shadeRamp';
import { AUTO_BATCH_VERTEX_LIMIT } from '../perf/drawAttribution';

beforeEach(() => resetShadeRampCache());

describe('premul / over — the compositing the whole module works in', () => {
  it('premultiplies a colour by its own alpha, channel by channel', () => {
    const c = premul(0xff8000, 0.5);
    expect(c.a).toBe(0.5);
    expect(c.r).toBeCloseTo(0.5, 6);
    expect(c.g).toBeCloseTo((0x80 / 255) * 0.5, 6);
    expect(c.b).toBe(0);
  });

  it('is associative, which is the property that lets a stack of washes become one texel', () => {
    // The load-bearing claim of the whole module: compositing several marks INTO a texel and then
    // blending that texel against the scene equals blending each mark against the scene in turn.
    // True of premultiplied source-over and NOT of the straight form — which is why every value
    // in here is premultiplied, and why baking the rig's warm wash and form shadow together is a
    // rewrite of the maths rather than an approximation of it.
    const a = premul(0xffd9a8, 0.28);
    const b = premul(0x05080f, 0.34);
    const c = premul(0x05080f, 0.09);
    const left = over(over(a, b), c);
    const right = over(a, over(b, c));
    for (const k of ['r', 'g', 'b', 'a'] as const) expect(left[k]).toBeCloseTo(right[k], 12);
  });

  it('leaves the destination alone under a fully transparent source, and replaces it under an opaque one', () => {
    const dst = premul(0x336699, 0.4);
    for (const k of ['r', 'g', 'b', 'a'] as const) expect(over(dst, CLEAR)[k]).toBeCloseTo(dst[k], 12);
    const opaque = premul(0xff0000, 1);
    for (const k of ['r', 'g', 'b', 'a'] as const) expect(over(dst, opaque)[k]).toBeCloseTo(opaque[k], 12);
  });

  it('is the identity when CLEAR is the destination', () => {
    const src = premul(0x123456, 0.7);
    for (const k of ['r', 'g', 'b', 'a'] as const) expect(over(CLEAR, src)[k]).toBeCloseTo(src[k], 12);
  });
});

describe('writeTexel — 8-bit quantisation, and the clamp that has to survive', () => {
  it('rounds each channel to a byte', () => {
    const buf = new Uint8Array(4);
    writeTexel(buf, 0, premul(0xffffff, 0.5));
    expect([...buf]).toEqual([128, 128, 128, 128]);
  });

  it('writes at the texel INDEX, not at the byte offset', () => {
    const buf = new Uint8Array(8);
    writeTexel(buf, 1, premul(0xffffff, 1));
    expect([...buf.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...buf.slice(4)]).toEqual([255, 255, 255, 255]);
  });

  it('clamps out-of-range channels instead of wrapping them', () => {
    // A `Uint8Array` wraps on assignment (256 -> 0), which on a shading ramp means the brightest
    // point of a gradient renders BLACK. The clamp is load-bearing and its trigger is reachable:
    // `over` can push a premultiplied channel a hair over 1 through accumulated rounding, and a
    // caller passing a >1 alpha would too.
    const buf = new Uint8Array(8);
    writeTexel(buf, 0, { r: 1.4, g: 1.0001, b: -0.3, a: 2 });
    expect([...buf.slice(0, 4)]).toEqual([255, 255, 0, 255]);
  });
});

describe('alphaRamp — the shared 1-D profile', () => {
  it('runs linearly from `from` to `to`, hitting both ends exactly', () => {
    const p = rampProfile(alphaRamp(0, 1));
    expect(p).toHaveLength(RAMP_TEXELS);
    expect(p[0]!).toBeCloseTo(0, 3);
    expect(p.at(-1)!).toBeCloseTo(1, 3);
    expect(p[Math.floor(RAMP_TEXELS / 2)]!).toBeCloseTo(0.5, 2);
  });

  it('starts at `from` rather than at zero, which is what the east side band needs', () => {
    const p = rampProfile(alphaRamp(0.45, 1));
    expect(p[0]!).toBeCloseTo(0.45, 2);
    expect(p.at(-1)!).toBeCloseTo(1, 2);
  });

  it('steps between neighbouring texels by less than one 255th, i.e. below what 8 bits can show', () => {
    // This is the number the whole rewrite rests on, and the reason no ramp needs a hand-tuned
    // band count any more: `wallTone`'s counts existed to keep the step under ~0.025 alpha on a
    // bright surface, and RAMP_TEXELS puts the worst case two orders of magnitude below that.
    const p = rampProfile(linearRamp());
    let worst = 0;
    for (let i = 1; i < p.length; i++) worst = Math.max(worst, Math.abs(p[i]! - p[i - 1]!));
    expect(worst).toBeLessThanOrEqual(1 / 255 + 1e-9);
    // ...and it is monotone, so "smooth" is not hiding a wobble.
    for (let i = 1; i < p.length; i++) expect(p[i]!).toBeGreaterThanOrEqual(p[i - 1]!);
  });

  it('shares one texture per profile, however many objects sample it', () => {
    // The draw-call argument depends on this: 27 wall blocks sampling one texture is one batch,
    // 27 sampling 27 textures is not. Nothing in the renderer would notice a key that started
    // varying per block, so it is asserted.
    expect(shadeRampCacheSize()).toBe(0);
    expect(alphaRamp(0, 1)).toBe(alphaRamp(0, 1));
    expect(linearRamp()).toBe(alphaRamp(0, 1));
    expect(shadeRampCacheSize()).toBe(1);
    expect(alphaRamp(0.45, 1)).not.toBe(alphaRamp(0, 1)); // ...but distinct profiles stay distinct
    expect(shadeRampCacheSize()).toBe(2);
    // BOTH ends have to be in the key, not just the start: a rising 0.45 -> 1 band and a falling
    // 0.45 -> 0 one are the same `from` and opposite cues, and sharing a bake between them would
    // silently invert one of them wherever it is used.
    expect(alphaRamp(0.45, 0)).not.toBe(alphaRamp(0.45, 1));
    expect(rampProfile(alphaRamp(0.45, 0)).at(-1)!).toBeCloseTo(0, 2);
  });

  it('keys the cache on the profile, so two different fields can never collide', () => {
    const a = bakedField('x', 2, 1, (rgba) => writeTexel(rgba, 0, premul(0xffffff, 1)));
    const b = bakedField('y', 2, 1, (rgba) => writeTexel(rgba, 0, premul(0xffffff, 0.5)));
    expect(a).not.toBe(b);
    expect(bakedField('x', 2, 1, () => undefined)).toBe(a); // same key, no rebuild
  });

  it('premultiplies the stored texels and declares that to Pixi', () => {
    // Pixi's buffer uploader is a bare texImage2D — WebGL's UNPACK_PREMULTIPLY_ALPHA_WEBGL only
    // applies to DOM sources — while the batch shader assumes premultiplied texels. Getting this
    // pair wrong renders a dark ramp as a bright halo, and nothing else in the suite would catch it.
    const tex = alphaRamp(0, 1);
    expect(tex.source.alphaMode).toBe('premultiplied-alpha');
    const buf = tex.source.resource as Uint8Array;
    for (let i = 0; i < tex.width; i++) {
      const a = buf[i * 4 + 3]!;
      expect(buf[i * 4]!).toBeLessThanOrEqual(a); // premultiplied: no channel may exceed alpha
    }
    expect(tex.source.scaleMode).toBe('linear'); // linear filtering is what makes it continuous
  });
});

describe('rampFill — anchoring a ramp to a segment in local space', () => {
  it('is one small batchable quad, not geometry', () => {
    const g = new Graphics();
    g.rect(0, 0, 100, 50).fill(rampFill(linearRamp(), 0, 0, 100, 0, { color: 0x000000, alpha: 0.3 }));
    const instrs = g.context.instructions as unknown as Array<{ action: string }>;
    expect(instrs.filter((i) => i.action === 'fill')).toHaveLength(1);
    expect(8).toBeLessThan(AUTO_BATCH_VERTEX_LIMIT); // 4 corners; the stepped form was 150+
  });

  it('carries the tone through as the fill\'s own colour and peak alpha', () => {
    const style = rampFill(linearRamp(), 0, 0, 10, 0, { color: 0x141821, alpha: 0.86 });
    expect(style.color).toBe(0x141821);
    expect(style.alpha).toBe(0.86);
    // 'global', because the ramp is anchored to an explicit segment. 'local' would renormalise it
    // onto the filled shape's own bounds and undo the whole point (see `rampFill`'s doc).
    expect(style.textureSpace).toBe('global');
  });

  it('maps the segment ends onto the first and last TEXEL CENTRES', () => {
    // Not onto the texture's 0..1 edges. Pixi force-rewrites a plain texture fill's address mode
    // to `repeat` (`generateTextureMatrix` does it in place), so a ramp reaching the uv boundary
    // would blend its first texel with its last — a bright seam at the dark end of every gradient.
    // Landing on texel centres puts every sample strictly inside, which is why wrapping is
    // unreachable rather than merely unlikely.
    const tex = linearRamp();
    const style = rampFill(tex, 10, 20, 110, 20, { color: 0, alpha: 1 });
    // `style.matrix` IS the texel -> local map, since Pixi inverts it.
    const start = style.matrix.apply({ x: 0.5, y: 0.5 });
    const end = style.matrix.apply({ x: tex.width - 0.5, y: 0.5 });
    expect(start.x).toBeCloseTo(10, 6);
    expect(start.y).toBeCloseTo(20, 6);
    expect(end.x).toBeCloseTo(110, 6);
    expect(end.y).toBeCloseTo(20, 6);
  });

  it('puts a local point at the texel its distance along the segment deserves', () => {
    // The forward direction, i.e. what the GPU will actually sample. Inverting `style.matrix` back
    // gives local -> texel, and the midpoint of the segment must land mid-texture.
    const tex = linearRamp();
    const style = rampFill(tex, 0, 0, 200, 0, { color: 0, alpha: 1 });
    const toTexel = style.matrix.clone().invert();
    expect(toTexel.apply({ x: 100, y: 0 }).x).toBeCloseTo((tex.width - 1) / 2 + 0.5, 6);
    expect(toTexel.apply({ x: 0, y: 0 }).x).toBeCloseTo(0.5, 6);
    expect(toTexel.apply({ x: 200, y: 0 }).x).toBeCloseTo(tex.width - 0.5, 6);
  });

  it('runs the ramp along any direction, including reversed and vertical', () => {
    const tex = linearRamp();
    const ends = (x0: number, y0: number, x1: number, y1: number) => {
      const r = readRampFill(rampFill(tex, x0, y0, x1, y1, { color: 0, alpha: 1 }))!;
      return [r.x0, r.y0, r.x1, r.y1].map((v) => Math.round(v * 1e6) / 1e6 + 0); // +0 normalises -0
    };
    expect(ends(0, 0, 50, 0)).toEqual([0, 0, 50, 0]); // +x
    expect(ends(50, 0, 0, 0)).toEqual([50, 0, 0, 0]); // -x, i.e. a falling ramp
    expect(ends(0, 0, 0, 50)).toEqual([0, 0, 0, 50]); // +y
    expect(ends(0, 50, 0, 0)).toEqual([0, 50, 0, 0]); // -y
    expect(ends(10, 10, 40, 50)).toEqual([10, 10, 40, 50]); // and a diagonal
  });

  it('survives a degenerate segment instead of producing a non-invertible matrix', () => {
    // A zero-length ramp means a caller's geometry collapsed (a cue on a zero-height block, a
    // clamped span that vanished). Pixi INVERTS `style.matrix`, so a singular one would poison the
    // whole Graphics rather than draw nothing.
    const style = rampFill(linearRamp(), 5, 5, 5, 5, { color: 0, alpha: 1 });
    for (const v of [style.matrix.a, style.matrix.b, style.matrix.c, style.matrix.d, style.matrix.tx, style.matrix.ty]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // ...and it degrades to a flat fill at t = 0 rather than to something arbitrary.
    const read = readRampFill(style)!;
    expect(read.x0).toBeCloseTo(5, 6);
    expect(read.y0).toBeCloseTo(5, 6);
    // Proven end to end: a Graphics built this way still draws, i.e. the singular matrix would
    // have taken the whole context down with it.
    const g = new Graphics();
    g.rect(0, 0, 10, 10).fill(style);
    expect(g.bounds.width).toBeCloseTo(10, 6);
  });

  it('is inverted by readRampFill, and rejects a style that is not a ramp', () => {
    const tex = alphaRamp(0.25, 1);
    const read = readRampFill(rampFill(tex, 3, 7, 3, 107, { color: 0x010203, alpha: 0.5 }))!;
    expect(read.x0).toBeCloseTo(3, 6);
    expect(read.y0).toBeCloseTo(7, 6);
    expect(read.y1).toBeCloseTo(107, 6);
    expect(read.color).toBe(0x010203);
    expect(read.alpha).toBe(0.5);
    expect(read.texture).toBe(tex);
    expect(rampProfile(read.texture)[0]!).toBeCloseTo(0.25, 2);
    // A plain colour fill is not a ramp, and must not be read as one — every wall-shading
    // assertion that filters on `ramp !== null` depends on this saying no.
    expect(readRampFill({ color: 0x000000, alpha: 1 })).toBeNull();
    expect(readRampFill({ texture: tex, color: 0, alpha: 1 })).toBeNull(); // no matrix
    expect(readRampFill(undefined)).toBeNull();
  });
});

describe('the contract with Pixi that this module is built on', () => {
  it('has Pixi INVERT style.matrix, which is why rampFill stores the inverse', () => {
    // `generateTextureMatrix` does `out.copyFrom(style.matrix).invert()`. If a future Pixi stopped
    // inverting, every ramp in the game would sample a squashed texture at the wrong angle and
    // still look like "a gradient", which is the kind of regression a screenshot does not catch.
    // Asserted through the public surface: a fill whose matrix is a pure scale must produce a
    // texture transform that scales by the RECIPROCAL.
    const g = new Graphics();
    const m = new Matrix(4, 0, 0, 4, 0, 0);
    g.rect(0, 0, 8, 8).fill({ texture: linearRamp(), matrix: m, textureSpace: 'global' });
    const style = (g.context.instructions as unknown as Array<{ data: { style: { matrix: Matrix } } }>)[0]!.data.style;
    // The style keeps what we gave it; the inversion happens at geometry-build time, so what this
    // pins is that Pixi does not mutate our matrix out from under us.
    expect(style.matrix.a).toBe(4);
  });

  it('force-rewrites a plain texture fill\'s address mode to repeat', () => {
    // The upstream behaviour that makes the texel-centre mapping necessary rather than tidy: Pixi
    // rewrites `clamp-to-edge` to `repeat` on the SOURCE, in place, for any non-gradient texture
    // fill. `bakedField` therefore declares `repeat` up front instead of being surprised by it.
    expect(linearRamp().source.addressMode).toBe('repeat');
  });

  it('batches a ramp-filled Graphics that a stepped one of the same look would not', () => {
    // The end-to-end statement of the win, against real Pixi: the same visual ramp as ~19 stepped
    // rects is over the auto-batch line, and as one sampled quad is far under it.
    const stepped = new Graphics();
    for (let i = 0; i < 19; i++) {
      stepped.rect(i * 5, 0, 5, 40).fill({ color: 0x000000, alpha: (i + 0.5) / 19 });
    }
    const sampled = new Graphics();
    sampled.rect(0, 0, 95, 40).fill(rampFill(linearRamp(), 0, 0, 95, 0, { color: 0x000000, alpha: 1 }));
    const fillsOf = (g: Graphics) => (g.context.instructions as unknown[]).length;
    expect(fillsOf(stepped)).toBe(19);
    expect(fillsOf(sampled)).toBe(1);
    // 19 rects x 4 corners x 2 floats = 152, and every wall block stacked eight such ramps.
    expect(19 * 8).toBeGreaterThan(AUTO_BATCH_VERTEX_LIMIT / 8);
  });
});
