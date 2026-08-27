/**
 * `wallVoidReturn` — the stone a block shows where its east/west side ends at nothing.
 *
 * Same approach as `wallRender.test.ts`: Pixi will not hand back the geometry it drew, so
 * what is asserted is what a regression would actually break — which children appear, where
 * they land in the block's own local space, the tints that carry the light direction, and the
 * ramp's own anchoring (readable through `readRampFill`).
 *
 * The mapping from FOOTPRINT-local y to the block's own local y is the part worth pinning:
 * the cap shows the footprint lifted by one wall height, and a span that reaches the
 * footprint's south edge carries on down the face while one that stops short ends at the
 * fold. Getting that backwards would paint a return beside the wrong stone, which is
 * invisible in a screenshot of the case it happens to get right.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, TilingSprite, Texture, TextureSource } from 'pixi.js';
import { Entity } from './Entity';
import { addVoidReturns, type ReturnSkin } from './wallVoidReturn';
import { NO_VOID_EDGES, type VoidEdges } from './wallVoidEdge';
import { buildWallBlock } from './wallRender';
import { XRAY_LABEL } from './occlusion';
import { rampProfile, readRampFill, resetShadeRampCache, shadeRampCacheSize } from '../../render/shadeRamp';
import { biomePalette } from '../theme';
import type { RectPx } from './wallGeometry';
import {
  CAP_TINT,
  COPING_ALPHA,
  FACE_TINT,
  LIT_EDGE_COLOR,
  VOID_CROWN_ALPHA,
  VOID_FALLOFF_POWER,
  VOID_RETURN_PX,
  VOID_RETURN_TINT_EAST,
  VOID_RETURN_TINT_WEST,
} from './wallTone';

/** A north-south perimeter run: the shape that borders an empty slot on `arena_launch`. */
const RECT: RectPx = { x: 2240, y: 480, w: 32, h: 224 };
const HEIGHT = 104;
const CAP_TOP = -HEIGHT - RECT.h;

function tex(): Texture {
  return new Texture({ source: new TextureSource({ width: 16, height: 64 }) });
}
function skin(withArt = true): ReturnSkin {
  return { palette: biomePalette(undefined), cap: withArt ? tex() : undefined };
}
function build(voids: VoidEdges, capTop = CAP_TOP, s: ReturnSkin = skin()): Entity {
  const seg = new Entity();
  addVoidReturns(seg, RECT, HEIGHT, capTop, voids, s);
  return seg;
}
const tiles = (seg: Entity): TilingSprite[] =>
  seg.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
const graphics = (seg: Entity): Graphics[] =>
  seg.children.filter((c): c is Graphics => c instanceof Graphics);
type Instr = { action: string; data: { style?: { color?: number; alpha?: number }; path?: unknown } };
const instrs = (g: Graphics): Instr[] => g.context.instructions as unknown as Instr[];

/** An unbounded void — the map's own outer silhouette, and every empty slot on `arena_launch`
 *  (its narrowest is 288 px, far past anything the reach clamp would bite on). */
const OPEN = Infinity;
const WHOLE_EAST: VoidEdges = { east: [{ from: 0, to: RECT.h, gap: OPEN }], west: [] };
const WHOLE_WEST: VoidEdges = { east: [], west: [{ from: 0, to: RECT.h, gap: OPEN }] };

