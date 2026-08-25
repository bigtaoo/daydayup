/**
 * `capLight` — the cap key light moved from an additive second draw into the swatch itself
 * (2026-08-24 draw-call pass).
 *
 * The whole claim this file has to defend is an EQUIVALENCE: a baked texel drawn normally must
 * land on the same byte as the swatch drawn twice with `add`. So the central test is not "does
 * `applyLitCap` multiply" but a side-by-side simulation of both composites over a range of source
 * values, including the ones that clamp. Everything else here is the plumbing around it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DOMAdapter, Texture, TextureSource } from 'pixi.js';
import { LIT_CAP_FACTORS, applyLitCap, bakeLitCap, resetLitCapCache } from './capLight';
import { CAP_BOOST_ALPHA, CAP_BOOST_TINT, CAP_TINT } from './wallTone';

afterEach(() => {
  resetLitCapCache();
  vi.unstubAllGlobals();
});

const chan = (hex: number, i: number): number => ((hex >> (16 - i * 8)) & 0xff) / 255;

describe('LIT_CAP_FACTORS — the lift the two cap layers composite to', () => {
  it('is the per-channel sum of the base tint and the additive copy', () => {
    for (let i = 0; i < 3; i++) {
      expect(LIT_CAP_FACTORS[i]!).toBeCloseTo(chan(CAP_TINT, i) + chan(CAP_BOOST_TINT, i) * CAP_BOOST_ALPHA, 12);
    }
  });

  it('is above 1 on every channel — which is why a tint cannot express it', () => {
    // Pixi tints only multiply DOWN (`wallTone.CAP_TINT`'s doc). If a future retune ever brought
    // these under 1, the whole bake could be deleted in favour of a single tinted sprite — so this
    // is the assertion that says "the file still has a reason to exist", not a tautology.
    for (const k of LIT_CAP_FACTORS) expect(k).toBeGreaterThan(1);
  });

  it('keeps the key light WARM — red lifted more than blue', () => {
    // `CAP_BOOST_TINT` is NormalLitFilter's 0xfff2e0; a bake that dropped the tint and kept only
    // the alpha would still pass every luma check above while turning the cap neutral grey.
    expect(LIT_CAP_FACTORS[0]!).toBeGreaterThan(LIT_CAP_FACTORS[1]!);
    expect(LIT_CAP_FACTORS[1]!).toBeGreaterThan(LIT_CAP_FACTORS[2]!);
  });
});

describe('applyLitCap — the transform, and its equivalence to the additive pair', () => {
  it('matches the GPU composite byte for byte across the value range, clamped ends included', () => {
    // What the shipped renderer used to do, in floats, exactly as WebGL would: draw the opaque cap
    // (dst = src * CAP_TINT), then add src * CAP_BOOST_TINT * CAP_BOOST_ALPHA, then write 8 bits.
    const additive = (v: number, i: number): number => {
      const src = v / 255;
      const composite = src * chan(CAP_TINT, i) + src * chan(CAP_BOOST_TINT, i) * CAP_BOOST_ALPHA;
      return Math.min(255, Math.round(Math.min(1, composite) * 255));
    };
    const values = [0, 1, 2, 17, 46, 60, 100, 130, 131, 132, 183, 200, 254, 255];
    const rgba = new Uint8ClampedArray(values.length * 4);
    values.forEach((v, n) => {
      rgba[n * 4] = v;
      rgba[n * 4 + 1] = v;
      rgba[n * 4 + 2] = v;
      rgba[n * 4 + 3] = 255;
    });
    applyLitCap(rgba);
    // Within one LSB, not exactly equal, and the difference is worth being precise about: the two
    // sides round the same product in different spaces (bytes here, normalised floats on the GPU),
    // so a product landing on an exact .5 goes either way — 130 * 1.95 is 253.5 and comes out 254
    // from `v * k` but 253 from `(v / 255) * k * 255`, whose last float bit is below .5. A GPU does
    // not promise a tie-break rule either, so 1 LSB IS the available precision. The end-to-end
    // check that the shipped swatch composites identically is the frame read-back recorded in
    // design/01, not this: 0 of 1,641,600 pixels differed.
    values.forEach((v, n) => {
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(rgba[n * 4 + i]! - additive(v, i))).toBeLessThanOrEqual(1);
      }
    });
    // ...and everything away from a tie is exact, so the tolerance above cannot hide a real drift.
    for (const [v, i] of [[46, 0], [46, 2], [100, 1], [183, 0], [255, 2]] as const) {
      const n = values.indexOf(v);
      expect(rgba[n * 4 + i]!).toBe(additive(v, i));
    }
  });

  it('clamps at 255 rather than wrapping — in an UNclamped buffer too', () => {
    // Deliberately a plain Uint8Array, not the Uint8ClampedArray that `ImageData.data` is: the
    // clamped variant clamps on assignment, so it cannot tell a real clamp from a missing one.
    // Without the clamp, 200 * 1.95 = 390 wraps to 134 — a near-black stone where a near-white one
    // belongs, and the brightest pixels of the swatch are exactly the ones that hit it.
    const raw = new Uint8Array([200, 200, 200, 255]);
    applyLitCap(raw);
    expect(raw[0]).toBe(255);
    expect([...raw].every((b) => b <= 255)).toBe(true);
    const clamped = new Uint8ClampedArray([200, 200, 200, 255]);
    applyLitCap(clamped);
    expect([...clamped]).toEqual([...raw]);
  });

  it('leaves alpha untouched', () => {
    const rgba = new Uint8ClampedArray([10, 10, 10, 0, 10, 10, 10, 128, 10, 10, 10, 255]);
    applyLitCap(rgba);
    expect([rgba[3], rgba[7], rgba[11]]).toEqual([0, 128, 255]);
  });

  it('actually brightens a mid grey — a no-op transform would pass nothing above', () => {
    const rgba = new Uint8ClampedArray([46, 46, 46, 255]);
    applyLitCap(rgba);
    expect(rgba[0]!).toBeGreaterThan(46);
    // The measured target from `CAP_BOOST_ALPHA`'s doc: a ~46 swatch reaches ~90, not ~93 flat.
    expect(rgba[0]!).toBe(Math.min(255, Math.round(46 * LIT_CAP_FACTORS[0]!)));
  });
});

describe('bakeLitCap — availability and caching', () => {
  const cap = (): Texture => new Texture({ source: new TextureSource({ width: 8, height: 8 }) });

  it('returns undefined where there is no 2D canvas, so the caller can keep the additive path', () => {
    // This is the branch a headless test run and a `<canvas>`-less embed both take. It must be a
    // clean undefined rather than a throw, because the alternative is a wall with no key light.
    expect(bakeLitCap(cap())).toBeUndefined();
  });

  it('memoises per source texture, including the unavailable case', () => {
    const t = cap();
    let created = 0;
    vi.stubGlobal('document', {
      createElement: () => {
        created++;
        return { getContext: () => null };
      },
    });
    expect(bakeLitCap(t)).toBeUndefined();
    expect(bakeLitCap(t)).toBeUndefined();
    expect(created).toBe(1);
  });

  it('keys the cache PER SWATCH — two biomes must not share one bake', () => {
    // The failure this guards is a whole-biome one and completely silent: a cache held in a single
    // module variable (or keyed on something constant) would hand every biome whichever swatch was
    // baked first, so ice rooms would quietly wear ember stone. Only the wall cap would be wrong —
    // the FACE comes from a different texture and would still be per-biome, which is exactly the
    // kind of half-right frame nobody spots in a screenshot.
    const a = cap();
    const b = cap();
    expect(a.uid).not.toBe(b.uid);
    const seen: unknown[] = [];
    vi.stubGlobal('document', {
      createElement: () => {
        const made = { width: 0, height: 0, getContext: () => null };
        seen.push(made);
        return made;
      },
    });
    bakeLitCap(a);
    bakeLitCap(b);
    bakeLitCap(a); // ...and the first one is still cached, so this must not bake a third time
    expect(seen).toHaveLength(2);
  });

  it('bakes through a canvas when one exists: source FRAME in, repeat wrap out', () => {
    // A fake canvas is enough to pin the two things a real one cannot tell us apart from: that the
    // draw is windowed to the texture's own frame (so a packed sheet would bake the right region,
    // not the whole atlas), and that the baked copy keeps the `repeat` address mode the swatch was
    // loaded with — clamp-to-edge would make the TilingSprite smear one border pixel.
    const t = new Texture({ source: new TextureSource({ width: 64, height: 64 }) });
    t.frame.x = 8;
    t.frame.y = 16;
    t.frame.width = 32;
    t.frame.height = 24;
    t.updateUvs();
    (t.source as unknown as { resource: unknown }).resource = { width: 64, height: 64 };
    const drawn: unknown[][] = [];
    const pixels = new Uint8ClampedArray(32 * 24 * 4).fill(60);
    const fake = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...a: unknown[]) => drawn.push(a),
        getImageData: () => ({ data: pixels }),
        putImageData: () => undefined,
      }),
    };
    vi.stubGlobal('document', { createElement: () => fake });

    const lit = bakeLitCap(t)!;
    expect(lit).toBeDefined();
    expect(fake.width).toBe(32);
    expect(fake.height).toBe(24);
    expect(drawn[0]!.slice(1)).toEqual([8, 16, 32, 24, 0, 0, 32, 24]);
    expect(lit.source.addressMode).toBe('repeat');
    // ...and the pixels really went through the transform on the way.
    expect(pixels[0]!).toBe(Math.min(255, Math.round(60 * LIT_CAP_FACTORS[0]!)));
  });

  it('bakes on a runtime with NO document and a canvas that is not an HTMLCanvasElement (WeChat)', () => {
    // The shipped WeChat crash, in one test: entering any room threw "Could not find a source type
    // for resource" out of `roomBuilder.build`. `Texture.from` chooses a source class by testing the
    // resource with `resource instanceof HTMLCanvasElement || resource instanceof OffscreenCanvas`,
    // and the mini-game runtime defines neither global — so a perfectly usable `wx.createCanvas()`
    // matched nothing and Pixi threw. Nothing about the pixels was wrong; the SNIFF was.
    //
    // Both halves matter and each one alone still passes on the broken code, so they are asserted
    // together: the canvas has to come from `DOMAdapter` (there is no `document` here to fall back
    // to), and the texture has to be built by naming `CanvasSource` rather than by detection.
    const t = new Texture({ source: new TextureSource({ width: 16, height: 16 }) });
    (t.source as unknown as { resource: unknown }).resource = { width: 16, height: 16 };
    const wxCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4).fill(40) }),
        putImageData: () => undefined,
      }),
    };
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('HTMLCanvasElement', undefined);
    vi.stubGlobal('OffscreenCanvas', undefined);
    const browserAdapter = DOMAdapter.get();
    DOMAdapter.set({ ...browserAdapter, createCanvas: (w = 0, h = 0) => {
      wxCanvas.width = w;
      wxCanvas.height = h;
      return wxCanvas as unknown as HTMLCanvasElement;
    } });
    try {
      const lit = bakeLitCap(t);
      expect(lit).toBeDefined();
      expect(lit!.source.resource).toBe(wxCanvas);
      expect(lit!.source.width).toBe(16);
      expect(lit!.source.addressMode).toBe('repeat');
    } finally {
      DOMAdapter.set(browserAdapter);
    }
  });
});
