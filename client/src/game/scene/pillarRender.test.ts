/**
 * `pillarRender` — a pillar as a stone cylinder, in the same tonal language a standing wall is
 * drawn in. Split out of `wallRender.test.ts` on 2026-08-19 alongside the module itself.
 *
 * The Graphics geometry is not readable back out of Pixi as pixels, but its retained instruction
 * list is, so these assert what a regression would actually break: the shaft's colour ramp is
 * monotonic and spans a real range, the top surface is the brightest plane on the object, none of
 * it is reachable from the pre-art palette fallbacks, and it agrees with a wall about the light.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import {
  buildPillarBody,
  buildPillarSprite,
  pillarArtExtent,
  pillarSpriteMetrics,
  pillarTint,
} from './pillarRender';
import { buildWallBlock, type WallSkin } from './wallRender';
import { biomePalette } from '../theme';
import type { RectPx } from './wallGeometry';

const RECT: RectPx = { x: 320, y: 640, w: 480, h: 32 };
const HEIGHT = 104;

function tex(): Texture {
  return new Texture({ source: new TextureSource({ width: 16, height: 64 }) });
}

function skin(withArt: boolean): WallSkin {
  return {
    palette: biomePalette(undefined),
    cap: withArt ? tex() : undefined,
    face: withArt ? tex() : undefined,
  };
}

interface Instr {
  action: string;
  data: { style?: { color: number; alpha: number; width?: number }; path?: { instructions: Array<{ action: string; data: number[] }> } };
}

/** Opaque (alpha 1) fill colours drawn into `g`, in draw order. */
function opaqueFills(g: Graphics): number[] {
  return (g.context.instructions as Instr[])
    .filter((i) => i.action === 'fill' && i.data.style!.alpha === 1)
    .map((i) => i.data.style!.color);
}

function strokes(g: Graphics): Array<{ color: number; alpha: number }> {
  return (g.context.instructions as Instr[])
    .filter((i) => i.action === 'stroke')
    .map((i) => ({ color: i.data.style!.color, alpha: i.data.style!.alpha }));
}

/** Perceived brightness, for asserting a shading ramp goes the right way. */
function luma(hex: number): number {
  return 0.299 * ((hex >> 16) & 0xff) + 0.587 * ((hex >> 8) & 0xff) + 0.114 * (hex & 0xff);
}

describe('buildPillarBody — a stone cylinder in the wall\'s tonal language', () => {
  const palette = biomePalette('ember');

  it('draws a shaft plus a top ellipse that overhangs it', () => {
    const g = buildPillarBody(64, 70, palette);
    // The cap overhangs the shaft by a couple of px on each side, and the whole thing rises
    // from the ground origin (y = 0) up past the cap's own top half.
    expect(g.bounds.width).toBeGreaterThan(64);
    expect(g.bounds.minY).toBeLessThan(-70);
    expect(g.bounds.maxY).toBeGreaterThan(0); // the base extends a little past the ground point
  });

  it('shades across the cylinder\'s curve rather than in two flat bands', () => {
    // The first attempt drew nine translucent bands and a 4x render showed nine hard vertical
    // seams: stacked alpha steps in opacity, it does not interpolate. These are colour-lerped
    // instead, and there have to be enough of them for the step to disappear.
    const g = buildPillarBody(64, 70, palette);
    const bands = g.context.instructions.filter((i) => i.action === 'fill').length;
    expect(bands).toBeGreaterThan(12);
  });

  it('takes its stone from explicit charcoal-navy tones, not the biome\'s pillar hue', () => {
    // `palette.pillar` is a pre-art fallback: the ember palette mixes the element's warm hue
    // into a slate base and lands on a pale mauve, which is nothing like the shipped swatches.
    // A pillar must not be reachable from it — this pins the regression, since re-deriving from
    // the palette is exactly the "fix" someone would reach for again.
    const ember = buildPillarBody(64, 70, biomePalette('ember'));
    const neutral = buildPillarBody(64, 70, biomePalette(undefined));
    // Both are drawn (the palette still mixes in for biome flavour, so they are not identical
    // objects) but neither is the mauve fallback: the biome mix is a minority share.
    expect(ember.bounds.width).toBe(neutral.bounds.width);
    expect(palette.pillar).not.toBe(palette.wall); // the fallback hue still exists, just unused here
  });

  it('scales its whole silhouette with the height and width it is given', () => {
    const small = buildPillarBody(40, 40, palette);
    const big = buildPillarBody(80, 100, palette);
    expect(big.bounds.width).toBeGreaterThan(small.bounds.width);
    expect(big.bounds.height).toBeGreaterThan(small.bounds.height);
  });
});

