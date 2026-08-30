/**
 * The wall AND door cap as they are actually composed IN A BROWSER (2026-08-24 draw-call pass).
 *
 * `wallRender.test.ts` and `doorRender.test.ts` run headless, where `capLight.bakeLitCap` has no 2D
 * canvas and returns undefined — so every composition assertion over there is describing the
 * FALLBACK, two-TilingSprite path. That is the branch nobody ships. This file mocks the bake so the
 * shipped one-sprite composition is under test too, which is the point: the reason the additive
 * copy was removed is that it cut Pixi's sprite batch once per wall run, and a test suite that only
 * ever sees the unbaked path would go green with the additive layer quietly back in place.
 *
 * Both callers of `addCapLayers` are covered here rather than in one file each, because the sharing
 * IS the thing worth pinning: `doorRender.buildDoorBlock` borrows the wall's cap so a doorway's stone
 * reads as the same quarry as the runs either side of it, and a change made to only one of them is
 * exactly the regression that produces a visible seam at every opening.
 */
import { describe, it, expect, vi } from 'vitest';
import { Graphics, Texture, TextureSource, TilingSprite } from 'pixi.js';

const LIT = new Texture({ source: new TextureSource({ width: 16, height: 16 }) });
vi.mock('./capLight', () => ({ bakeLitCap: () => LIT }));

const { buildWallBlock } = await import('./wallRender');
const { blockCapTop } = await import('./wallRuns');
const { XRAY_LABEL } = await import('./occlusion');
const { CAP_LIGHT_BLEND, CAP_TINT } = await import('./wallTone');
const { biomePalette } = await import('../theme');
const { buildDoorBlock } = await import('./doorRender');
const { WALL_H_PERIMETER } = await import('./wallGeometry');
type RectPx = import('./wallGeometry').RectPx;

const RECT: RectPx = { x: 320, y: 640, w: 480, h: 32 };
const HEIGHT = 104;
const swatch = (): Texture => new Texture({ source: new TextureSource({ width: 16, height: 64 }) });
const skin = () => ({ palette: biomePalette(undefined), cap: swatch(), face: swatch() });

describe('buildWallBlock with the cap key light baked in', () => {
  it('draws the cap ONCE, from the baked texture, with no blend mode anywhere in the block', () => {
    const seg = buildWallBlock(RECT, HEIGHT, skin());
    const tiles = seg.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
    expect(tiles).toHaveLength(3); // the face in two pieces, and ONE cap — not two
    const caps = tiles.filter((t) => t.texture === LIT);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.blendMode).not.toBe(CAP_LIGHT_BLEND);
    for (const c of seg.children) expect(c.blendMode).not.toBe(CAP_LIGHT_BLEND);
    // Face (in its two pieces) + cap + shading + silhouette. There used to be a fifth child here,
    // the additive copy of the cap, before the bake folded it into the texture.
    expect(seg.children).toHaveLength(5);
  });

  it('leaves the cap at full alpha and full tint — the lift is in the texture now', () => {
    // A bake plus a surviving CAP_BOOST_ALPHA on the sprite would double-dim the whole cap, and a
    // bake plus a surviving boost TINT would double-warm it. Both are silent at play scale.
    const cap = buildWallBlock(RECT, HEIGHT, skin())
      .children.filter((c): c is TilingSprite => c instanceof TilingSprite)
      .find((t) => t.texture === LIT)!;
    expect(cap.alpha).toBe(1);
    expect(cap.tint).toBe(CAP_TINT);
  });

  it('still tags the single cap layer for the occlusion x-ray, at the cap top', () => {
    // `occlusion.xrayLayers` fades by LABEL, so dropping a layer must not drop the tag with it —
    // otherwise a character standing behind this wall stops being visible through it.
    const seg = buildWallBlock(RECT, HEIGHT, skin());
    const tagged = seg.children.filter((c) => c.label === XRAY_LABEL);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]!.y).toBeCloseTo(blockCapTop(RECT, HEIGHT), 6);
  });

  it('keeps the cap tiled in WORLD space, so neighbouring runs share one stone field', () => {
    // The reason `capTile` sets `tilePosition` at all (see its doc): per-block origins made an L
    // corner meet at a mismatched seam. Swapping the texture must not lose it.
    const seg = buildWallBlock(RECT, HEIGHT, skin());
    const cap = seg.children.filter((c): c is TilingSprite => c instanceof TilingSprite).find((t) => t.texture === LIT)!;
    expect(cap.tilePosition.x).toBe(-RECT.x);
    expect(cap.tilePosition.y).toBe(-(blockCapTop(RECT, HEIGHT) + RECT.y + RECT.h));
  });
});

describe('buildDoorBlock — the other caller of addCapLayers gets the same bake', () => {
  const PASSAGE: RectPx = { x: 256, y: 512, w: 128, h: 32 };
  const doorSkin = () => ({
    palette: biomePalette('ember'),
    cap: swatch(),
    face: swatch(),
    floor: undefined,
    curtain: undefined,
    leaf: new Texture({ source: new TextureSource({ width: 147, height: 217 }) }),
  });

  it('draws a doorway cap once, from the baked texture, with no additive copy', () => {
    const view = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, doorSkin(), false).view;
    const caps = view.children.filter((c): c is TilingSprite => c instanceof TilingSprite && c.texture === LIT);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.alpha).toBe(1);
    expect(caps[0]!.tint).toBe(CAP_TINT);
  });

  it('leaves the door no additive cap TILE — every additive child is a state light', () => {
    // A door legitimately has additive layers (`drawGlow`'s hazard bloom, and since 2026-08-30 the
    // open state's through-light and spill), which is why "no blend modes at all" is the wrong
    // assertion here and why this needs its own case: the cap light hid behind them in every
    // count. What the bake actually promises is that none of them is a copy of the cap SWATCH, so
    // that is what is asserted — a count alone quietly went stale the moment the open state got
    // lights of its own, and would have gone on passing had it been written as `toHaveLength(3)`.
    const view = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, doorSkin(), true).view;
    const additive = view.children.filter((c) => c.blendMode === CAP_LIGHT_BLEND);
    expect(additive.length).toBeGreaterThan(0); // or a fixture that lost them all would pass
    expect(additive.every((c) => c instanceof Graphics)).toBe(true); // drawn geometry, not a tile
    expect(additive.some((c) => c instanceof TilingSprite)).toBe(false);
    // ...and exactly one of them is live in a given state: they are two mutually exclusive sets.
    expect(additive.filter((c) => c.visible)).toHaveLength(1);
  });

  it('still tags exactly one x-ray cap layer, so a character in the doorway stays visible', () => {
    const view = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, doorSkin(), false).view;
    expect(view.children.filter((c) => c.label === XRAY_LABEL)).toHaveLength(1);
  });
});
