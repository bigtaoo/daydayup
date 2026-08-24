/**
 * The SHIPPED room-prop art itself (`client/public/environment/prop_{crate,barrel,rubble}.png`),
 * decoded and measured (2026-08-24). Sibling of `environmentArt.test.ts`/`pillarArt.test.ts`,
 * for the same reason: every other test in this directory checks what the renderer does with a
 * texture, and these objects' whole look now lives in the files.
 *
 * This batch's own history is why each assertion below exists. Four generations went into three
 * shipped files, and the failures were properties no test of the CODE could see:
 *
 * 1. **The first rubble was pale, spiky and 23% too wide** — median luma 61 against the ember
 *    floor's own 34, drawn as long thin splinters rather than blocks, so at 22 px it read as a
 *    scatter of bone-coloured chips on dark stone. Backwards from design/13's "environment
 *    desaturated, hazards saturated": a light heap reads as loot. Kept as
 *    `art/props/prop_rubble_alt.png` and re-measured in the last describe block below.
 * 2. **All three arrived wrapped in a sub-perceptual alpha veil** (1-10, reaching 50-140 px past
 *    the object) with a body at 252-253 rather than 255. Invisible at 4% and 99% opacity, and
 *    invisible to `alpha-audit.mjs`, but `trimAlphaBoundingBox` keeps any pixel with
 *    `alpha !== 0`: the rubble's trimmed aspect came out 2.95 against its real 3.67, and the
 *    trim kept 123 empty rows underneath it. A prop sprite is bottom-anchored to its ground
 *    point and scaled by WIDTH with the art's aspect setting its height, so that one veil would
 *    have made the rubble stand 25% too tall AND hover. `tools/png-pipeline/alphaClamp.mjs` is
 *    the fix; the margin and opacity assertions here are what prove it ran on these files.
 *
 * Reference values are the live in-frame measurements the batch was judged against (extract of
 * the real level 1): ember floor luma 34 mean / 39-49 band, wall face 27.3-27.5, wall cap 72-88,
 * `pillar_neutral.png` p25/50/75/95 = 41/43/66/102 and `wallface_neutral.png` = 41/53/57/131.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodePNG } from '../../../../tools/png-pipeline/pngCodec.mjs';
import { propBodyHeight, propFootprintWidth, PROP_HEIGHT_CEILING_PX, type PropKind } from './propRender';

interface Img {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

function load(rel: string): Img {
  return decodePNG(readFileSync(new URL(rel, import.meta.url))) as Img;
}

/** Alpha 25 rather than 0, so a measurement means the same thing on a shipped file and on an
 *  unprocessed `_alt` reject — the whole point of `alphaClamp` is that the two differ below
 *  this line, and a comparison that inherits that difference proves nothing. */
const OPAQUE = 25;

function bbox(img: Img): { x: number; y: number; w: number; h: number } {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! > OPAQUE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function aspect(img: Img): number {
  const b = bbox(img);
  return b.w / b.h;
}

/** Luma percentiles over the object's own pixels. The shape of a stone object's tonal spread
 *  is what places it in the environment set — a single mean hides a bright half. */
function luma(img: Img): (p: number) => number {
  const v: number[] = [];
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3]! <= OPAQUE) continue;
    v.push(0.299 * img.data[i * 4]! + 0.587 * img.data[i * 4 + 1]! + 0.114 * img.data[i * 4 + 2]!);
  }
  v.sort((a, b) => a - b);
  return (p: number) => v[Math.min(v.length - 1, Math.floor(v.length * p))]!;
}

/** Each channel's average distance from the pixel-average — the measure that separates this
 *  game's blue-leaning stonework from a neutral or warm object, independent of brightness. */
function hueLean(img: Img): { r: number; g: number; b: number } {
  let R = 0;
  let G = 0;
  let B = 0;
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3]! <= OPAQUE) continue;
    R += img.data[i * 4]!;
    G += img.data[i * 4 + 1]!;
    B += img.data[i * 4 + 2]!;
    n++;
  }
  const avg = (R + G + B) / 3 / n;
  return { r: R / n - avg, g: G / n - avg, b: B / n - avg };
}

function chroma(img: Img): number {
  let c = 0;
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (img.data[i * 4 + 3]! <= OPAQUE) continue;
    const r = img.data[i * 4]!;
    const g = img.data[i * 4 + 1]!;
    const b = img.data[i * 4 + 2]!;
    c += Math.max(r, g, b) - Math.min(r, g, b);
    n++;
  }
  return c / n;
}

const SHIPPED: Record<PropKind, string> = {
  crate: '../../../public/environment/prop_crate.png',
  barrel: '../../../public/environment/prop_barrel.png',
  rubble: '../../../public/environment/prop_rubble.png',
};
const KINDS = ['crate', 'barrel', 'rubble'] as const;