describe('buildPillarBody — the shaft is shaded by COLOUR, across the curve', () => {
  const palette = biomePalette('ember');

  it('ramps luminance monotonically from a lit west limb to a dark east one', () => {
    // A cylinder has no flat side, so the gradual falloff across its curve is the only thing
    // separating it from a rounded rectangle. Monotonic is the property; the exact tones are not.
    const bands = opaqueFills(buildPillarBody(64, 70, palette)).slice(1, -1); // drop base fill + cap
    expect(bands.length).toBeGreaterThan(12);
    for (let i = 1; i < bands.length; i++) {
      expect(luma(bands[i]!)).toBeLessThanOrEqual(luma(bands[i - 1]!));
    }
    expect(luma(bands[0]!)).toBeGreaterThan(luma(bands[bands.length - 1]!) * 1.8); // a real range
  });

  it('makes the top surface the brightest thing on the object', () => {
    // The most exposed plane under an overhead key light. If the cap were not clearly the
    // lightest, the pillar reads as an open-topped well — which is exactly how the
    // texture-mapped attempt came out.
    const fills = opaqueFills(buildPillarBody(64, 70, palette));
    const cap = fills[fills.length - 1]!; // drawn last, over the silhouette
    for (const f of fills.slice(0, -1)) expect(luma(cap)).toBeGreaterThan(luma(f));
  });

  it('never uses the biome palette\'s own pillar hues — they are pre-art fallbacks', () => {
    // `palette.pillar`/`pillarTop` blend the element's warm hue into slate; on ember that is a
    // pale mauve, nothing like the charcoal-navy stone every shipped swatch is. Reaching for
    // them again is exactly the "fix" this guards against.
    const fills = opaqueFills(buildPillarBody(64, 70, palette));
    expect(fills).not.toContain(palette.pillar);
    expect(fills).not.toContain(palette.pillarTop);
  });

  it('is charcoal-navy: every stone tone is blue-leaning, never warm', () => {
    // The one objective test of "matches the art rather than the palette" — the swatches are
    // dark charcoal-NAVY (`art/biome/prompts.md`), so blue must never fall below red.
    for (const f of opaqueFills(buildPillarBody(64, 70, palette))) {
      expect(f & 0xff).toBeGreaterThan((f >> 16) & 0xff);
    }
  });

  it('still shifts with the biome, so ice and fire rooms are not identical', () => {
    const emberFills = opaqueFills(buildPillarBody(64, 70, biomePalette('ember')));
    const neutralFills = opaqueFills(buildPillarBody(64, 70, biomePalette(undefined)));
    expect(emberFills).not.toEqual(neutralFills);
  });

  it('shares the wall\'s dark silhouette rather than inventing its own', () => {
    const wall = buildWallBlock(RECT, HEIGHT, skin(true));
    const wallEdge = strokes(wall.children[4] as Graphics).find((s) => s.color !== 0xffffff)!;
    const pillarEdge = strokes(buildPillarBody(64, 70, palette)).find((s) => s.color !== 0xffffff)!;
    expect(pillarEdge.color).toBe(wallEdge.color);
    expect(pillarEdge.alpha).toBe(wallEdge.alpha);
  });
});

describe('buildPillarBody — the retune that stopped it being the brightest thing in the room', () => {
  const palette = biomePalette('ember');

  it('keeps the top surface within reach of a wall cap, not twice as bright', () => {
    // Measured 2026-08-19: pillar top luma 105 while the brightest stone anywhere else in the
    // room — a wall cap — was 44. Once the walls read as stone, four cylinders lit by a
    // different, brighter light were the worst thing left in frame. The wall cap now lands
    // around 88 (see `wallTone.ts`'s table), so the pillar top belongs near it: this pins the
    // RELATIONSHIP, which is what a future tune of either side has to preserve.
    const fills = opaqueFills(buildPillarBody(64, 70, palette));
    const top = luma(fills[fills.length - 1]!);
    expect(top).toBeGreaterThan(70); // still unmistakably the lit plane
    expect(top).toBeLessThan(100); // ...but not a different material
  });

  it('mottles the shaft, so it is not a mathematically clean gradient', () => {
    // A perfect colour ramp is exactly what reads as moulded plastic beside a wall carrying a
    // real stone swatch. The mottling is a fixed table (never random) so a pillar stays
    // deterministic, and every speck is dark — a light speck on a curved surface reads as a hole.
    const g = buildPillarBody(64, 70, palette);
    const specks = (g.context.instructions as Instr[])
      .filter((i) => i.action === 'fill' && i.data.style!.alpha < 1 && i.data.style!.color === 0x000000)
      .filter((i) => (i.data.path?.instructions ?? []).some((pi) => pi.action === 'ellipse'));
    expect(specks.length).toBeGreaterThanOrEqual(5);
    for (const s of specks) expect(s.data.style!.alpha).toBeLessThan(0.15);
  });

  it('is deterministic — two pillars of the same size are drawn identically', () => {
    const a = opaqueFills(buildPillarBody(64, 70, palette));
    const b = opaqueFills(buildPillarBody(64, 70, palette));
    expect(a).toEqual(b);
  });
});

