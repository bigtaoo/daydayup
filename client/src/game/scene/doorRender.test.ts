/**
 * `doorRender.ts` — the standing door fixture (2026-08-20). Two things are worth pinning here and
 * neither is a colour:
 *
 * 1. **The leaf is never squashed.** `doorLeafFrame` is the whole rule (fit by width, bottom-anchor,
 *    crop the overflow off the top via a source frame), and the reason it exists is that the old
 *    flat door stretched a 221x320 portrait elevation into whatever the passage AABB happened to be
 *    — including a 128x64 LANDSCAPE rect for a north-south passage. So the assertions are about
 *    ASPECT and anchoring, not about the numbers a particular opening produces.
 * 2. **A door is assembled like a wall block**, i.e. its cap layers are tagged for the occlusion
 *    x-ray and everything below the fold is in the deep group. A fixture that renders beautifully
 *    and registers no fade layers swallows the character standing in the doorway, which is the bug
 *    `occlusion.ts` exists for — and that is invisible in a screenshot of an empty room.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Sprite, Texture, TextureSource, TilingSprite } from 'pixi.js';
import { biomePalette } from '../theme';
import { XRAY_DEEP_LABEL, XRAY_LABEL } from './occlusion';
import { buildDoorBlock, doorLeafFrame, drawGlow, drawRecess, drawSill, type DoorSkin } from './doorRender';
import { WALL_H_KERB, WALL_H_PERIMETER, type RectPx } from './wallGeometry';

function tex(w: number, h: number): Texture {
  return new Texture({ source: new TextureSource({ width: w, height: h }) });
}

/** The shipped leaf art's real proportions, so the fixtures below are not a fiction that happens
 *  to make the rule look easy: `door_locked_raw.png` is 147x217 after the alpha trim, and its
 *  transparent margins were the reason the leaf used to cover ~60% of its own opening. */
const ART_W = 147;
const ART_H = 217;

const skin = (leaf: Texture | undefined, face?: Texture, cap?: Texture): DoorSkin => ({
  palette: biomePalette('ember'),
  cap,
  face,
  leaf,
});

/** A comparable digest of what was drawn into a Graphics — see `floorRender.test.ts` for why
 *  `JSON.stringify` cannot be used on the instruction list itself (a fill style holds a Texture,
 *  whose source closes a cycle back to it). */
function digest(g: Graphics): string {
  return g.context.instructions
    .map((ins) => {
      const data = ins.data as {
        style?: { color?: number; alpha?: number };
        path?: { instructions: { action: string; data: unknown[] }[] };
      };
      const path = (data.path?.instructions ?? [])
        .map((i) => `${i.action}(${i.data.filter((v) => typeof v === 'number').map((v) => (v as number).toFixed(2)).join(',')})`)
        .join('|');
      return `${ins.action} ${data.style?.color ?? ''}@${(data.style?.alpha ?? 0).toFixed(3)} ${path}`;
    })
    .join(';');
}

/** Every fill's alpha in draw order — enough to assert a RAMP without pinning the constants. */
function alphas(g: Graphics): number[] {
  return g.context.instructions.map((ins) => (ins.data as { style?: { alpha?: number } }).style?.alpha ?? 0);
}

const graphicsOf = (fixture: ReturnType<typeof buildDoorBlock>): Graphics[] =>
  fixture.view.children.filter((c): c is Graphics => c instanceof Graphics);

const PASSAGE: RectPx = { x: 100, y: 200, w: 64, h: 128 };

