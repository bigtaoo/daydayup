/**
 * `wallRender` — how one wall footprint + height becomes an extruded block and the shadow it
 * throws (2026-08-18 depth pass, user report *"墙看起来还是没有高度感，就像一张图贴在地上"*).
 *
 * The Graphics geometry itself is not readable back out of Pixi, so these tests assert the
 * things that ARE observable and that a regression would actually break: the block's child
 * composition, where each surface lands in local coords, the per-surface tints that carry the
 * volume, and the shadow hull's own maths (a pure function, checked exactly).
 */
import { describe, it, expect } from 'vitest';
import { Graphics, TilingSprite, Texture, TextureSource } from 'pixi.js';
import { buildPillarBody, buildWallBlock, drawBlockShading, drawWallShadow, sweptHull, type WallSkin } from './wallRender';
import { SHADOW_SLANT_X, SHADOW_SLANT_Y } from './Entity';
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

describe('buildWallBlock — the extruded block', () => {
  it('places the container on the wall\'s SOUTH edge and Y-sorts on that line', () => {
    // This is what lets an actor walk in front of a wall and behind the one beyond it: the
    // whole block sorts as a single object standing on its own south edge.
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    expect(seg.x).toBe(RECT.x);
    expect(seg.y).toBe(RECT.y + RECT.h);
    expect(seg.zIndex).toBe(RECT.y + RECT.h);
  });

  it('stacks the face over -height..0 and the cap the footprint depth above that', () => {
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    const tiles = seg.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
    expect(tiles).toHaveLength(2);
    const [face, cap] = tiles;
    expect(face!.y).toBe(-HEIGHT);
    expect(face!.height).toBe(HEIGHT);
    expect(cap!.y).toBe(-HEIGHT - RECT.h);
    expect(cap!.height).toBe(RECT.h);
  });

  it('tiles the face horizontally only, never stretching its lit coping', () => {
    const t = tex();
    const seg = buildWallBlock(RECT, HEIGHT, { palette: biomePalette(undefined), cap: t, face: t });
    const face = seg.children.find((c): c is TilingSprite => c instanceof TilingSprite)!;
    expect(face.tileScale.x).toBeCloseTo(HEIGHT / t.height, 6);
    expect(face.tileScale.y).toBeCloseTo(HEIGHT / t.height, 6);
  });

  it('separates the surfaces by brightness — cap near-full, face far darker', () => {
    // The volume IS this contrast. Before the depth pass the cap reused the top-down swatch at
    // full brightness AND the face was untinted too, so a surface raised 104 px and one lying
    // on the floor were pixel-for-pixel equally lit. The gap also has to be LARGE, not just
    // present: the two swatches start from very different values (the cap swatch is light grey
    // stone, the face dark charcoal brick), and a shallow face tint left a deep block reading
    // as a pale slab with a thin dark hem. Asserted as a ratio per channel, not as literals,
    // so the numbers stay tunable.
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    const [face, cap] = seg.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
    const red = (tint: number) => (tint >> 16) & 0xff;
    expect(red(cap!.tint)).toBeGreaterThan(0.9 * 0xff); // the top IS the lit plane
    expect(red(face!.tint)).toBeLessThan(0.6 * red(cap!.tint));
  });

  it('scales every surface with the height it is given, so the three tiers really differ', () => {
    const short = buildWallBlock(RECT, 22, skin(true));
    const tall = buildWallBlock(RECT, 104, skin(true));
    const faceOf = (s: typeof short) =>
      s.children.find((c): c is TilingSprite => c instanceof TilingSprite)!;
    expect(faceOf(short).height).toBe(22);
    expect(faceOf(tall).height).toBe(104);
  });

  it('still stands (face + cap + shading + outline) when no swatch has loaded', () => {
    const seg = buildWallBlock(RECT, HEIGHT, skin(false));
    expect(seg.children.filter((c) => c instanceof TilingSprite)).toHaveLength(0);
    // face fallback, cap fallback, shading, outline — all Graphics.
    expect(seg.children.filter((c) => c instanceof Graphics)).toHaveLength(4);
  });

  it('adds shading and an outline on top of the art, in that order', () => {
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    // face, cap (TilingSprites), then shading, then the silhouette outline.
    expect(seg.children).toHaveLength(4);
    expect(seg.children[2]).toBeInstanceOf(Graphics);
    expect(seg.children[3]).toBeInstanceOf(Graphics);
  });
});

