/**
 * terrainSwatch — the generated ground the void's far side is tiled from (2026-08-28).
 *
 * Everything here runs on the real bake (`shadeRamp.bakedField` -> `BufferImageSource`), not on a
 * fake: that path has no canvas, no `DOMAdapter` and no DOM globals in it, which is the whole
 * reason it was chosen over `capLight.ts`'s canvas bake. The bytes read back here are the same
 * bytes a browser and the wx runtime get.
 *
 * `bakedField` memoises by key and nothing resets it, so each case that cares about pixel content
 * uses its OWN colour — a shared colour would silently hand the second test the first's texture.
 */
import { describe, it, expect } from 'vitest';
import { TERRAIN_CONTRAST, TERRAIN_OCTAVES, TERRAIN_TILE_PX, terrainNoiseAt, terrainSwatch } from './terrainSwatch';
import { TERRAIN_MIX, biomePalette } from '../theme';

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

function pixels(color: number): Uint8Array {
  return terrainSwatch(color).source.resource as Uint8Array;
}

function meanLuma(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 4) sum += luma(buf[i], buf[i + 1], buf[i + 2]);
  return sum / (buf.length / 4);
}

function hexLuma(c: number): number {
  return luma((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
}

describe('terrainNoiseAt — the field itself', () => {
  it('stays inside [0,1) everywhere on the tile', () => {
    for (let y = 0; y < TERRAIN_TILE_PX; y++) {
      for (let x = 0; x < TERRAIN_TILE_PX; x++) {
        const n = terrainNoiseAt(x, y);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(1);
      }
    }
  });

  it('TILES SEAMLESSLY — the east edge samples what the west edge does', () => {
    // The defect this catches is a visible grid of seams across a plane that covers the whole
    // view: one un-wrapped lattice lookup and every tile boundary becomes a line. It is invisible
    // in a unit test of the hash and obvious on screen, which is exactly the kind of thing that
    // gets shipped.
    for (let y = 0; y < TERRAIN_TILE_PX; y++) {
      expect(terrainNoiseAt(TERRAIN_TILE_PX, y)).toBeCloseTo(terrainNoiseAt(0, y), 12);
    }
    for (let x = 0; x < TERRAIN_TILE_PX; x++) {
      expect(terrainNoiseAt(x, TERRAIN_TILE_PX)).toBeCloseTo(terrainNoiseAt(x, 0), 12);
    }
  });

  it('has octave lattices that all DIVIDE the tile, or it cannot wrap', () => {
    // The seam test above would catch a violation, but only for the octave that broke; this says
    // WHY, and it fails on a new octave the moment one is added with a bad cell count.
    for (const o of TERRAIN_OCTAVES) expect(TERRAIN_TILE_PX % o.cells).toBe(0);
  });

  it('has octave weights summing to exactly 1, so the field stays normalised', () => {
    const total = TERRAIN_OCTAVES.reduce((a, o) => a + o.weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('carries detail BELOW the tile period — the fix for a legible repeat', () => {
    // The defect this exists for was found in a live frame, not here: a two-octave 64px swatch
    // whose dominant term had the tile's own period read as a regular grid of identical blobs.
    // The guard is that the finest lattice is several times finer than the coarsest, so there is
    // structure at a scale the repeat does not live at.
    const cells = TERRAIN_OCTAVES.map((o) => o.cells);
    expect(Math.max(...cells) / Math.min(...cells)).toBeGreaterThanOrEqual(4);
    // And the coarsest must not be able to carry the field on its own.
    expect(Math.max(...TERRAIN_OCTAVES.map((o) => o.weight))).toBeLessThan(0.6);
  });

  it('is CONTINUOUS everywhere, not merely seamless at the tile edge', () => {
    // Found by a mutation battery (2026-08-28), and it is the gap the seam test above left wide
    // open: that test compares column 0 with column TILE, so it proves the field WRAPS and says
    // nothing about whether it is smooth in between. Three separate mutants exploited exactly
    // that — interpolating against a non-adjacent lattice neighbour (`ix + 1` -> `ix + 2` or
    // `ix - 1`) and breaking smoothstep's endpoint (`3 - 2t` -> `3 - 3t`). All three leave the
    // wrap intact and put a hard step at EVERY cell boundary, which on a plane covering the whole
    // void is a visible grid — the same defect class that made the first shipped swatch read as a
    // texture bug.
    //
    // Bound measured rather than guessed: the shipped field's worst adjacent-pixel step is 0.108,
    // and the cheapest of those three mutants measures 0.52 (the others 0.62 and 0.88). 0.2 sits
    // between them with ~1.85x headroom over the real field.
    let worst = 0;
    for (let y = 0; y < TERRAIN_TILE_PX; y++) {
      for (let x = 0; x < TERRAIN_TILE_PX; x++) {
        const here = terrainNoiseAt(x, y);
        // Wrapped, so the tile boundary is included rather than being a special case.
        worst = Math.max(
          worst,
          Math.abs(terrainNoiseAt((x + 1) % TERRAIN_TILE_PX, y) - here),
          Math.abs(terrainNoiseAt(x, (y + 1) % TERRAIN_TILE_PX) - here),
        );
      }
    }
    expect(worst).toBeLessThan(0.2);
  });

  it('is DETERMINISTIC — the same pixel gives the same value across calls', () => {
    const first = Array.from({ length: 64 }, (_, i) => terrainNoiseAt(i * 3, i * 7));
    const second = Array.from({ length: 64 }, (_, i) => terrainNoiseAt(i * 3, i * 7));
    expect(second).toEqual(first);
  });

  it('actually VARIES — a constant field would pass every bound above', () => {
    // The control. Every assertion in this describe block is satisfied by `return 0.5`.
    const seen = new Set<number>();
    for (let y = 0; y < TERRAIN_TILE_PX; y += 4) {
      for (let x = 0; x < TERRAIN_TILE_PX; x += 4) seen.add(Math.round(terrainNoiseAt(x, y) * 100));
    }
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('terrainSwatch — the baked texture', () => {
  it('is a POT tile with mipmaps, which WebGL1/WeChat needs to filter it at all', () => {
    const tex = terrainSwatch(0x101820);
    expect(tex.source.width).toBe(TERRAIN_TILE_PX);
    expect(tex.source.height).toBe(TERRAIN_TILE_PX);
    // POT, or WebGL1 silently drops mipmapping and this plane shimmers under a moving camera.
    expect(Math.log2(TERRAIN_TILE_PX) % 1).toBe(0);
    expect(tex.source.autoGenerateMipmaps).toBe(true);
    expect(tex.source.addressMode).toBe('repeat');
  });

  it('is fully OPAQUE, so premultiplied and straight bytes are the same here', () => {
    const buf = pixels(0x121a22);
    for (let i = 3; i < buf.length; i += 4) expect(buf[i]).toBe(255);
  });

  it('is memoised per colour, and two colours do not share a bake', () => {
    expect(terrainSwatch(0x131b23)).toBe(terrainSwatch(0x131b23));
    expect(terrainSwatch(0x141c24)).not.toBe(terrainSwatch(0x131b23));
  });

  it('CLAMPS a bright base colour instead of wrapping it', () => {
    // `terrainSwatch` is exported and takes any colour, so `Math.min(255, ...)` is reachable even
    // though no shipped palette comes close (the brightest terrain channel is ~36, and the peak
    // multiplier ~1.21). A mutation battery survived `255 -> 256` on all three channels for
    // exactly that reason — dead code at shipped inputs, live code at the entry point.
    //
    // The failure it guards is not a soft one: `rgba[i]` is a Uint8Array, so an unclamped 309
    // does not saturate, it WRAPS to 53 — a white terrain would come out with dark speckles
    // wherever the noise peaked, which is the opposite of the intended shading.
    //
    // ALL THREE colour channels, one assertion each. The first version of this test read only
    // `buf[i]`, and the re-run battery duly killed the red clamp while green and blue survived
    // untouched — three separate `Math.min` calls, one axis of coverage. Same shape as this
    // repo's "a sweep is only as complete as its axes" note, found the same way.
    const buf = terrainSwatch(0xffffff).source.resource as Uint8Array;
    for (const [channel, offset] of [['r', 0], ['g', 1], ['b', 2]] as const) {
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < buf.length; i += 4) {
        lo = Math.min(lo, buf[i + offset]);
        hi = Math.max(hi, buf[i + offset]);
      }
      expect(hi, channel).toBe(255);
      // The wrap's signature: with 255 -> 256 the peak texels land near 53, far BELOW the trough.
      expect(lo, channel).toBeGreaterThan(150);
    }
  });

  it('never puts even its BRIGHTEST texel near the floor', () => {
    // An absolute ceiling, deliberately not expressed against TERRAIN_CONTRAST. The contrast test
    // above reads that constant on both sides, so it moves with the code and would pass at an
    // absurd value; this one would not.
    const p = biomePalette('ember');
    const buf = terrainSwatch(p.terrain).source.resource as Uint8Array;
    let hi = 0;
    for (let i = 0; i < buf.length; i += 4) hi = Math.max(hi, luma(buf[i], buf[i + 1], buf[i + 2]));
    expect(hi).toBeLessThan(hexLuma(p.ground));
  });

  it('has its MEAN at the base colour — the contrast is a swing, not a brightening', () => {
    const color = 0x151d25;
    expect(meanLuma(pixels(color))).toBeCloseTo(hexLuma(color), 0);
  });

  it('carries the stated peak-to-peak CONTRAST, within rounding', () => {
    const color = 0x161e26;
    const buf = pixels(color);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < buf.length; i += 4) {
      const l = luma(buf[i], buf[i + 1], buf[i + 2]);
      lo = Math.min(lo, l);
      hi = Math.max(hi, l);
    }
    // The field does not reach a full 0 and 1 over a 64px tile, so the realised swing is a
    // FRACTION of the nominal one. Bounding it from both sides is the point: an upper bound alone
    // passes on a flat tile, a lower bound alone passes on a tile that has blown past the design.
    const realised = (hi - lo) / hexLuma(color);
    expect(realised).toBeGreaterThan(TERRAIN_CONTRAST * 0.5);
    expect(realised).toBeLessThanOrEqual(TERRAIN_CONTRAST * 1.02);
  });
});

describe('terrainSwatch — the legibility contract it exists to satisfy', () => {
  // The two failure modes the whole feature sits between, asserted against the palette rather
  // than a screenshot. Both are POSITIONAL — where terrain falls between a palette's own void and
  // its own ground — and deliberately not a ratio of terrain's luma to ground's. Every biome
  // colour is `mixHex(neutral, hex, 0.1)`, which adds the same absolute amount of a bright hue to
  // both terms, so a plain ratio drifts toward 1 with the hue's brightness: the first version of
  // this suite asserted `terrain < ground * 0.8`, passed on neutral at 0.75, and failed on
  // 'ember' at 0.85 — the only biome that actually ships. The bug it found was real (terrain was
  // being tinted from the neutral terrain rather than derived from each palette's own ends), but
  // the ASSERTION was also wrong, and fixing only the code would have left a guard that means
  // something different on every future hue.
  const ids = ['ember', 'not-a-biome', undefined];

  it('sits on the VOID side of the midpoint — nearer the hole than the floor', () => {
    // STRICTLY less than the midpoint. `<=` let a battery walk the constant to exactly 0.5 —
    // terrain sitting halfway to the floor — with every test still green.
    expect(TERRAIN_MIX).toBeLessThan(0.5);
  });

  it('lands at exactly TERRAIN_MIX between void and ground, on every reachable biome', () => {
    for (const id of ids) {
      const p = biomePalette(id);
      const span = hexLuma(p.ground) - hexLuma(p.void);
      expect(span).toBeGreaterThan(0);
      expect((hexLuma(p.terrain) - hexLuma(p.void)) / span).toBeCloseTo(TERRAIN_MIX, 1);
    }
  });

  it('is strictly between the backdrop and the floor everywhere — never at or past either', () => {
    // The ordering on its own, so a future `TERRAIN_MIX` typo of 0 or 1 fails here loudly
    // rather than collapsing terrain onto one of the two ends and reading as "no regression".
    for (const id of ids) {
      const p = biomePalette(id);
      expect(hexLuma(p.terrain)).toBeGreaterThan(hexLuma(p.void));
      expect(hexLuma(p.terrain)).toBeLessThan(hexLuma(p.ground));
    }
  });
});