describe('the shipped prop art — geometry the renderer reads off the file', () => {
  it('is trimmed tight, so a bottom-anchored sprite sits ON the floor rather than above it', () => {
    // The veil bug, stated as the thing that would have been visible: any transparent rows
    // left under the object become clearance between the art and its own ground point.
    for (const kind of KINDS) {
      const img = load(SHIPPED[kind]);
      const b = bbox(img);
      expect({ kind, x: b.x, y: b.y }).toEqual({ kind, x: 0, y: 0 });
      expect({ kind, w: b.w, h: b.h }).toEqual({ kind, w: img.width, h: img.height });
    }
  });

  it('has genuinely opaque pixels, not a 99%-opaque plateau', () => {
    // `alpha-audit.mjs` classifies on `alpha == 255`; a body at 253 reports 0% opaque and
    // 83% partial on a file that is actually clean, which retires the audit as a signal.
    for (const kind of KINDS) {
      const img = load(SHIPPED[kind]);
      let solid = 0;
      let clear = 0;
      let midtone = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        if (img.data[i] === 255) solid++;
        else if (img.data[i] === 0) clear++;
        else if (img.data[i]! >= 10 && img.data[i]! <= 245) midtone++;
      }
      const total = img.width * img.height;
      expect(solid / total).toBeGreaterThan(0.25);
      expect(clear / total).toBeGreaterThan(0.1);
      // Antialiasing only. A real translucent-haze background sits far above this.
      expect(midtone / total).toBeLessThan(0.1);
    }
  });

  it('lands the height each kind derives from its own aspect on the authored metric', () => {
    // `buildPropBody` scales a sprite by WIDTH and lets the art's aspect set the height, while
    // the Graphics fallback draws `propBodyHeight`. The two have to agree or swapping between
    // them — which is what a missing texture does — changes the object's size. This is also
    // what catches an art REPLACEMENT at a different aspect: the numbers stop matching here
    // rather than in a frame nobody screenshots.
    for (const kind of KINDS) {
      const derived = propFootprintWidth(kind) / aspect(load(SHIPPED[kind]));
      expect(Math.abs(derived - propBodyHeight(kind))).toBeLessThan(0.5);
    }
  });

  it('keeps every kind under the ceiling that lets props skip the occlusion x-ray', () => {
    for (const kind of KINDS) {
      const derived = propFootprintWidth(kind) / aspect(load(SHIPPED[kind]));
      expect(derived).toBeLessThanOrEqual(PROP_HEIGHT_CEILING_PX);
    }
  });
});

describe('the shipped prop art — tone, against the environment set it has to join', () => {
  it('sits in the environment value band, not the loot band', () => {
    // design/13's "environment desaturated, hazards saturated" is a VALUE separation here:
    // `pickup_crate.png` (a thing you walk over to collect) medians 167, and every stone
    // surface in the room medians 43-53. A prop that drifts up the scale reads as lootable.
    const loot = luma(load('../../../public/environment/pickup_crate.png'))(0.5);
    expect(loot).toBeGreaterThan(150); // guard: the contrast partner must actually be bright
    for (const kind of KINDS) {
      const p50 = luma(load(SHIPPED[kind]))(0.5);
      expect(p50).toBeGreaterThan(35); // ...but not sunk into the floor's own 39-49 band either
      expect(p50).toBeLessThan(60);
      expect(loot - p50).toBeGreaterThan(80);
    }
  });

  it('keeps a lit plane and a shadow side rather than reading flat', () => {
    // The key light comes from the upper left, so an object with any form has a bright top
    // and a dark side. The rejected rubble failed this in the other direction — its whole
    // spread sat high (p25 43, p75 101) instead of straddling the floor's value.
    for (const kind of KINDS) {
      const q = luma(load(SHIPPED[kind]));
      expect(q(0.75)).toBeGreaterThan(q(0.25) * 1.5);
      expect(q(0.95)).toBeLessThan(120);
    }
  });

  it('stays inside the shipped chroma band — dressing, not a saturated hazard', () => {
    // Measured on the accepted set: floor 15.3, wall face 18.1, pillar 12.8. The crate is the
    // top of the band at 20.0 because it is wood rather than stone, which is why this bounds
    // saturation and leaves hue alone.
    for (const kind of KINDS) {
      expect(chroma(load(SHIPPED[kind]))).toBeLessThan(24);
    }
  });

  it('draws the two STONE props in the blue-grey the rest of the stonework uses', () => {
    // Every stone asset in the game leans blue (floor R-6.9/B+8.3, pillar R-5.0/B+7.7, wall
    // face R-8.4/B+9.6). The crate is deliberately exempt — it is wood, and `propTint` does
    // not re-hue it; value is what separates it from the loot crate, not colour.
    for (const kind of ['barrel', 'rubble'] as const) {
      const lean = hueLean(load(SHIPPED[kind]));
      expect(lean.b).toBeGreaterThan(lean.r);
    }
    expect(hueLean(load(SHIPPED.crate)).r).toBeGreaterThan(hueLean(load(SHIPPED.crate)).b);
  });
});

describe('the rejected rubble — every assertion above, re-run on what did NOT ship', () => {
  // An assertion that stops discriminating accepted from rejected art fails here rather than
  // passing vacuously. The first rubble generation failed on three independent axes, so all
  // three are checked: an art change that fixes one and regresses another cannot slip through
  // by satisfying whichever single property this file happened to pin.
  const alt = () => load('../../../../art/props/prop_rubble_alt.png');

  it('is caught by the aspect check', () => {
    const derived = propFootprintWidth('rubble') / aspect(alt());
    expect(Math.abs(derived - propBodyHeight('rubble'))).toBeGreaterThan(0.5);
  });

  it('is caught by the value-band check', () => {
    expect(luma(alt())(0.5)).toBeGreaterThan(60);
  });

  it('is caught by the blue-lean check', () => {
    const lean = hueLean(alt());
    expect(lean.b).toBeLessThan(lean.r);
  });

  it('would NOT have been caught by chroma alone — which is why that is not the only check', () => {
    // Worth pinning explicitly: the reject's saturation was fine (6.3, the lowest of any file
    // measured in this pass). Judging art on one number is how a bad file ships.
    expect(chroma(alt())).toBeLessThan(24);
  });
});