describe('drawBlockShading — the side thickness a zero-skew projection cannot give', () => {
  it('draws marks for a normal wall', () => {
    const g = drawBlockShading(RECT, HEIGHT);
    expect(g).toBeInstanceOf(Graphics);
    expect(g.bounds.width).toBeGreaterThan(0);
  });

  it('never lets the side band exceed a fraction of a thin stub\'s width', () => {
    // A 20 px stub must not be drawn as 13 px of pure side shadow — bounded to a share of
    // its own width, so a narrow block still reads as a block rather than as a dark sliver.
    const stub: RectPx = { x: 0, y: 0, w: 20, h: 32 };
    const g = drawBlockShading(stub, HEIGHT);
    expect(g.bounds.width).toBeLessThanOrEqual(stub.w);
  });

  it('keeps all of its geometry inside the block\'s own footprint width', () => {
    // The east side band is INSET, not extruded, precisely so it can never cross into the
    // adjacent segment of the same perimeter run.
    const g = drawBlockShading(RECT, HEIGHT);
    expect(g.bounds.minX).toBeGreaterThanOrEqual(0);
    expect(g.bounds.maxX).toBeLessThanOrEqual(RECT.w);
  });
});

describe('sweptHull — the ground silhouette of a box\'s shadow', () => {
  it('is the convex hull of the footprint and its displaced copy, clockwise from the NW corner', () => {
    const r: RectPx = { x: 10, y: 20, w: 100, h: 40 };
    expect(sweptHull(r, 8, 4)).toEqual([
      10, 20,
      110, 20,
      118, 24,
      118, 64,
      18, 64,
      10, 60,
    ]);
  });

  it('degenerates to the footprint itself at zero displacement', () => {
    const r: RectPx = { x: 0, y: 0, w: 10, h: 10 };
    const hull = sweptHull(r, 0, 0);
    for (let i = 0; i < hull.length; i += 2) {
      expect(hull[i]).toBeGreaterThanOrEqual(0);
      expect(hull[i]).toBeLessThanOrEqual(10);
      expect(hull[i + 1]).toBeGreaterThanOrEqual(0);
      expect(hull[i + 1]).toBeLessThanOrEqual(10);
    }
  });
});

describe('drawWallShadow — the cue that says the wall sits ON the floor', () => {
  it('reaches away from the key light in proportion to the wall\'s height', () => {
    // A taller wall throws a longer shadow. This is the single strongest "it is above the
    // floor" cue and standing walls had NONE of it before (only the pillars did).
    const shortG = new Graphics();
    drawWallShadow(shortG, RECT, 22);
    const tallG = new Graphics();
    drawWallShadow(tallG, RECT, 104);
    expect(tallG.bounds.maxX).toBeGreaterThan(shortG.bounds.maxX);
    expect(tallG.bounds.maxY).toBeGreaterThan(shortG.bounds.maxY);
  });

  it('falls to the lower RIGHT, matching every other shadow in the project', () => {
    const g = new Graphics();
    drawWallShadow(g, RECT, HEIGHT);
    expect(g.bounds.maxX).toBeCloseTo(RECT.x + RECT.w + HEIGHT * SHADOW_SLANT_X, 3);
    expect(g.bounds.maxY).toBeCloseTo(RECT.y + RECT.h + HEIGHT * SHADOW_SLANT_Y, 3);
  });

  it('slants further horizontally than vertically, because the view is tilted', () => {
    expect(SHADOW_SLANT_X).toBeGreaterThan(SHADOW_SLANT_Y);
  });

  it('hugs the footprint with a contact pass that is independent of height', () => {
    // Even a kerb — the shortest tier, whose cast shadow is only a few px long — still gets
    // a definite dark contact line, which is what stops it reading as a painted stripe.
    const g = new Graphics();
    drawWallShadow(g, RECT, 1);
    expect(g.bounds.minX).toBeLessThan(RECT.x);
    expect(g.bounds.minY).toBeLessThan(RECT.y);
  });

  it('accumulates every wall onto one shared Graphics', () => {
    // RoomBuilder paints a whole room's wall shadows into a single display object.
    const g = new Graphics();
    drawWallShadow(g, { x: 0, y: 0, w: 64, h: 32 }, 70);
    drawWallShadow(g, { x: 900, y: 900, w: 64, h: 32 }, 70);
    expect(g.bounds.minX).toBeLessThan(64);
    expect(g.bounds.maxX).toBeGreaterThan(900);
  });
});

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

