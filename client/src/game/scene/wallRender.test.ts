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
import type { Entity } from './Entity';
import { NO_JOINS, type WallJoins } from './wallRuns';
import {
  CAP_BOOST_ALPHA,
  CAP_BOOST_TINT,
  CAP_EDGE_PX,
  CAP_LIGHT_BLEND,
  CAP_TINT,
  EDGE_WIDTH,
  FACE_COPING_SUPPRESS,
  FACE_TINT,
  SIDE_CAP_SOLID_PX,
  SIDE_CAP_TAPER_PX,
  SIDE_COLOR,
  SIDE_STEPS,
  FACE_CROWN_FRACTION_MIN,
  TUCK_CAP_PX,
} from './wallTone';
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

/**
 * What a swatch value composites to on the cap: the surface layer (a multiply tint) plus the key
 * light, which is the SAME swatch again in `add` mode. That makes the lift MULTIPLICATIVE, which
 * is the whole point — see `CAP_BOOST_ALPHA`.
 */
function capComposite(swatch: number): number {
  return swatch * mulOf(CAP_TINT) * (1 + CAP_BOOST_ALPHA * (lumaOf(CAP_BOOST_TINT) / 0xff));
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
    expect(tiles).toHaveLength(3); // face, cap surface, cap key light (the swatch a second time)
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
    const capValue = capComposite(SWATCH);
    const faceValue = SWATCH * mulOf(FACE_TINT);
    expect(capValue).toBeGreaterThan(FLOOR * 1.4); // a lit top plane, unmistakably raised
    expect(faceValue).toBeLessThan(FLOOR); // a vertical plane catches less than a horizontal one
    expect(capValue).toBeGreaterThan(faceValue * 2); // ...and the fold between them still reads
  });

  it("lights the cap with the cap's OWN SWATCH, so the lift is multiplicative", () => {
    // The mechanism is the fix for *"那段墙体看起来很奇怪"*. A flat additive constant reaches the
    // target value and still ruins the stone, because contrast is perceived as a RATIO: +47 on a
    // 30..60 swatch is 77..107, i.e. 2:1 becomes 1.4:1, and the cap reads as pale concrete. The
    // same swatch drawn a second time in `add` mode multiplies instead, so the ratio survives.
    const seg = buildWallBlock(RECT, HEIGHT, skin(true));
    const tiles = seg.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
    const [, cap, lit] = tiles;
    expect(lit).toBeDefined();
    expect(lit!.blendMode).toBe(CAP_LIGHT_BLEND);
    expect(lit!.blendMode).toBe('add');
    // It is the cap swatch itself, at the cap's own geometry and tiling — not a flat fill.
    expect(lit!.texture).toBe(cap!.texture);
    expect(lit!.tilePosition.x).toBe(cap!.tilePosition.x);
    expect(lit!.tilePosition.y).toBe(cap!.tilePosition.y);
    // ...and it covers exactly the cap, never the face: an additive band over brick would wash
    // the one surface that has to stay the darker of the two.
    expect(lit!.y).toBeCloseTo(cap!.y, 3);
    expect(lit!.height).toBeCloseTo(RECT.h, 3);
  });

  it("preserves the swatch's CONTRAST RATIO, which a flat additive light cannot", () => {
    // The measured failure, stated as arithmetic. Mortar 30 / stone 60 on the shipped swatch: the
    // flat additive that shipped before this pass took the pair to 77/107 (1.39:1); the swatch
    // drawn again in `add` mode takes it to ~59/117, which is still 2:1 exactly.
    const MORTAR = 30;
    const STONE = 60;
    expect(capComposite(STONE) / capComposite(MORTAR)).toBeCloseTo(STONE / MORTAR, 6);
    const flatAdditive = (v: number) => v * mulOf(CAP_TINT) + 47;
    expect(flatAdditive(STONE) / flatAdditive(MORTAR)).toBeLessThan(1.5);
  });

  it('tiles the cap in WORLD space, so neighbouring blocks share one stone field', () => {
    // Per-block tile origins gave a 64 px-wide north-south run the swatch's same left quarter
    // every time (one large stone on ember — no legible pattern at all) and made an L corner's
    // two blocks meet at a mismatched seam. Both are the same one-line cause.
    //
    // Asserted as the PROPERTY rather than as a literal offset: for any block, the texture
    // coordinate under a given WORLD point must come out the same. That is what makes two blocks
    // agree, it survives the tuck clip moving the sprite, and it fails for a per-block origin.
    const capOf = (s: Entity) =>
      s.children.filter((c): c is TilingSprite => c instanceof TilingSprite)[1]!;
    /** Texture coordinate this block's cap samples at world (wx, wy). */
    const sampleAt = (rect: RectPx, h: number, j: WallJoins, wx: number, wy: number) => {
      const cap = capOf(buildWallBlock(rect, h, skin(true), j));
      const originY = cap.y + rect.y + rect.h; // the sprite's local (0,0) in world y
      return [wx - rect.x - cap.tilePosition.x, wy - originY - cap.tilePosition.y];
    };
    const EW: RectPx = { x: 1024, y: 32, w: 992, h: 32 };
    const NS: RectPx = { x: 1504, y: 64, w: 64, h: 224 };
    const probe = [1520, -20] as const;
    expect(sampleAt(EW, HEIGHT, NO_JOINS, ...probe))
      .toEqual(sampleAt(NS, HEIGHT, NO_JOINS, ...probe));
    // ...and a tucked run, whose cap sprite starts 104 px further south, still agrees.
    const tuckJoins: WallJoins = {
      ...NO_JOINS, north: [[0, 64]], tuckNorth: true,
      tuckLiftPx: HEIGHT * (1 - FACE_CROWN_FRACTION_MIN),
    };
    expect(sampleAt(NS, HEIGHT, tuckJoins, 1520, 100))
      .toEqual(sampleAt(NS, HEIGHT, NO_JOINS, 1520, 100));
  });

  it("stops the face art's own coping course out-shining the cap above it", () => {
    // `wallface_<element>.png` is a whole elevation: a bright coping course at the top, brick
    // below, dark base at the bottom, used once at the wall's full height. Measured, that coping
    // lands at luma ~80 after FACE_TINT — as bright as the cap, so the wall's brightest band
    // ended up halfway down its FRONT and the fold stopped reading. A vertical surface cannot
    // out-shine the horizontal one it meets.
    const CODING_RAW = 230; // the swatch's own coping value, measured
    const suppressed = CODING_RAW * mulOf(FACE_TINT) * (1 - FACE_COPING_SUPPRESS);
    const capValue = capComposite(46);
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
    // face, cap, the cap's additive key light (all TilingSprites), then shading and silhouette.
    expect(seg.children).toHaveLength(5);
    expect(seg.children[2]).toBeInstanceOf(TilingSprite);
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
    expect(capOnly.children.filter((c) => c instanceof TilingSprite)).toHaveLength(2); // cap + key light
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

/** Every rect fill in `g`, as `{x, y, w, h, color, alpha}` — the only way to read back what a
 *  Graphics actually drew, and the assertion class this file was missing for the side bands. */
function rectFills(g: Graphics): Array<{ x: number; y: number; w: number; h: number; color: number; alpha: number }> {
  return (g.context.instructions as Instr[])
    .filter((i) => i.action === 'fill')
    .flatMap((i) => {
      const style = i.data.style!;
      return (i.data.path?.instructions ?? [])
        .filter((p) => p.action === 'rect')
        .map((p) => ({
          x: p.data[0]!, y: p.data[1]!, w: p.data[2]!, h: p.data[3]!,
          color: style.color, alpha: style.alpha,
        }));
    });
}

describe('drawBlockShading — a north-south run is not an east-west wall with a deep cap', () => {
  // The user's report *"那段墙体看起来很奇怪"* pointed at level 1's west perimeter run: 64 px wide,
  // 224 px deep, height 104. Under `screen.y = gy - z` its cap IS the whole wall you can see, so
  // every constant that was tuned against a 32 px-deep east-west cap gets applied to a 224 px
  // field. These pin the two consequences that were visible in a 3x render.
  const RUN: RectPx = { x: 1504, y: 64, w: 64, h: 224 };
  const EW: RectPx = { x: 1024, y: 32, w: 992, h: 32 };
  const capTopOf = (r: RectPx, h: number) => -h - r.h;

  it('keeps the dark east band off the cap beyond one thickness plus its taper', () => {
    // The band is the block's east SIDE, and the projection stacks that side's cap and face rows
    // on each other — correct for an east-west wall's end, and a 13 px flat grey panel painted
    // down 224 px of stone for a north-south run. Bounded to the fold's neighbourhood instead.
    const g = drawBlockShading(RUN, HEIGHT);
    const eastBand = rectFills(g).filter((f) => f.color === SIDE_COLOR);
    expect(eastBand.length).toBeGreaterThan(0);
    const topMost = Math.min(...eastBand.map((f) => f.y));
    expect(topMost).toBeGreaterThan(capTopOf(RUN, HEIGHT)); // never reaches the cap's far edge
    expect(topMost).toBeCloseTo(-HEIGHT - SIDE_CAP_SOLID_PX - SIDE_CAP_TAPER_PX, 3);
    // ...and what does reach onto the cap fades, rather than stopping at a hard horizontal cut.
    const onCap = eastBand.filter((f) => f.y < -HEIGHT - SIDE_CAP_SOLID_PX + 0.001);
    const strongest = Math.max(...onCap.map((f) => f.alpha));
    const faintest = Math.min(...onCap.map((f) => f.alpha));
    expect(faintest).toBeLessThan(strongest / 2);
  });

  it('leaves an east-west wall — whose whole cap IS one thickness — at full strength', () => {
    // The bound must not quietly re-tune the case the numbers were measured on.
    const g = drawBlockShading(EW, HEIGHT);
    const eastBand = rectFills(g).filter((f) => f.color === SIDE_COLOR);
    const topMost = Math.min(...eastBand.map((f) => f.y));
    expect(topMost).toBeCloseTo(capTopOf(EW, HEIGHT), 3); // the full art height, as before
    const alphas = new Set(eastBand.map((f) => f.alpha));
    expect(alphas.size).toBe(SIDE_STEPS); // one alpha per across-the-width step, no length taper
  });

  it('bevels the cap\'s long edges along their FULL depth instead', () => {
    // What replaces the panel: the crease where a top surface turns down into a side plane this
    // projection draws at zero width. Narrow, on BOTH sides, and — unlike the band — running the
    // whole length, because that is what keeps a 224 px ribbon reading as a raised mass.
    const g = drawBlockShading(RUN, HEIGHT);
    const capTop = capTopOf(RUN, HEIGHT);
    const bevels = rectFills(g).filter((f) => f.y === capTop && f.h === RUN.h);
    expect(bevels.length).toBeGreaterThan(0);
    const west = bevels.filter((f) => f.x < RUN.w / 2);
    const east = bevels.filter((f) => f.x >= RUN.w / 2);
    expect(west.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);
    // Narrow: a bevel, not a band. And the east side, turned away from the key light, is darker.
    const span = (fs: typeof bevels) => Math.max(...fs.map((f) => f.x + f.w)) - Math.min(...fs.map((f) => f.x));
    expect(span(east)).toBeLessThanOrEqual(CAP_EDGE_PX);
    expect(span(west)).toBeLessThanOrEqual(CAP_EDGE_PX);
    expect(Math.max(...east.map((f) => f.alpha))).toBeGreaterThan(Math.max(...west.map((f) => f.alpha)));
  });
});

describe('buildWallBlock — an L corner is two blocks that must not both announce an edge', () => {
  // Second report on the same wall: *"竖着的墙，直接盖在了横着的墙上面"*. For those x the mass really
  // is solid from the far wall's north edge to the near run's south edge, so ONE continuous top
  // ribbon is correct and the geometry was never wrong. What was wrong is that both blocks drew
  // their edge cues in the middle of it — measured as a 66 -> 79 luma step with a highlight line
  // on top of it.
  const NS: RectPx = { x: 1504, y: 64, w: 64, h: 224 };
  const buried: WallJoins = { ...NO_JOINS, north: [[0, 64]] };

  it('drops the cap\'s lit coping where its north edge is buried in the corner', () => {
    const open = buildWallBlock(NS, HEIGHT, skin(true), NO_JOINS);
    const joined = buildWallBlock(NS, HEIGHT, skin(true), buried);
    const white = (s: Entity) => strokes(s.children[4] as Graphics).filter((k) => k.color === 0xffffff);
    expect(white(open)).toHaveLength(2); // north edge + west edge
    expect(white(joined)).toHaveLength(1); // west edge only — nothing can light a buried edge
  });

  it('masks the cap depth gradient out of a buried SOUTH edge', () => {
    // The east-west wall's side of the same corner. Its 32 px cap was shaded 0 -> CAP_GRADIENT_MAX
    // toward a fold that, for those x, does not exist: the corner carries straight on through it.
    const EW: RectPx = { x: 1024, y: 32, w: 992, h: 32 };
    const open = drawBlockShading(EW, HEIGHT, NO_JOINS);
    const joined = drawBlockShading(EW, HEIGHT, { ...NO_JOINS, south: [[480, 544]] });
    const capRow = (g: Graphics) =>
      rectFills(g).filter((f) => f.color === 0x000000 && f.y < -HEIGHT && f.h < EW.h);
    // Same bands, but each is now split around the join instead of spanning the full width.
    const widest = (g: Graphics) => Math.max(...capRow(g).map((f) => f.w));
    expect(widest(open)).toBeCloseTo(EW.w, 3);
    expect(widest(joined)).toBeCloseTo(480, 3);
    expect(capRow(joined).some((f) => f.x >= 544)).toBe(true); // and the far side still gets it
    expect(capRow(joined).every((f) => f.x + f.w <= 480 + 0.001 || f.x >= 544 - 0.001)).toBe(true);
  });

  it('creases the far wall\'s FACE where the corner stands against it', () => {
    // The cue that replaces the false edges: after they were gone, a hard stone/brick boundary
    // with nothing to say which side is nearer was the last thing reading as "pasted on". Under
    // an upper-left key light the down-light (east) side of the contact is the darker one.
    const EW: RectPx = { x: 1024, y: 32, w: 992, h: 32 };
    const joined = drawBlockShading(EW, HEIGHT, { ...NO_JOINS, south: [[480, 544]] });
    const faceCrease = rectFills(joined).filter((f) => f.y === -HEIGHT && f.h === HEIGHT);
    expect(faceCrease.length).toBeGreaterThan(0);
    const east = faceCrease.filter((f) => f.x >= 544);
    const west = faceCrease.filter((f) => f.x + f.w <= 480 + 0.001);
    expect(east.length).toBeGreaterThan(0);
    expect(west.length).toBeGreaterThan(0);
    expect(Math.max(...east.map((f) => f.alpha))).toBeGreaterThan(Math.max(...west.map((f) => f.alpha)));
    // Strongest at the contact, fading outward — a crease, not a panel.
    const nearest = east.reduce((m, f) => (f.x < m.x ? f : m), east[0]!);
    const furthest = east.reduce((m, f) => (f.x > m.x ? f : m), east[0]!);
    expect(nearest.alpha).toBeGreaterThan(furthest.alpha);
  });

  it('keeps the corner crease INSET, so it cannot paint over the next block along a run', () => {
    // Same rule the east side band follows. A join flush with the block's own end would otherwise
    // ramp straight into its neighbour.
    const EW: RectPx = { x: 1024, y: 32, w: 992, h: 32 };
    const flush = drawBlockShading(EW, HEIGHT, { ...NO_JOINS, south: [[0, 64]] });
    expect(flush.bounds.minX).toBeGreaterThanOrEqual(-EDGE_WIDTH / 2);
    expect(flush.bounds.maxX).toBeLessThanOrEqual(EW.w + EDGE_WIDTH / 2);
  });
});

describe('buildWallBlock — a deep run TUCKS behind the wall it runs into', () => {
  // Third report on the same wall: *"中间的墙体处理的很好，但是上面那段就不对了。我觉得应该是中间的
  // 墙要看起来到横着的墙的底部，然后相交的部分进行立体化处理"*. A block's art intrudes one wall HEIGHT
  // north of its own footprint, so a deep north-south run climbs the far wall's brick face and
  // interrupts the surface the eye reads as the room's back wall. A tucked run stops at its own
  // footprint edge instead. Deliberate stylisation, not a correction — see `WallJoins`.
  const NS: RectPx = { x: 1504, y: 64, w: 64, h: 224 };
  const EW: RectPx = { x: 1024, y: 32, w: 992, h: 32 };
  const CROWN = FACE_CROWN_FRACTION_MIN;
  const LIFT = HEIGHT * (1 - CROWN); // the far wall's height less its crown course
  const tucked: WallJoins =
    { ...NO_JOINS, north: [[0, 64]], tuckNorth: true, tuckLiftPx: LIFT, crownFraction: CROWN };
  const capOf = (s: Entity) =>
    s.children.filter((c): c is TilingSprite => c instanceof TilingSprite)[1]!;

  it('clips the cap to stop just under the far wall\'s CROWN course', () => {
    const open = capOf(buildWallBlock(NS, HEIGHT, skin(true), NO_JOINS));
    const tuck = capOf(buildWallBlock(NS, HEIGHT, skin(true), tucked));
    expect(open.y).toBe(-HEIGHT - NS.h); // ...reaching a full wall height north of the footprint
    expect(tuck.y).toBeCloseTo(-NS.h - LIFT, 3); // ...stopping under the crown instead
    // Which is strictly between the two rejected answers: the full overlap, and the wall's foot.
    expect(tuck.y).toBeGreaterThan(open.y); // covers less than the whole face...
    expect(tuck.y).toBeLessThan(-NS.h); // ...but still covers the brick below the crown
    // ...so its visible cap depth lands between the two: deeper than the foot clip, shallower than
    // the footprint's own depth.
    expect(tuck.height).toBeGreaterThan(NS.h - HEIGHT);
    expect(tuck.height).toBeLessThan(NS.h);
    // The fold is untouched either way: only the cap's FAR edge moves.
    expect(open.y + open.height).toBe(-HEIGHT);
    expect(tuck.y + tuck.height).toBeCloseTo(-HEIGHT, 3);
  });

  it('leaves exactly the crown course of the far wall showing above it', () => {
    // The whole point, stated as the two numbers that have to agree: the run's clipped top and the
    // underside of the crown are the SAME world line. `r.y` is the shared edge.
    const tuck = capOf(buildWallBlock(NS, HEIGHT, skin(true), tucked));
    const runTopWorld = tuck.y + NS.y + NS.h;
    const crownUndersideWorld = NS.y - HEIGHT + HEIGHT * CROWN;
    expect(runTopWorld).toBeCloseTo(crownUndersideWorld, 3);
  });

  it('creases the clipped edge, so the cap does not just stop dead at the brick', () => {
    const shading = drawBlockShading(NS, HEIGHT, tucked);
    const capTop = -NS.h - LIFT;
    const crease = rectFills(shading).filter((f) => f.w === NS.w && f.y >= capTop && f.y < capTop + TUCK_CAP_PX);
    expect(crease.length).toBeGreaterThan(0);
    // Darkest against the wall, fading south — an inside corner, not a band.
    const nearest = crease.reduce((m, f) => (f.y < m.y ? f : m), crease[0]!);
    const furthest = crease.reduce((m, f) => (f.y > m.y ? f : m), crease[0]!);
    expect(nearest.alpha).toBeGreaterThan(furthest.alpha);
    expect(drawBlockShading(NS, HEIGHT, NO_JOINS).context.instructions.length)
      .toBeLessThan(shading.context.instructions.length);
  });

  it('creases the far wall\'s CROWN, the only band of it the run does not cover', () => {
    // Every brick course below the crown is behind the run's own cap now, so this crease belongs on
    // the crown and nowhere else — which is also the only band bright enough for it to show. A
    // previous round spread it over the whole face and measured 9 vs 13 at the base: present in the
    // arithmetic, invisible on brick that `BASE_AO_*` had already crushed.
    const crownH = HEIGHT * CROWN;
    const g = drawBlockShading(EW, HEIGHT, { ...NO_JOINS, tuckedSouth: [[480, 544]] });
    const onCrown = rectFills(g).filter((f) => f.x > 400 && f.x < 700 && f.y >= -HEIGHT - 0.001);
    expect(onCrown.length).toBeGreaterThan(0);
    // Confined to the crown: nothing reaches down into the brick courses.
    expect(Math.max(...onCrown.map((f) => f.y + f.h))).toBeLessThanOrEqual(-HEIGHT + crownH + 0.001);
    const top = onCrown.reduce((m, f) => (f.y < m.y ? f : m), onCrown[0]!);
    const bottom = onCrown.reduce((m, f) => (f.y > m.y ? f : m), onCrown[0]!);
    expect(bottom.alpha).toBeGreaterThan(top.alpha); // darkest at the crown's underside
    expect(Math.min(...onCrown.map((f) => f.x))).toBeLessThan(480); // spills past the run's width
    expect(Math.max(...onCrown.map((f) => f.x + f.w))).toBeGreaterThan(544);
  });

  it('does NOT mask that wall\'s fold or gradient, because the run stops short of it', () => {
    // The opposite of the merged corner. A tucked neighbour leaves this block's fold exposed, so
    // masking it would delete a real edge — which is why `wallJoins` sorts a join into `south` or
    // `tuckedSouth` and never both.
    const merged = drawBlockShading(EW, HEIGHT, { ...NO_JOINS, south: [[480, 544]] });
    const tuckedNbr = drawBlockShading(EW, HEIGHT, { ...NO_JOINS, tuckedSouth: [[480, 544]] });
    const capBands = (g: Graphics) =>
      rectFills(g).filter((f) => f.color === 0x000000 && f.y < -HEIGHT && f.h < EW.h);
    expect(Math.max(...capBands(merged).map((f) => f.w))).toBeCloseTo(480, 3);
    expect(Math.max(...capBands(tuckedNbr).map((f) => f.w))).toBeCloseTo(EW.w, 3);
  });

  it('never lets a SHALLOW block tuck, or a stacked pair would leave a hole', () => {
    // Two parallel east-west walls (32 deep, 104 tall) are one mass whose top is drawn by the
    // northern one's cap; the southern one's art has to keep reaching north of its own footprint.
    // `wallJoins` refuses the tuck there, and the clip would be nonsense if it did not — this pins
    // the arithmetic that makes it nonsense.
    expect(EW.h).toBeLessThan(HEIGHT);
    expect(NS.h).toBeGreaterThan(HEIGHT);
  });
});