describe('addVoidReturns', () => {
  it('draws nothing at all when no side is free', () => {
    // The common case by a wide margin — every interior block and every shared boundary. It
    // has to cost nothing, not an empty Graphics per block.
    expect(build(NO_VOID_EDGES).children).toHaveLength(0);
  });

  it('carries the CAP swatch past the east edge, in the same world tiling', () => {
    const seg = build(WHOLE_EAST);
    const [tile] = tiles(seg);
    expect(tile!.x).toBe(RECT.w);
    expect(tile!.y).toBe(CAP_TOP);
    expect(tile!.width).toBe(VOID_RETURN_PX);
    expect(tile!.height).toBe(-CAP_TOP); // cap top down to the face's base
    expect(tile!.tint).toBe(VOID_RETURN_TINT_EAST);
    // World-anchored exactly as `wallRender.capTile` is, so the mortar runs straight on over
    // the arris rather than restarting — the continuity is most of what sells the surface.
    expect(tile!.tilePosition.x).toBe(-(RECT.x + RECT.w));
    expect(tile!.tilePosition.y).toBe(-(CAP_TOP + RECT.y + RECT.h));
  });

  it('mirrors to the west, and lights it as the side facing the key light', () => {
    const seg = build(WHOLE_WEST);
    const [tile] = tiles(seg);
    expect(tile!.x).toBe(-VOID_RETURN_PX);
    expect(tile!.tilePosition.x).toBe(-(RECT.x - VOID_RETURN_PX));
    expect(tile!.tint).toBe(VOID_RETURN_TINT_WEST);
    // Upper-left key light: the west side is turned toward it, the east away from it.
    const red = (t: number) => (t >> 16) & 0xff;
    expect(red(VOID_RETURN_TINT_WEST)).toBeGreaterThan(red(VOID_RETURN_TINT_EAST));
  });

  it('falls to the backdrop with a SQUARED ramp anchored at the arris', () => {
    const g = graphics(build(WHOLE_EAST))[0]!;
    const fill = instrs(g).find((i) => i.action === 'fill')!;
    const read = readRampFill((fill.data as { style?: unknown }).style)!;
    expect(read.x0).toBeCloseTo(RECT.w, 6); // nothing at the arris...
    expect(read.x1).toBeCloseTo(RECT.w + VOID_RETURN_PX, 6); // ...full black at the outer edge
    expect(read.color).toBe(0x000000);
    const profile = rampProfile(read.texture);
    expect(profile[profile.length - 1]).toBeCloseTo(1, 2);
    // The whole reason it is not linear: at the midpoint a linear ramp is already half gone.
    const mid = profile[Math.floor(profile.length / 2)]!;
    expect(mid).toBeCloseTo(0.5 ** VOID_FALLOFF_POWER, 2);
    expect(mid).toBeLessThan(0.35);
  });

  it('runs the west ramp the other way, from its own arris outward', () => {
    const read = readRampFill(
      (instrs(graphics(build(WHOLE_WEST))[0]!).find((i) => i.action === 'fill')!.data as { style?: unknown }).style,
    )!;
    expect(read.x0).toBeCloseTo(0, 6);
    expect(read.x1).toBeCloseTo(-VOID_RETURN_PX, 6);
  });

  it('creases the EAST arris only — the west already has its coping', () => {
    const east = instrs(graphics(build(WHOLE_EAST))[0]!).filter((i) => i.action === 'stroke');
    expect(east).toHaveLength(1);
    expect(east[0]!.data.style?.color).toBe(LIT_EDGE_COLOR);
    expect(east[0]!.data.style?.alpha).toBe(VOID_CROWN_ALPHA);
    expect(instrs(graphics(build(WHOLE_WEST))[0]!).filter((i) => i.action === 'stroke')).toHaveLength(0);
  });

  it('carries a span that reaches the footprint\'s south edge on down the FACE', () => {
    const tile = tiles(build(WHOLE_EAST))[0]!;
    expect(tile.y + tile.height).toBe(0); // the face's own base
  });

  it('stops a span that does not reach the south edge at the fold', () => {
    // The "end head" shape: an east-west run whose east side is void only over its northern
    // part. Its return must not reach down the face, because the face is south of the
    // neighbour that covers the rest of the side.
    const half: VoidEdges = { east: [{ from: 0, to: RECT.h / 2, gap: OPEN }], west: [] };
    const tile = tiles(build(half))[0]!;
    expect(tile.y).toBe(CAP_TOP);
    expect(tile.y + tile.height).toBe(-HEIGHT - RECT.h / 2);
  });

  it('maps a span that starts partway down the footprint', () => {
    const lower: VoidEdges = { east: [{ from: 64, to: RECT.h, gap: OPEN }], west: [] };
    const tile = tiles(build(lower))[0]!;
    expect(tile.y).toBe(-HEIGHT - (RECT.h - 64));
    expect(tile.y + tile.height).toBe(0);
  });

  it('never reaches above a clipped cap', () => {
    // A tucked or door-clipped run's cap stops short (`blockCapTop`); its return has to stop
    // with it rather than hang in the air over the wall it tucks under.
    const clipped = -HEIGHT - 40;
    const tile = tiles(build(WHOLE_EAST, clipped))[0]!;
    expect(tile.y).toBe(clipped);
  });

  it('drops a span the clip has swallowed entirely', () => {
    const span: VoidEdges = { east: [{ from: 0, to: 20, gap: OPEN }], west: [] };
    expect(build(span, -HEIGHT - 40).children).toHaveLength(0);
  });

  it('falls back to a flat palette fill with no swatch, as every other surface here does', () => {
    const seg = build(WHOLE_EAST, CAP_TOP, skin(false));
    expect(tiles(seg)).toHaveLength(0);
    const colors = instrs(graphics(seg)[0]!)
      .filter((i) => i.action === 'fill')
      .map((i) => i.data.style?.color);
    expect(colors).toContain(biomePalette(undefined).wall);
  });

  it('takes at most HALF a bounded void, so two facing returns can only meet', () => {
    // The wall on the far side of the same gap is reaching inward across it. `ember_l1` floor 2's
    // narrowest void is 32 px — exactly twice `VOID_RETURN_PX` — so shipped content sits ON the
    // limit with nothing to spare, and this clamp is what keeps the next authored room from
    // overlapping silently (`wallComposition.test.ts` pins both halves of that).
    const tight: VoidEdges = { east: [{ from: 0, to: RECT.h, gap: 20 }], west: [] };
    expect(tiles(build(tight))[0]!.width).toBe(10);
    const roomy: VoidEdges = { east: [{ from: 0, to: RECT.h, gap: 2 * VOID_RETURN_PX }], west: [] };
    expect(tiles(build(roomy))[0]!.width).toBe(VOID_RETURN_PX);
  });

  it('clamps the west return\'s ORIGIN with its width, not just its width', () => {
    // A west return is positioned at `-reach`; clamping only the width would leave it starting
    // 16 px out and ending 6 px short of its own arris, i.e. a floating strip.
    const tight: VoidEdges = { east: [], west: [{ from: 0, to: RECT.h, gap: 20 }] };
    const tile = tiles(build(tight))[0]!;
    expect(tile.x).toBe(-10);
    expect(tile.x + tile.width).toBe(0);
    const read = readRampFill(
      (instrs(graphics(build(tight))[0]!).find((i) => i.action === 'fill')!.data as { style?: unknown }).style,
    )!;
    expect(read.x1).toBeCloseTo(-10, 6); // ...and the ramp is clamped with it
  });

  it('lights the arris, and weaker than the coping the west side already has', () => {
    // Gated as a RELATIONSHIP rather than transcribed: the alpha has to be visible at all (0 is
    // the state this pass started from, where the east edge was dark-on-dark and read as no edge)
    // and has to stay under the west coping's, because this arris faces AWAY from the key light.
    expect(VOID_CROWN_ALPHA).toBeGreaterThan(0.05);
    expect(VOID_CROWN_ALPHA).toBeLessThan(COPING_ALPHA);
    const stroke = instrs(graphics(build(WHOLE_EAST))[0]!).find((i) => i.action === 'stroke')!;
    expect(stroke.data.style?.alpha).toBe(VOID_CROWN_ALPHA);
  });

  it('brackets its two tints against the surfaces they are argued from', () => {
    // `VOID_RETURN_TINT_*`'s doc derives both numbers from surfaces that already exist rather
    // than from taste: a cap facing straight up takes the swatch unmodified, any vertical
    // surface takes `FACE_TINT`, so a WEST return (turned toward the upper-left key) sits
    // between them and an EAST one (turned away) sits below both. That is a claim in a comment,
    // and a comment cannot fail — this is the guard for it, so a retune that inverts the light
    // has to change the argument too.
    const mul = (t: number) => ((t >> 16) & 0xff) / 0xff;
    expect(mul(VOID_RETURN_TINT_EAST)).toBeLessThan(mul(FACE_TINT));
    expect(mul(FACE_TINT)).toBeLessThan(mul(VOID_RETURN_TINT_WEST));
    expect(mul(VOID_RETURN_TINT_WEST)).toBeLessThan(mul(CAP_TINT));
  });

  it('draws one return per SPAN, not one per side', () => {
    // `voidEdges` splits a side wherever a neighbour interrupts it, and a run really can look out
    // on two different voids (`wallVoidEdge.test.ts`'s "measured per SPAN"). A loop that stopped
    // at the first would leave the second stretch of that side as the bare cliff this whole pass
    // exists to remove, on a block that LOOKS handled.
    const two: VoidEdges = {
      east: [{ from: 0, to: 64, gap: OPEN }, { from: 128, to: RECT.h, gap: OPEN }],
      west: [],
    };
    const seg = build(two);
    const t = tiles(seg);
    expect(t).toHaveLength(2);
    expect(t.map((x) => x.y)).toEqual([CAP_TOP, -HEIGHT - (RECT.h - 128)]);
    // ...and both are creased, on ONE shared Graphics rather than one per span.
    expect(graphics(seg)).toHaveLength(1);
    expect(instrs(graphics(seg)[0]!).filter((i) => i.action === 'stroke')).toHaveLength(2);
    expect(instrs(graphics(seg)[0]!).filter((i) => i.action === 'fill')).toHaveLength(2);
  });

  it('bakes ONE ramp for every return, whatever its reach, span or height', () => {
    // `arenaWallCoverage.test.ts` asserts the cache holds exactly one bake across all 83 of the
    // launch map's returns — and that assertion is contingent on CONTENT: every shipped reach is
    // the full `VOID_RETURN_PX`, because no shipped void is narrow enough to clamp. A key that
    // folded in the reach would therefore pass there and fragment the batch the day a map
    // authors a tight gap (a mutant doing exactly that survived the first battery). So the
    // property is gated here instead, on blocks built to DISAGREE about all three inputs.
    resetShadeRampCache();
    const cases: VoidEdges[] = [
      { east: [{ from: 0, to: RECT.h, gap: OPEN }], west: [] },
      { east: [{ from: 0, to: RECT.h, gap: 20 }], west: [] }, // clamped: reach 10
      { east: [{ from: 0, to: 64, gap: 9 }], west: [] }, // clamped harder, shorter span
      { east: [], west: [{ from: 32, to: RECT.h, gap: 33 }] },
    ];
    const reaches = new Set<number>();
    for (const [i, v] of cases.entries()) {
      const seg = new Entity();
      addVoidReturns(seg, RECT, HEIGHT + i * 7, CAP_TOP - i * 11, v, skin());
      reaches.add(tiles(seg)[0]!.width);
    }
    expect(reaches.size, 'the fixture has to actually vary the reach').toBeGreaterThan(2);
    expect(shadeRampCacheSize()).toBe(1);
  });

  it('tags everything it adds with the CAP\'s x-ray group', () => {
    // A block the occlusion x-ray is fading has to fade whole: a solid return beside a
    // dissolved cap reads as a second object standing there.
    const seg = build({
      east: [{ from: 0, to: RECT.h, gap: OPEN }],
      west: [{ from: 0, to: RECT.h, gap: OPEN }],
    });
    expect(seg.children.length).toBeGreaterThan(0);
    for (const c of seg.children) expect(c.label).toBe(XRAY_LABEL);
  });
});