describe('doorLeafFrame — fit by width, crop the overflow, never squash', () => {
  it('keeps the art aspect ratio for a tall opening and bottom-anchors it under lintel stone', () => {
    const { srcY, srcH, drawH } = doorLeafFrame(64, WALL_H_PERIMETER, ART_W, ART_H);
    expect(srcY).toBe(0); // nothing cropped: the whole leaf fits
    expect(srcH).toBe(ART_H);
    expect(drawH).toBeCloseTo(ART_H * (64 / ART_W), 3);
    expect(drawH).toBeLessThan(WALL_H_PERIMETER); // the band above it is the lintel
    // Aspect preserved: drawn w/h equals the art's w/h.
    expect(64 / drawH).toBeCloseTo(ART_W / ART_H, 5);
  });

  it('crops off the TOP for a kerb-high opening rather than squashing 224 rows into 22 px', () => {
    const { srcY, srcH, drawH } = doorLeafFrame(128, WALL_H_KERB, ART_W, ART_H);
    expect(drawH).toBe(WALL_H_KERB);
    // The scale is still the width scale, so the visible rows keep their own proportions...
    const scale = 128 / ART_W;
    expect(srcH).toBeCloseTo(WALL_H_KERB / scale, 3);
    // ...and what survives is the BOTTOM of the art (the frame's feet and the hazard stripe).
    expect(srcY).toBeCloseTo(ART_H - srcH, 3);
    expect(srcY + srcH).toBeCloseTo(ART_H, 3);
    // The squash a fit-both-axes version would have applied, for the record: 8x.
    expect(ART_H * scale / WALL_H_KERB).toBeGreaterThan(8);
  });

  it('is a no-op for degenerate art rather than dividing by zero', () => {
    expect(doorLeafFrame(64, 104, 0, 0)).toEqual({ srcY: 0, srcH: 0, drawH: 0 });
  });
});

describe('buildDoorBlock — a wall block whose face is an opening', () => {
  it('places the fixture on the passage south edge and Y-sorts there, like a wall block', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), false);
    expect(fixture.view.x).toBeCloseTo(100);
    expect(fixture.view.y).toBeCloseTo(328);
    expect(fixture.view.zIndex).toBeCloseTo(328);
  });

  it('tags cap layers for the x-ray and everything below the fold as the deep group', () => {
    const fixture = buildDoorBlock(
      PASSAGE,
      WALL_H_PERIMETER,
      skin(tex(ART_W, ART_H), tex(256, 128), tex(256, 256)),
      true,
    );
    expect(fixture.capLayers.length).toBeGreaterThan(0);
    expect(fixture.capLayers.every((l) => l.label === XRAY_LABEL)).toBe(true);
    // The leaf, the recess, the stone face behind them and the bloom all fade together.
    expect(fixture.deepLayers.length).toBeGreaterThanOrEqual(4);
    expect(fixture.deepLayers.every((l) => l.label === XRAY_DEEP_LABEL)).toBe(true);
    // The silhouette is in neither group and never fades — same rule as a wall.
    const tagged = fixture.capLayers.length + fixture.deepLayers.length;
    expect(fixture.view.children.length).toBeGreaterThan(tagged);
  });

  it('draws the wall own elevation across the whole face, so an opening is stone in shade', () => {
    const face = tex(256, 128);
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), face), false);
    const band = fixture.view.children.find((c) => c instanceof TilingSprite) as TilingSprite;
    expect(band.texture).toBe(face);
    expect(band.width).toBeCloseTo(PASSAGE.w);
    expect(band.height).toBeCloseTo(WALL_H_PERIMETER);
    expect(band.y).toBeCloseTo(-WALL_H_PERIMETER);
  });

  it('scales the leaf to the opening width and bottom-anchors it', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), false);
    const leaf = fixture.view.children.find((c) => c instanceof Sprite && !(c instanceof TilingSprite)) as Sprite;
    const drawH = doorLeafFrame(PASSAGE.w, WALL_H_PERIMETER, ART_W, ART_H).drawH;
    expect(leaf.width).toBeCloseTo(PASSAGE.w);
    expect(leaf.height).toBeCloseTo(drawH);
    expect(leaf.y).toBeCloseTo(-drawH); // its base sits on the fixture's own ground line
  });

  it('crops the leaf texture (same source, shorter frame) for an opening the art overflows', () => {
    const art = tex(ART_W, ART_H);
    const fixture = buildDoorBlock({ ...PASSAGE, w: 128, h: 64 }, WALL_H_KERB, skin(art), true);
    const leaf = fixture.view.children.find((c) => c instanceof Sprite && !(c instanceof TilingSprite)) as Sprite;
    expect(leaf.texture).not.toBe(art);
    expect(leaf.texture.source).toBe(art.source); // no second upload of the same art
    expect(leaf.texture.frame.height).toBeLessThan(ART_H);
    expect(leaf.texture.frame.y).toBeGreaterThan(0); // cropped off the TOP
  });

  it('shows the hazard bloom only while locked, and swaps state in place', () => {
    const locked = tex(ART_W, ART_H);
    const open = tex(156, 224);
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(locked), true);
    const kids = fixture.view.children.length;
    const glow = fixture.view.children.find((c) => c instanceof Graphics && c.blendMode === 'add') as Graphics;
    const leaf = fixture.view.children.find((c) => c instanceof Sprite && !(c instanceof TilingSprite)) as Sprite;
    expect(glow.visible).toBe(true);
    expect(leaf.texture.source).toBe(locked.source);

    fixture.setLocked(false, open);
    expect(glow.visible).toBe(false);
    expect(leaf.texture.source).toBe(open.source);
    expect(fixture.view.children.length).toBe(kids); // no rebuild, no leak
  });

  it('falls back to a standing tinted rect when no leaf art is loaded', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(undefined), true);
    const leaf = fixture.view.children.find((c) => c instanceof Sprite && !(c instanceof TilingSprite)) as Sprite;
    expect(leaf.texture).toBe(Texture.WHITE);
    expect(leaf.tint).toBe(0xe53e3e);
    // Standing, not lying down: it fills the opening's own height.
    expect(leaf.height).toBeCloseTo(WALL_H_PERIMETER);
    fixture.setLocked(false, undefined);
    expect(leaf.tint).toBe(0x4c566a);
  });
});