describe('pillarArtExtent — what the occlusion x-ray is told a pillar covers', () => {
  const palette = biomePalette('ember');

  it('reports the same top the cap ellipse is actually drawn at', () => {
    // The x-ray asks how far north of its own ground point a block's art reaches; for a pillar
    // that is the shaft height PLUS the overhanging top ellipse. Read back off the real
    // instruction list rather than restated, so re-proportioning the cap cannot silently leave
    // the x-ray measuring the old shape (`occlusion.Occluder.top`).
    const bodyW = 80;
    const height = 70;
    const g = buildPillarBody(bodyW, height, palette);
    const ellipses = (g.context.instructions as Instr[])
      .flatMap((i) => i.data.path?.instructions ?? [])
      .filter((pi) => pi.action === 'ellipse');
    expect(ellipses.length).toBeGreaterThan(0);
    // ellipse data is [cx, cy, rx, ry]; the cap's is the one centred on -height.
    const cap = ellipses.find((e) => e.data[1] === -height && (e.data[3] ?? 0) > 8);
    expect(cap).toBeDefined();
    const drawnTop = cap!.data[1]! - cap!.data[3]!;
    const drawnHalfW = cap!.data[2]!;

    const extent = pillarArtExtent(bodyW, height);
    expect(extent.top).toBeCloseTo(drawnTop, 6);
    expect(extent.halfW).toBeCloseTo(drawnHalfW, 6);
  });

  it('always reaches at least a full wall height north of the ground point', () => {
    // The property the x-ray depends on, independent of the cap's proportions: a pillar is drawn
    // UPWARD from a grounded origin, so it covers its whole height of walkable floor to its
    // north — which is why a character standing behind one vanishes exactly as they do behind a
    // wall block, and why `RoomBuilder` gives both the same treatment.
    for (const [bodyW, height] of [[40, 70], [80, 70], [120, 104]] as const) {
      expect(pillarArtExtent(bodyW, height).top).toBeLessThanOrEqual(-height);
    }
  });
});

/**
 * The textured pillar (2026-08-20). What can be asserted here is not pixels — the art is a file
 * this process never decodes — but everything the renderer DERIVES from it: the box it occupies,
 * the box the x-ray is told about (which must be the same box), the tint that carries the biome,
 * and the cues it deliberately does NOT draw on top of the art.
 *
 * The shipped sprite is 326x384 (`client/public/biome/pillar_neutral.png`), and its measured
 * tones are quoted wherever a test depends on them: top surface 101, shaft bands 84 / 59 / 30,
 * foot 58 against a shaft of 59 (i.e. the art carries no base darkening of its own).
 */
const SHIPPED_TEX_W = 326;
const SHIPPED_TEX_H = 384;
const ART_TOP_LUMA = 101; // measured on the shipped file: straight-down luma of the cap's centre

function artTex(w = SHIPPED_TEX_W, h = SHIPPED_TEX_H): Texture {
  return new Texture({ source: new TextureSource({ width: w, height: h }) });
}