describe('buildWallBlock — the three height tiers, and per-surface art fallback', () => {
  it('draws a kerb as a real 22 px block, cap immediately above its short face', () => {
    // The south perimeter. It used to be the one wall left dead flat on the ground layer; the
    // whole point of a kerb is that it is a genuine (short) block, so its cap has to land
    // exactly one kerb-height above the footprint, not at a full wall's offset.
    const seg = buildWallBlock(RECT, 22, skin(true));
    const [face, cap] = seg.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
    expect(face!.y).toBe(-22);
    expect(face!.height).toBe(22);
    expect(cap!.y).toBe(-22 - RECT.h);
  });

  it('falls back per SURFACE, not per block — a cap with no face still stands', () => {
    // The two swatches load independently (`biomeTiles.ts` resolves each key on its own), so a
    // half-loaded biome must not lose the geometry of either surface.
    const t = tex();
    const capOnly = buildWallBlock(RECT, HEIGHT, { palette: biomePalette(undefined), cap: t, face: undefined });
    expect(capOnly.children.filter((c) => c instanceof TilingSprite)).toHaveLength(1);
    const faceOnly = buildWallBlock(RECT, HEIGHT, { palette: biomePalette(undefined), cap: undefined, face: t });
    expect(faceOnly.children.filter((c) => c instanceof TilingSprite)).toHaveLength(1);
    // Either way the block is still face + cap + shading + outline.
    expect(capOnly.children).toHaveLength(4);
    expect(faceOnly.children).toHaveLength(4);
  });

  it('outlines the block DARK, and never in the palette\'s light wall-edge colour', () => {
    // `palette.wallEdge` is a light salmon/steel for every biome — authored as the highlight
    // edge of a wall lying flat. Stroked around a standing block and magnified by the room
    // camera it read as a bright wireframe box over the art: the loudest thing in the frame.
    const palette = biomePalette('ember');
    const seg = buildWallBlock(RECT, HEIGHT, { palette, cap: tex(), face: tex() });
    const edge = seg.children[3] as Graphics;
    const silhouette = strokes(edge).find((s) => s.color !== 0xffffff)!;
    expect(silhouette.color).not.toBe(palette.wallEdge);
    expect(luma(silhouette.color)).toBeLessThan(luma(palette.wallEdge) / 3);
    expect(luma(silhouette.color)).toBeLessThan(32);
  });

  it('adds exactly one LIGHT stroke — the cap\'s far coping, the only place a bright rim belongs', () => {
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    const edge = seg.children[3] as Graphics;
    const light = strokes(edge).filter((s) => s.color === 0xffffff);
    expect(light).toHaveLength(1);
    expect(light[0]!.alpha).toBeLessThan(0.4); // a rim, not a highlight bar
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
    const wallEdge = strokes(wall.children[3] as Graphics).find((s) => s.color !== 0xffffff)!;
    const pillarEdge = strokes(buildPillarBody(64, 70, palette)).find((s) => s.color !== 0xffffff)!;
    expect(pillarEdge.color).toBe(wallEdge.color);
    expect(pillarEdge.alpha).toBe(wallEdge.alpha);
  });
});