describe('buildWallBlock wiring', () => {
  it('adds the return AFTER the silhouette, so the arris paints over it', () => {
    // Order is the whole reason this is not part of `drawBlockShading`: `addBlockEdge`'s dark
    // stroke is centred on the block's own edge, and the arris highlight belongs on top of it.
    const s = { palette: biomePalette(undefined), cap: tex(), face: tex() };
    const plain = buildWallBlock(RECT, HEIGHT, s);
    const withVoid = buildWallBlock(RECT, HEIGHT, s, undefined, WHOLE_EAST);
    expect(withVoid.children.length).toBe(plain.children.length + 2); // surface + falloff/arris
    expect(withVoid.children.slice(0, plain.children.length).map((c) => c.constructor.name)).toEqual(
      plain.children.map((c) => c.constructor.name),
    );
    expect(withVoid.children[withVoid.children.length - 1]).toBeInstanceOf(Graphics);
  });

  it('defaults to no return, so every caller without a floor model is unchanged', () => {
    const s = { palette: biomePalette(undefined), cap: tex(), face: tex() };
    expect(buildWallBlock(RECT, HEIGHT, s).children).toHaveLength(
      buildWallBlock(RECT, HEIGHT, s, undefined, NO_VOID_EDGES).children.length,
    );
  });
});
