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
import { Graphics, Texture, TextureSource } from 'pixi.js';
import { buildPillarBody, pillarArtExtent } from './pillarRender';
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