describe('the pieces that make an opening read as a hole rather than a panel', () => {
  it('drawRecess ramps its bands darkest at the top of the opening', () => {
    const g = new Graphics();
    drawRecess(g, 64, 104);
    const a = alphas(g);
    expect(a.length).toBeGreaterThan(4); // banded, not one flat fill
    // Deepest at the lintel, lightest at the threshold: the gradient IS the depth cue, and a flat
    // recess measured as a black rectangle punched in the room on a kerb-height doorway.
    expect(a[0]!).toBeGreaterThan(a[a.length - 1]!);
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeLessThanOrEqual(a[i - 1]! + 1e-9);
  });

  it('drawRecess is a no-op for a zero-height opening', () => {
    const g = new Graphics();
    drawRecess(g, 64, 0);
    expect(g.context.instructions).toHaveLength(0);
  });

  it('the built fixture actually contains that recess', () => {
    // The whole point of the layer, and the mutant that removed it passed every other test here.
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), tex(256, 128)), false);
    const expected = new Graphics();
    drawRecess(expected, PASSAGE.w, doorLeafFrame(PASSAGE.w, WALL_H_PERIMETER, ART_W, ART_H).drawH);
    expect(digest(expected)).not.toBe(''); // or an empty child would match an empty expectation
    expect(graphicsOf(fixture).map(digest)).toContain(digest(expected));
  });

  it('...and the sill hairline at its threshold', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), tex(256, 128)), false);
    const expected = new Graphics();
    drawSill(expected, PASSAGE.w);
    expect(digest(expected)).not.toBe(''); // same trap: a no-op sill matches an empty child
    expect(graphicsOf(fixture).map(digest)).toContain(digest(expected));
  });

  it('drawGlow is a graduated pool PLUS a wash over the leaf, not one hard ellipse', () => {
    const g = new Graphics();
    drawGlow(g, 64, 104);
    // Flattened across fills, because Pixi merges consecutive same-style fills into ONE
    // instruction carrying a path of many shapes — counting instructions would report 1.
    const shapes = g.context.instructions.flatMap((ins) => {
      const path = (ins.data as { path?: { instructions: { action: string }[] } }).path;
      return (path?.instructions ?? []).map((i) => i.action);
    });
    // Many rings: one ellipse at one alpha shows its own edge and reads as a rug painted on the
    // floor, which is exactly what the first version looked like (five still showed three edges).
    expect(shapes.filter((a) => a === 'ellipse').length).toBeGreaterThanOrEqual(6);
    // ...and the wash over the leaf itself, which is what makes a locked door glow rather than
    // just sit in a puddle of light.
    expect(shapes.filter((a) => a === 'rect').length).toBe(1);
  });

  it('the fixture carries that same bloom, and only while locked', () => {
    const locked = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), true);
    const expected = new Graphics();
    drawGlow(expected, PASSAGE.w, doorLeafFrame(PASSAGE.w, WALL_H_PERIMETER, ART_W, ART_H).drawH);
    const bloom = graphicsOf(locked).find((g) => g.blendMode === 'add')!;
    expect(digest(bloom)).toBe(digest(expected));
    expect(bloom.visible).toBe(true);
    locked.setLocked(false, undefined);
    expect(bloom.visible).toBe(false);
  });
});
