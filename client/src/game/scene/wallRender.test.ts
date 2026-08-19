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
import { buildWallBlock, drawBlockShading, drawWallShadow, sweptHull, type WallSkin } from './wallRender';
import { CAP_LIGHT, CAP_LIGHT_BLEND, CAP_TINT, EDGE_WIDTH, FACE_COPING_SUPPRESS, FACE_TINT } from './wallTone';
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

/** A multiply tint's factor, taken off its red channel (every tint here is near-neutral). */
function mulOf(tint: number): number {
  return ((tint >> 16) & 0xff) / 0xff;
}

/** Perceived brightness of a colour — for an additive overlay this IS how much it adds. */
function lumaOf(hex: number): number {
  return 0.299 * ((hex >> 16) & 0xff) + 0.587 * ((hex >> 8) & 0xff) + 0.114 * (hex & 0xff);
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

  it('puts the cap ABOVE the floor in value and the face below it — the measured hierarchy', () => {
    // The volume IS this ordering, and getting it backwards is what "像一张图贴在地上" measures
    // as: on 2026-08-19 a live frame had cap 44, floor 53, face 23, i.e. a surface raised 104 px
    // was DARKER than the ground under it. Tint alone cannot fix that (Pixi tints only multiply,
    // and both swatches sit near 46), so the cap takes an ADDITIVE key light — which means this
    // has to be asserted on the COMPOSITE. `SWATCH` is the shipped stone's own measured value and
    // `FLOOR` the shipped floor's.
    const SWATCH = 46;
    const FLOOR = 53;
    const capValue = SWATCH * mulOf(CAP_TINT) + lumaOf(CAP_LIGHT);
    const faceValue = SWATCH * mulOf(FACE_TINT);
    expect(capValue).toBeGreaterThan(FLOOR * 1.4); // a lit top plane, unmistakably raised
    expect(faceValue).toBeLessThan(FLOOR); // a vertical plane catches less than a horizontal one
    expect(capValue).toBeGreaterThan(faceValue * 2); // ...and the fold between them still reads
  });

  it('lights the cap ADDITIVELY, so the stone keeps its own contrast', () => {
    // A translucent white wash reaches the same value but is a lerp toward white, so it also
    // compresses the swatch's mortar-to-stone amplitude by its own alpha — and at play scale a
    // wall cap is nothing but that amplitude. The wash version measured on target and looked like
    // brushed concrete. An additive term adds a constant and leaves the range intact.
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    const lit = seg.children.filter((c): c is Graphics => c instanceof Graphics)
      .find((g) => g.blendMode === CAP_LIGHT_BLEND)!;
    expect(lit).toBeDefined();
    expect(lit.blendMode).toBe('add');
    // ...and it covers exactly the cap, never the face: an additive band over brick would wash
    // the one surface that has to stay the darker of the two.
    const cap = seg.children.filter((c): c is TilingSprite => c instanceof TilingSprite)[1]!;
    expect(lit.bounds.minY).toBeCloseTo(cap.y, 3);
    expect(lit.bounds.maxY).toBeCloseTo(cap.y + RECT.h, 3);
  });

  it("stops the face art's own coping course out-shining the cap above it", () => {
    // `wallface_<element>.png` is a whole elevation: a bright coping course at the top, brick
    // below, dark base at the bottom, used once at the wall's full height. Measured, that coping
    // lands at luma ~80 after FACE_TINT — as bright as the cap, so the wall's brightest band
    // ended up halfway down its FRONT and the fold stopped reading. A vertical surface cannot
    // out-shine the horizontal one it meets.
    const CODING_RAW = 230; // the swatch's own coping value, measured
    const suppressed = CODING_RAW * mulOf(FACE_TINT) * (1 - FACE_COPING_SUPPRESS);
    const capValue = 46 * mulOf(CAP_TINT) + lumaOf(CAP_LIGHT);
    expect(suppressed).toBeLessThan(capValue);
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
    // face fallback, cap fallback, additive cap light, shading, outline — all Graphics.
    expect(seg.children.filter((c) => c instanceof Graphics)).toHaveLength(5);
  });

  it('adds shading and an outline on top of the art, in that order', () => {
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    // face, cap (TilingSprites), then the additive cap light, the shading, and the silhouette.
    expect(seg.children).toHaveLength(5);
    expect(seg.children[2]).toBeInstanceOf(Graphics);
    expect(seg.children[3]).toBeInstanceOf(Graphics);
    expect(seg.children[4]).toBeInstanceOf(Graphics);
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
    // Half a stroke width of slack: the cap/face fold is a line ACROSS the block, so it is
    // centred on the edge and reaches EDGE_WIDTH/2 past it. Every fill stays strictly inside.
    expect(g.bounds.width).toBeLessThanOrEqual(stub.w + EDGE_WIDTH);
  });

  it('keeps all of its geometry inside the block\'s own footprint width', () => {
    // The east side band is INSET, not extruded, precisely so it can never cross into the
    // adjacent segment of the same perimeter run.
    const g = drawBlockShading(RECT, HEIGHT);
    expect(g.bounds.minX).toBeGreaterThanOrEqual(-EDGE_WIDTH / 2);
    expect(g.bounds.maxX).toBeLessThanOrEqual(RECT.w + EDGE_WIDTH / 2);
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

interface Instr {
  action: string;
  data: { style?: { color: number; alpha: number; width?: number }; path?: { instructions: Array<{ action: string; data: number[] }> } };
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
    // Either way the block is still face + cap + cap light + shading + outline.
    expect(capOnly.children).toHaveLength(5);
    expect(faceOnly.children).toHaveLength(5);
  });

  it('outlines the block DARK, and never in the palette\'s light wall-edge colour', () => {
    // `palette.wallEdge` is a light salmon/steel for every biome — authored as the highlight
    // edge of a wall lying flat. Stroked around a standing block and magnified by the room
    // camera it read as a bright wireframe box over the art: the loudest thing in the frame.
    const palette = biomePalette('ember');
    const seg = buildWallBlock(RECT, HEIGHT, { palette, cap: tex(), face: tex() });
    const edge = seg.children[4] as Graphics;
    const silhouette = strokes(edge).find((s) => s.color !== 0xffffff)!;
    expect(silhouette.color).not.toBe(palette.wallEdge);
    expect(luma(silhouette.color)).toBeLessThan(luma(palette.wallEdge) / 3);
    expect(luma(silhouette.color)).toBeLessThan(32);
  });

  it("adds LIGHT strokes only along the cap's two lit edges, never at the cap/face joint", () => {
    // North and west: the two edges of a top surface that turn toward an upper-left key light.
    // The joint where cap meets face gets the DARK fold line instead (`drawBlockShading`) — the
    // face art carries its own coping course there, and a second highlight on top of it read as
    // a stray bright bar.
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    const edge = seg.children[4] as Graphics;
    const light = strokes(edge).filter((s) => s.color === 0xffffff);
    expect(light).toHaveLength(2);
    for (const l of light) expect(l.alpha).toBeLessThan(0.4); // a rim, not a highlight bar
  });
});