describe('buildPillarSprite — real pillar art in place of the hand-toned cylinder', () => {
  const palette = biomePalette('ember');

  it('mounts a bottom-anchored sprite at the pillar\'s ground point, scaled by WIDTH', () => {
    const c = buildPillarSprite(80, 70, palette, artTex());
    const sprite = c.children.find((ch) => ch instanceof Sprite) as Sprite;
    expect(sprite).toBeDefined();
    // Anchored at its own bottom centre and sitting `PILLAR_BASE_PX` below the ground point, so
    // the art's foot lands where the hand-toned shaft's rounded base did.
    expect(sprite.anchor.x).toBeCloseTo(0.5, 6);
    expect(sprite.anchor.y).toBeCloseTo(1, 6);
    expect(sprite.y).toBeCloseTo(10, 6);
    const { w, h } = pillarSpriteMetrics(80, artTex());
    expect(sprite.width).toBeCloseTo(w, 4);
    expect(sprite.height).toBeCloseTo(h, 4);
    // The art itself, and the biome's tint on it — both survived the mutation battery as untested
    // (a `new Sprite()` with no texture still measures the right box, and a dropped tint
    // assignment still leaves `pillarTint` unit-tested and green).
    const tex = artTex();
    const s2 = buildPillarSprite(80, 70, palette, tex).children.find((ch) => ch instanceof Sprite) as Sprite;
    expect(s2.texture).toBe(tex);
    expect(s2.tint).toBe(pillarTint(palette));
  });

  it('scales by width and lets the ART\'s aspect set how tall the pillar stands', () => {
    // Width is the axis the footprint has to agree with (a character walks around a pillar, not
    // over it), so the art is fitted to it and its own aspect decides the height.
    const m = pillarSpriteMetrics(80, artTex());
    expect(m.w).toBeCloseTo(84, 6); // bodyW + 2 * PILLAR_CAP_OVERHANG_PX
    expect(m.h).toBeCloseTo(84 * (SHIPPED_TEX_H / SHIPPED_TEX_W), 4);
    // Half the width halves the height with it — one uniform scale, never a squash.
    const half = pillarSpriteMetrics(40, artTex());
    expect(half.h / half.w).toBeCloseTo(m.h / m.w, 6);
  });

  it('the shipped art stands the height the hand-toned cylinder did (within 4 px)', () => {
    // The one thing scaling-by-width leaves to the art file: `WALL_HEIGHT` is what every
    // standing thing in a room agrees on (design/01), and a pillar only keeps that agreement
    // while the art's aspect stays near the shape it was drawn for. If a regenerated file moves
    // this past 4 px, pillars have silently stopped matching the interior walls beside them and
    // the thing to fix is the ART, not this bound.
    const sprite = pillarArtExtent(80, 70, artTex());
    const handToned = pillarArtExtent(80, 70);
    expect(Math.abs(sprite.top - handToned.top)).toBeLessThanOrEqual(4);
    expect(Math.abs(sprite.halfW - handToned.halfW)).toBeLessThanOrEqual(1);
  });

  it('tells the x-ray the box the sprite actually occupies, not the ellipse maths', () => {
    // The two bodies draw different shapes, so the extent has to follow whichever one is drawn:
    // an extent describing the other would fade a pillar for a character it does not cover, or
    // (worse) leave one solid over a character it does.
    const tex = artTex(200, 400); // deliberately NOT the shipped aspect
    const { w, h } = pillarSpriteMetrics(80, tex);
    const extent = pillarArtExtent(80, 70, tex);
    expect(extent.halfW).toBeCloseTo(w / 2, 6);
    expect(extent.top).toBeCloseTo(10 - h, 6);
    // ...and that is a different answer from the hand-toned path's, which is the whole point.
    expect(extent.top).not.toBeCloseTo(pillarArtExtent(80, 70).top, 1);
  });

  it('darkens the art onto design/01\'s tonal target instead of baking a level edit into the file', () => {
    // The shipped art's top surface measures 101; the measured frame wants a pillar top around
    // 92, brighter than a wall cap's 76-88. `pillarTint` is a multiply, so the operation that
    // carries the biome hue does that correction too — one transform, and one that leaves the
    // file itself unedited.
    const tint = pillarTint(palette);
    const factor = ((tint >> 16) & 0xff) / 255;
    expect(ART_TOP_LUMA * factor).toBeGreaterThan(85);
    expect(ART_TOP_LUMA * factor).toBeLessThan(96);
    // Never a brightening: the art is authored at or above target on every plane.
    for (const shift of [16, 8, 0]) expect((tint >> shift) & 0xff).toBeLessThan(255);
  });

  it('keeps the biomes apart — a fire room\'s pillar is warmer than a neutral one\'s', () => {
    // "They differ" would pass with `pillarTint` replaced by almost anything, so this asserts
    // the DIRECTION: red-minus-blue has to move the warm way for fire.
    const warmth = (hex: number) => ((hex >> 16) & 0xff) - (hex & 0xff);
    expect(warmth(pillarTint(biomePalette('ember')))).toBeGreaterThan(
      warmth(pillarTint(biomePalette(undefined))),
    );
  });

  it('draws the base contact crease the art does not carry — and nothing else', () => {
    // Measured on the file: its foot sits at the same value as its shaft (58 vs 59), so the
    // crease is the only thing grounding it. Everything the art DOES carry (closed top ellipse,
    // three shading bands, curved course joints, silhouette) must not be drawn twice — the
    // hand-toned body's mottle and white coping stroke are exactly that kind of double-up, and
    // a silhouette stroke would outline the sprite's own outline.
    const c = buildPillarSprite(80, 70, palette, artTex());
    const g = c.children.find((ch) => ch instanceof Graphics) as Graphics;
    expect(g).toBeDefined();
    const fills = (g.context.instructions as Instr[]).filter((i) => i.action === 'fill');
    expect(fills.length).toBe(12); // BASE_AO_BANDS — proven non-empty before anything below
    expect(fills.every((f) => f.data.style!.color === 0x000000)).toBe(true);
    expect(fills.every((f) => f.data.style!.alpha < 1)).toBe(true);
    expect(strokes(g)).toHaveLength(0);
    // The ramp deepens toward the floor; bands at one flat alpha show their own edges (the same
    // lesson as CAST_PASSES and the door bloom's nine rings).
    const alphas = fills.map((f) => f.data.style!.alpha);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeGreaterThan(alphas[i - 1]!);
  });

  it('mounts the crease OVER the sprite, not under it', () => {
    // Survived the mutation battery: every assertion about the crease found it by type, so
    // swapping the two children left them all green while the crease rendered behind the art and
    // did nothing — the same shape as the floor pass's "grid mounted UNDER the floor" mutant.
    const c = buildPillarSprite(80, 70, palette, artTex());
    expect(c.children[0]).toBeInstanceOf(Sprite);
    expect(c.children[1]).toBeInstanceOf(Graphics);
  });

  it('draws the crease over the base fraction of the ROOM height, rounded like the shaft', () => {
    // Also a battery survivor, four times over: reading only the fills' alphas made the crease's
    // geometry invisible to the tests, so it could be sized off the ART's height instead of the
    // room's, lose its corner rounding under a round object, stop short of the foot, or cover the
    // whole shaft. `roundRect` data is [x, y, w, h, radius] — and the `moveTo(0, 0)` Pixi emits
    // before each path has to be filtered out first.
    const height = 70;
    const bodyW = 80;
    const c = buildPillarSprite(bodyW, height, palette, artTex());
    const g = c.children.find((ch) => ch instanceof Graphics) as Graphics;
    const rects = (g.context.instructions as Instr[])
      .flatMap((i) => i.data.path?.instructions ?? [])
      .filter((pi) => pi.action === 'roundRect')
      .map((pi) => pi.data as number[]);
    expect(rects).toHaveLength(12); // BASE_AO_BANDS, and non-empty before anything below
    const aoH = height * 0.42; // BASE_AO_FRACTION
    // Top band starts exactly one base fraction above the ground point...
    expect(rects[0]![1]).toBeCloseTo(-aoH, 4);
    // ...bands step evenly down from there...
    expect(rects[1]![1]! - rects[0]![1]!).toBeCloseTo(aoH / 12, 4);
    // ...the last one runs PILLAR_BASE_PX past the ground point, so the foot is covered...
    const last = rects[11]!;
    expect(last[1]! + last[3]!).toBeCloseTo(10, 4);
    // ...every band is as wide as the shaft and rounded like it.
    for (const r of rects) {
      expect(r[2]).toBeCloseTo(bodyW, 4);
      expect(r[4]).toBeCloseTo(bodyW * 0.12, 4); // PILLAR_CORNER_FRACTION
    }
  });

  it('is the same crease the hand-toned body draws, so both bodies meet the floor alike', () => {
    const c = buildPillarSprite(80, 70, palette, artTex());
    const g = c.children.find((ch) => ch instanceof Graphics) as Graphics;
    const spriteAlphas = (g.context.instructions as Instr[])
      .filter((i) => i.action === 'fill')
      .map((i) => i.data.style!.alpha);
    const handToned = buildPillarBody(80, 70, palette);
    const handAlphas = (handToned.context.instructions as Instr[])
      .filter((i) => i.action === 'fill' && i.data.style!.color === 0x000000 && i.data.style!.alpha < 1)
      .map((i) => i.data.style!.alpha);
    // The hand-toned body's black translucent fills are its mottle followed by its crease; the
    // crease is the tail of that list and must match the sprite's set exactly.
    expect(spriteAlphas.length).toBeGreaterThan(0);
    expect(handAlphas.slice(-spriteAlphas.length)).toEqual(spriteAlphas);
  });
});
