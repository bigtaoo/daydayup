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
import {
  buildDoorBlock,
  doorLeafFrame,
  drawGlow,
  drawOpenRecessShade,
  drawRecess,
  drawSill,
  drawSpill,
  drawThroughLight,
  type DoorSkin,
} from './doorRender';
import { WALL_H_KERB, WALL_H_PERIMETER, type RectPx } from './wallGeometry';

function tex(w: number, h: number): Texture {
  return new Texture({ source: new TextureSource({ width: w, height: h }) });
}

/** The shipped leaf art's real proportions, so the fixtures below are not a fiction that happens
 *  to make the rule look easy: `door_locked_raw.png` is 147x217 after the alpha trim, and its
 *  transparent margins were the reason the leaf used to cover ~60% of its own opening. */
const ART_W = 147;
const ART_H = 217;

const skin = (
  leaf: Texture | undefined,
  face?: Texture,
  cap?: Texture,
  floor?: Texture,
  curtain?: Texture,
): DoorSkin => ({
  palette: biomePalette('ember'),
  cap,
  face,
  floor,
  curtain,
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

const PASSAGE: RectPx = { x: 100, y: 200, w: 64, h: 128 };

const graphicsOf = (fixture: ReturnType<typeof buildDoorBlock>): Graphics[] =>
  fixture.view.children.filter((c): c is Graphics => c instanceof Graphics);

const leafOf = (fixture: ReturnType<typeof buildDoorBlock>): Sprite =>
  fixture.view.children.find((c) => c instanceof Sprite && !(c instanceof TilingSprite)) as Sprite;

/**
 * The fixture's own copy of one `draw*` layer, found by DIGEST rather than by picking the first
 * additive child. The fixture now carries three additive Graphics (the hazard bloom, and the open
 * state's through-light and spill), so `find(c => c.blendMode === 'add')` silently returns
 * whichever happens to be first in the child list — which is how these assertions would go on
 * passing while testing the wrong layer. Asserting the layer is present at all is half the point:
 * a `draw*` that no-ops matches an empty child, so the expectation is checked non-empty too.
 */
function lightOf(
  fixture: ReturnType<typeof buildDoorBlock>,
  draw: (g: Graphics, w: number, h: number) => void,
  passage: RectPx = PASSAGE,
  height = WALL_H_PERIMETER,
  art: [number, number] = [ART_W, ART_H],
): Graphics {
  const expected = new Graphics();
  draw(expected, passage.w, doorLeafFrame(passage.w, height, art[0], art[1]).drawH);
  const want = digest(expected);
  expect(want).not.toBe('');
  const found = graphicsOf(fixture).filter((g) => digest(g) === want);
  expect(found).toHaveLength(1);
  return found[0]!;
}

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

  it('keeps its face ONE piece even on a passage shallower than the wall is tall', () => {
    // `buildWallBlock` splits a face so the x-ray's deep pass cannot reach the block's base
    // (`occlusion.deepFadeReach`). A door must not: that bound is derived from a focus standing
    // NORTH of the footprint, and a door's passage floor is INSIDE its own footprint, so a
    // character in the doorway stands on rows the derivation excludes and the whole face has to
    // stay in the fading group. Asserted on a SHALLOW passage on purpose — a deep one clamps the
    // reach to zero and would come out as one piece however this were wired.
    const face = tex(256, 128);
    const shallow: RectPx = { ...PASSAGE, h: 32 };
    const fixture = buildDoorBlock(shallow, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), face), false);
    const pieces = fixture.view.children.filter((c): c is TilingSprite => c instanceof TilingSprite);
    const elevation = pieces.filter((p) => p.texture === face);
    expect(elevation).toHaveLength(1);
    expect(elevation[0]!.y).toBeCloseTo(-WALL_H_PERIMETER);
    expect(elevation[0]!.height).toBeCloseTo(WALL_H_PERIMETER);
    // ...and all of it fades, i.e. it is in the deep group rather than split out of it.
    expect(fixture.deepLayers).toContain(elevation[0]);
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
    const glow = lightOf(fixture, drawGlow);
    const leaf = leafOf(fixture);
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

  it('the built LOCKED fixture actually contains the full-depth recess', () => {
    // The whole point of the layer, and the mutant that removed it passed every other test here.
    // Locked, not open: since 2026-08-30b the two states no longer share one recess (see the open
    // recess describe block below) — the default-alpha bands are the locked door's own.
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), tex(256, 128)), true);
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
    const bloom = lightOf(locked, drawGlow);
    expect(bloom.visible).toBe(true);
    locked.setLocked(false, undefined);
    expect(bloom.visible).toBe(false);
  });
});

/**
 * The 2026-08-30 pass: an open door had no positive signal at all.
 *
 * The bug it fixes is not a wrong number, it is an ABSENCE — every cue the fixture had was
 * `visible = locked`, so "passable" was rendered as "the locked door, minus its bloom", which on
 * a dark stone wall in the darkest band of a room reads as wall. That shape of defect is exactly
 * what a suite of per-layer assertions cannot see, so what is pinned here is the STATE MACHINE
 * (does the open state carry its own layers, are the two states mutually exclusive, do they swap
 * without a rebuild) and the one ORDERING claim the whole approach rests on — not the colours,
 * which are measured on a real frame instead.
 */
describe('an open door is lit from beyond, rather than being a locked door minus its bloom', () => {
  it('drawThroughLight ramps the opposite way to the recess: brightest at the threshold', () => {
    const g = new Graphics();
    drawThroughLight(g, 64, 104);
    const a = alphas(g);
    expect(a.length).toBeGreaterThan(4); // banded, not one flat fill that draws its own edge
    // Drawn from the threshold upward, so the FIRST band is the brightest — and the recess's own
    // ramp runs the other way. If these two ever agree, one of them points the wrong way and the
    // opening either glows at the lintel or is dark everywhere.
    expect(a[0]!).toBeGreaterThan(a[a.length - 1]!);
    for (let i = 1; i < a.length; i++) expect(a[i]!).toBeLessThanOrEqual(a[i - 1]! + 1e-9);
    // An alpha ramp alone cannot tell "brightest at the floor" from "brightest at the lintel" —
    // only the band's own y can, so assert the two layers ramp toward OPPOSITE ends.
    const recess = new Graphics();
    drawRecess(recess, 64, 104);
    expect(bandY(g, 0)).toBeGreaterThan(bandY(g, a.length - 1));
    expect(bandY(recess, 0)).toBeLessThan(bandY(recess, alphas(recess).length - 1));
  });

  it('stops well short of the top of the opening — it is a floor light, not a wash', () => {
    const g = new Graphics();
    drawThroughLight(g, 64, 104);
    const top = Math.min(...alphas(g).map((_, i) => bandY(g, i)));
    expect(top).toBeGreaterThan(-104); // never reaches the lintel
    expect(top).toBeLessThan(0); // ...but is not a hairline either
  });

  it('drawThroughLight is a no-op for a zero-height opening', () => {
    const g = new Graphics();
    drawThroughLight(g, 64, 0);
    expect(g.context.instructions).toHaveLength(0);
  });

  it('drawSpill is the hazard pool shape in warm white, plus a rim up both jambs', () => {
    const g = new Graphics();
    drawSpill(g, 64, 104);
    // The same graduated pool the locked state uses — one symbol, colour saying which state.
    const pool = new Graphics();
    drawGlow(pool, 64, 104);
    expect(countShapes(g, 'ellipse')).toBe(countShapes(pool, 'ellipse'));
    // ...and the rim: bands up each jamb, not one rect over the whole opening.
    expect(countShapes(g, 'rect')).toBeGreaterThanOrEqual(6);
  });

  it('the rim stays on the jambs and never crosses the lintel underside', () => {
    const w = 64;
    const g = new Graphics();
    drawSpill(g, w, 104);
    const rects = allRects(g);
    expect(rects.length).toBeGreaterThan(0);
    for (const [x, , rw] of rects) {
      // Each rect hugs one edge: a band spanning the opening would be a wash over the arch, and a
      // lit line across the TOP would flatten the depth ramp the recess exists for.
      expect(rw!).toBeLessThan(w / 2);
      expect(x === 0 || Math.abs(x! + rw! - w) < 1e-6).toBe(true);
    }
  });

  it('drawSpill still lays its floor pool for a kerb opening with no height to ramp into', () => {
    // 11 of the 24 shipped doors are kerb doors (`doorStandCoverage.test.ts`); a 22 px opening has
    // no room for the through-light, so the pool is the entire cue and must not be height-gated.
    const g = new Graphics();
    drawSpill(g, 128, 0);
    expect(countShapes(g, 'ellipse')).toBeGreaterThanOrEqual(6);
    expect(countShapes(g, 'rect')).toBe(0); // ...and no zero-height rim bands
  });

  it('the built OPEN fixture carries both layers and the locked bloom is hidden', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), false);
    expect(lightOf(fixture, drawThroughLight).visible).toBe(true);
    expect(lightOf(fixture, drawSpill).visible).toBe(true);
    expect(lightOf(fixture, drawGlow).visible).toBe(false);
  });

  it('the two states are mutually exclusive, in both directions, with no rebuild', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), true);
    const kids = fixture.view.children.length;
    const through = lightOf(fixture, drawThroughLight);
    const spill = lightOf(fixture, drawSpill);
    const glow = lightOf(fixture, drawGlow);
    const live = (): string => [through, spill, glow].map((g) => (g.visible ? '1' : '0')).join('');
    expect(live()).toBe('001');
    fixture.setLocked(false, tex(156, 224));
    expect(live()).toBe('110');
    fixture.setLocked(true, tex(ART_W, ART_H));
    expect(live()).toBe('001'); // the flip back is a separate mutant from the flip out
    expect(fixture.view.children.length).toBe(kids);
  });

  it('puts the through-light BEHIND the leaf and the spill in front of it', () => {
    // The whole reason no inset constant is needed: the arch elevation is opaque stone around a
    // transparent middle, so drawing the light under it confines the light to the opening for
    // free. Swap the two and the light washes over the frame — which no other assertion here can
    // see, and which is precisely the "correct in the constants, wrong on the swatches" failure
    // this project has shipped before.
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), false);
    const at = (c: unknown): number => fixture.view.children.indexOf(c as never);
    expect(at(lightOf(fixture, drawThroughLight))).toBeLessThan(at(leafOf(fixture)));
    expect(at(lightOf(fixture, drawSpill))).toBeGreaterThan(at(leafOf(fixture)));
  });

  it('fades both open layers with the character-saving deep x-ray, like the bloom', () => {
    // A door's passage floor is inside its own art, so a character in the doorway is behind every
    // one of these by construction — a light that stayed opaque through the fade would sit on top
    // of the player it is meant to invite through.
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), tex(256, 128)), false);
    for (const draw of [drawThroughLight, drawSpill]) {
      expect(fixture.deepLayers).toContain(lightOf(fixture, draw));
    }
  });

  it('lights a KERB door too, where the opening is 22 px and the ramp has nowhere to go', () => {
    const kerb: RectPx = { x: 0, y: 0, w: 128, h: 64 };
    const fixture = buildDoorBlock(kerb, WALL_H_KERB, skin(tex(ART_W, ART_H)), false);
    const spill = lightOf(fixture, drawSpill, kerb, WALL_H_KERB);
    expect(spill.visible).toBe(true);
    // The pool's reach is set by the opening's WIDTH, so a kerb door — the wide one — gets the
    // biggest pool of all, which is what has to carry it.
    expect(spill.getLocalBounds().width).toBeGreaterThan(kerb.w);
  });
});

/**
 * 2026-08-30b: the light pass above still left the tunnel itself sharing one dark base with the
 * locked state — live report, after that pass had already shipped, circling the OPENING rather
 * than the light: *"可以通过时的门，好了一些，但离我想要的效果还差很远"* (better, but still far from the
 * effect wanted). This block is that base's own state machine, mirroring the through/spill block
 * above it.
 */
describe("an open door's recess shows the room's own floor, not more wall stone", () => {
  it('tiles the floor swatch across the opening only while open', () => {
    const floor = tex(48, 48);
    const openFixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), undefined, undefined, floor), false);
    const openTile = openFixture.view.children.find(
      (c): c is TilingSprite => c instanceof TilingSprite && c.texture === floor,
    );
    expect(openTile).toBeDefined();
    expect(openTile!.visible).toBe(true);

    const lockedFixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), undefined, undefined, floor), true);
    const lockedTile = lockedFixture.view.children.find(
      (c): c is TilingSprite => c instanceof TilingSprite && c.texture === floor,
    );
    expect(lockedTile).toBeDefined();
    expect(lockedTile!.visible).toBe(false);
  });

  it('falls back to a flat Graphics fill with no floor swatch loaded, not a degenerate sprite', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), false);
    // No TilingSprite at all when no floor art was loaded — the fallback path is Graphics-only.
    expect(fixture.view.children.some((c) => c instanceof TilingSprite)).toBe(false);
  });

  it('darkens the open recess far less than a locked one, over the SAME opening', () => {
    const openShade = new Graphics();
    drawOpenRecessShade(openShade, 64, 104);
    const locked = new Graphics();
    drawRecess(locked, 64, 104);
    const openA = alphas(openShade);
    const lockedA = alphas(locked);
    // Same band count (one ramp function, two alpha pairs), every band lighter than its locked
    // counterpart — if these ever converge, the floor tile underneath would be buried the same way
    // the flat colour used to bury the stone.
    expect(openA.length).toBe(lockedA.length);
    for (let i = 0; i < openA.length; i++) expect(openA[i]!).toBeLessThan(lockedA[i]!);
    // Still a real ramp, not "so light it might as well be a flat wash" — the lintel end must stay
    // visibly darker than the threshold.
    expect(openA[0]!).toBeGreaterThan(openA[openA.length - 1]! * 1.5);
  });

  it('the built fixture carries that shade only while open, alongside the through-light', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), false);
    const shade = lightOf(fixture, drawOpenRecessShade);
    expect(shade.visible).toBe(true);
    fixture.setLocked(true, tex(ART_W, ART_H));
    expect(shade.visible).toBe(false);
  });
});

/**
 * 2026-08-30b (second pass, same day): the floor-tile recess above still wasn't enough — live
 * report *"依然不行...被阻挡时的火焰很明显，但是可以通过的效果太弱了"* (still no good — the locked
 * state's flame reads clearly, the passable one doesn't come close). The locked leaf is a whole
 * illustrated hazard panel; no amount of gradient tuning was ever going to match that weight, so
 * the open state gets an illustrated asset of its own — a curtain-of-light sprite that REPLACES
 * `through` when loaded, sized by the same `doorLeafFrame` rule as the leaf.
 */
describe("an open door's curtain-of-light replaces the procedural through-light when its art is loaded", () => {
  /** The curtain sprite: the one Sprite besides the leaf, found by texture identity rather than
   *  position — both are plain `Sprite`s (not `TilingSprite`s), so `leafOf`'s "first Sprite"
   *  search cannot tell them apart once a curtain is loaded. */
  const curtainOf = (fixture: ReturnType<typeof buildDoorBlock>, curtainArt: Texture): Sprite | undefined =>
    fixture.view.children.find(
      (c): c is Sprite => c instanceof Sprite && !(c instanceof TilingSprite) && c.texture.source === curtainArt.source,
    );

  it('adds no curtain sprite at all when no curtain art is loaded — through carries the cue alone', () => {
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H)), false);
    const sprites = fixture.view.children.filter((c): c is Sprite => c instanceof Sprite && !(c instanceof TilingSprite));
    expect(sprites).toHaveLength(1); // the leaf, and nothing else
    expect(lightOf(fixture, drawThroughLight).visible).toBe(true);
  });

  it('adds an additive curtain sprite when its art is loaded, visible only while open', () => {
    const curtainArt = tex(200, 400);
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), undefined, undefined, undefined, curtainArt), true);
    const curtain = curtainOf(fixture, curtainArt);
    expect(curtain).toBeDefined();
    expect(curtain!.blendMode).toBe('add');
    expect(curtain!.visible).toBe(false); // locked
    fixture.setLocked(false, tex(156, 224));
    expect(curtain!.visible).toBe(true);
  });

  it('hides the procedural through-light whenever curtain art is loaded, in both states', () => {
    const curtainArt = tex(200, 400);
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), undefined, undefined, undefined, curtainArt), false);
    const through = lightOf(fixture, drawThroughLight);
    expect(through.visible).toBe(false); // curtain has the slot, open
    fixture.setLocked(true, tex(ART_W, ART_H));
    expect(through.visible).toBe(false); // and locked — through never comes back on its own
  });

  it('sizes the curtain by the same doorLeafFrame rule as the leaf: fit by width, crop off the top', () => {
    const curtainArt = tex(200, 400); // taller (relative to width) than the opening — will crop
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), undefined, undefined, undefined, curtainArt), false);
    const curtain = curtainOf(fixture, curtainArt)!;
    const drawH = doorLeafFrame(PASSAGE.w, WALL_H_PERIMETER, ART_W, ART_H).drawH; // same height as the leaf
    const { srcY, srcH } = doorLeafFrame(PASSAGE.w, drawH, curtainArt.width, curtainArt.height);
    expect(curtain.width).toBeCloseTo(PASSAGE.w);
    expect(curtain.height).toBeCloseTo(drawH);
    expect(curtain.texture.frame.height).toBeCloseTo(srcH);
    expect(curtain.texture.frame.y).toBeCloseTo(srcY);
    expect(srcY).toBeGreaterThan(0); // the crop actually fired — or this test proves nothing
  });

  it('stands the curtain on the threshold reaching UP into the opening, not down into the room', () => {
    // The bug this pins: `fitArtToOpening` sets texture/width/height only, never position — the
    // curtain shipped with no `.position.set()` at all, so it defaulted to (0, 0) and drew from
    // the threshold DOWNWARD into the room floor. Additive, visible, correctly sized, and
    // completely invisible in play, because every existing assertion here checks SIZE and
    // VISIBILITY, never where the sprite actually stands — caught live, not by this suite.
    const curtainArt = tex(200, 400);
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), undefined, undefined, undefined, curtainArt), false);
    const curtain = curtainOf(fixture, curtainArt)!;
    const drawH = doorLeafFrame(PASSAGE.w, WALL_H_PERIMETER, ART_W, ART_H).drawH;
    expect(curtain.x).toBeCloseTo(0);
    expect(curtain.y).toBeCloseTo(-drawH);
  });

  it('keeps the curtain behind the leaf and in the deep x-ray group, like through', () => {
    const curtainArt = tex(200, 400);
    const fixture = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(tex(ART_W, ART_H), tex(256, 128), undefined, undefined, curtainArt), false);
    const curtain = curtainOf(fixture, curtainArt)!;
    // `leafOf` picks the first plain Sprite, which is the curtain itself once one is loaded (both
    // are plain Sprites) — the real leaf here is the OTHER one, found by excluding the curtain's
    // own texture source.
    const leaf = fixture.view.children.find(
      (c): c is Sprite => c instanceof Sprite && !(c instanceof TilingSprite) && c.texture.source !== curtainArt.source,
    )!;
    const at = (c: unknown): number => fixture.view.children.indexOf(c as never);
    expect(at(curtain)).toBeLessThan(at(leaf));
    expect(fixture.deepLayers).toContain(curtain);
  });
});

/**
 * The three invariants above the layer level — what the *composition* has to come out as.
 *
 * Everything in the suites above is about one layer at a time: is it there, does it ramp the right
 * way, is it visible in the right state. All of that can be true while the fixture still reads as
 * a black wall, because what the player sees is `recess` and `through` composited, and the two are
 * tuned against each other. Nothing yet stops someone raising `RECESS_ALPHA_FLOOR` back up and
 * quietly re-burying the doorway with every existing assertion green — which is the exact class of
 * regression this pass was called in to fix in the first place.
 */
describe('what the layers come out as together', () => {
  /** The wall elevation's own luma where a door is cut into it, measured on a live frame of level
   *  1 (the `wallFace` band beside an open perimeter door read 53.7-57.2 across two rooms). The
   *  assertions below are about the doorway's value RELATIVE to this, so the exact figure only has
   *  to be the right order of magnitude — but it is a measured one rather than a round number. */
  const STONE = 55;

  const relLuma = (hex: number): number =>
    0.2126 * ((hex >> 16) & 0xff) + 0.7152 * ((hex >> 8) & 0xff) + 0.0722 * (hex & 0xff);

  /** Every fill in `g` as `[color, alpha, y, h]`, flattened across instructions (Pixi merges
   *  consecutive same-style fills into one instruction carrying a multi-shape path). */
  function rectFills(g: Graphics): { color: number; alpha: number; y: number; h: number }[] {
    return g.context.instructions.flatMap((ins) => {
      const data = ins.data as {
        style?: { color?: number; alpha?: number };
        path?: { instructions: { action: string; data: unknown[] }[] };
      };
      return (data.path?.instructions ?? [])
        .filter((i) => i.action === 'rect')
        .map((i) => {
          const d = i.data as number[];
          return { color: data.style?.color ?? 0, alpha: data.style?.alpha ?? 0, y: d[1]!, h: d[3]! };
        });
    });
  }

  /** The luma a row of the opening ends up at, compositing the given layers over stone in draw
   *  order. `normal` blends toward the fill colour, `add` sums — the two blend modes the fixture
   *  actually uses. */
  function lumaAtRow(layers: { g: Graphics; mode: 'normal' | 'add' }[], y: number): number {
    let out = STONE;
    for (const { g, mode } of layers) {
      for (const f of rectFills(g)) {
        if (y < f.y || y >= f.y + f.h) continue;
        const c = relLuma(f.color);
        out = mode === 'add' ? out + f.alpha * c : out * (1 - f.alpha) + c * f.alpha;
      }
    }
    return out;
  }

  const H = 92; // the shipped perimeter door's leaf height, near enough (`doorLeafFrame` gives 91.9)

  it('leaves the opening a HOLE when the light is off — the recess still does its job', () => {
    const recess = new Graphics();
    drawRecess(recess, 64, H);
    const bottom = lumaAtRow([{ g: recess, mode: 'normal' }], -1);
    const top = lumaAtRow([{ g: recess, mode: 'normal' }], -H + 1);
    // Both ends darker than the stone the door is cut into, and the top the darker of the two.
    // Without this, "make the doorway brighter" could be satisfied by weakening the recess, which
    // would take the depth cue with it — design/01: "stone in deep shade reads as a passage where
    // a void reads as a bug", and a passage with no shade at all reads as a painted panel.
    expect(bottom).toBeLessThan(STONE * 0.8);
    expect(top).toBeLessThan(bottom * 0.7);
  });

  it('puts the lit threshold ABOVE the stone it is cut into, not merely above its own floor', () => {
    const recess = new Graphics();
    drawRecess(recess, 64, H);
    const through = new Graphics();
    drawThroughLight(through, 64, H);
    const layers = [
      { g: recess, mode: 'normal' as const },
      { g: through, mode: 'add' as const },
    ];
    const lit = lumaAtRow(layers, -1);
    const unlit = lumaAtRow([layers[0]!], -1);
    // The whole reported defect in one assertion: the doorway used to be the DARKEST thing around,
    // so "brighter than it was" is not the bar — it has to out-value the wall beside it, or it
    // still reads as a recess in a wall rather than as somewhere light is coming from.
    expect(unlit).toBeLessThan(STONE);
    expect(lit).toBeGreaterThan(STONE);
  });

  it('keeps a real gradient between the threshold and the lintel, not a uniform wash', () => {
    const recess = new Graphics();
    drawRecess(recess, 64, H);
    const through = new Graphics();
    drawThroughLight(through, 64, H);
    const layers = [
      { g: recess, mode: 'normal' as const },
      { g: through, mode: 'add' as const },
    ];
    const at = (y: number): number => lumaAtRow(layers, y);
    // Threshold, mid, lintel: a monotone fall, with the full swing big enough to read as depth
    // rather than as noise. Measured on the shipped constants: about 85 → 39 → 20.
    expect(at(-1)).toBeGreaterThan(at(-H / 2));
    expect(at(-H / 2)).toBeGreaterThan(at(-H + 1));
    expect(at(-1) - at(-H + 1)).toBeGreaterThan(25);
  });

  it('does not let the open pool out-shout the hazard pool, which ALPHA alone cannot tell you', () => {
    // The mistake this test exists for, made and measured during the pass that added these layers:
    // the open pool was first given a LOWER alpha than the hazard pool (0.024 vs 0.035) on the
    // assumption that made it quieter. It did not. `GLOW_COLOR` is a saturated red at relative
    // luma 98 and the warm white is 221, so ring for ring the open pool lands 2.3x harder at the
    // same number — A/B'd on a live kerb door it moved the frame by +22.5 luma against the hazard
    // bloom's +14.8. What has to stay bounded is alpha x colour, so that is what is asserted.
    const ringsOf = (draw: (g: Graphics, w: number, h: number) => void): { color: number; alpha: number } => {
      const g = new Graphics();
      draw(g, 64, H);
      const rings = g.context.instructions
        .filter((ins) => {
          const path = (ins.data as { path?: { instructions: { action: string }[] } }).path;
          return (path?.instructions ?? []).some((i) => i.action === 'ellipse');
        })
        .map((ins) => {
          const d = ins.data as { style?: { color?: number; alpha?: number } };
          return { color: d.style?.color ?? 0, alpha: d.style?.alpha ?? 0 };
        });
      expect(rings.length).toBeGreaterThan(0);
      // Both pools are one alpha across all nine rings; if that ever stops being true this
      // comparison silently starts reading whichever ring happened to be first.
      expect(new Set(rings.map((r) => `${r.color}@${r.alpha}`)).size).toBe(1);
      return rings[0]!;
    };
    const hazard = ringsOf(drawGlow);
    const open = ringsOf(drawSpill);
    const weight = (r: { color: number; alpha: number }): number => r.alpha * relLuma(r.color);
    const ratio = weight(open) / weight(hazard);
    // Comparable magnitude, warmth instead of red. The upper bound is what the 0.024 version broke
    // (it sat at 1.55); the lower bound stops the open state being quietly turned off instead.
    expect(ratio).toBeLessThan(1.35);
    expect(ratio).toBeGreaterThan(0.6);
  });

  it('still tells the two states apart with NO leaf art loaded, where the arch cannot mask', () => {
    // The fallback path (`applyLeaf` with no swatch) draws an OPAQUE tinted rect over the whole
    // opening, so the through-light — which lives behind the leaf on purpose — contributes nothing
    // there. The open state must not collapse to "a grey slab and nothing else": what is in front
    // of the leaf has to carry it.
    const open = buildDoorBlock(PASSAGE, WALL_H_PERIMETER, skin(undefined), false);
    const leafIdx = open.view.children.indexOf(leafOf(open));
    const inFront = open.view.children.filter(
      (c, i): c is Graphics => i > leafIdx && c instanceof Graphics && c.blendMode === 'add' && c.visible,
    );
    expect(inFront.length).toBeGreaterThan(0);
    // The spill in particular, matched by digest — and note the height it is drawn at is the
    // OPENING's, not `doorLeafFrame`'s: with no art there is no aspect ratio to fit, so
    // `leafHeight` falls back to the full fixture height. `lightOf` cannot express that case,
    // which is why the expectation is built by hand here.
    const expected = new Graphics();
    drawSpill(expected, PASSAGE.w, WALL_H_PERIMETER);
    expect(inFront.map(digest)).toContain(digest(expected));
  });
});

/** The y of the fill instruction at index `i`, for asserting which END of an opening a ramp is
 *  brightest at — an alpha ramp alone cannot tell "bright at the floor" from "bright at the top". */
function bandY(g: Graphics, i: number): number {
  // The first shape in the path, NOT `instructions[0]`: every fill after the first carries a
  // leading `moveTo(0, 0)`, whose y is 0 — reading that instead reports every band but the first
  // as sitting on the threshold, which is a ramp direction assertion that can never fail.
  const path = (g.context.instructions[i]!.data as {
    path?: { instructions: { action: string; data: unknown[] }[] };
  }).path;
  const rect = path!.instructions.find((ins) => ins.action === 'rect')!;
  return (rect.data as number[])[1]!;
}

/** How many shapes of one kind were drawn into `g`. Flattened across instructions because Pixi
 *  merges consecutive same-style fills into ONE instruction carrying a multi-shape path —
 *  counting instructions would report 1. */
function countShapes(g: Graphics, action: string): number {
  return g.context.instructions
    .flatMap((ins) => {
      const path = (ins.data as { path?: { instructions: { action: string }[] } }).path;
      return (path?.instructions ?? []).map((i) => i.action);
    })
    .filter((a) => a === action).length;
}

/** Every `rect` drawn into `g`, as `[x, y, w, h]`. Flattened for the same reason. */
function allRects(g: Graphics): number[][] {
  return g.context.instructions.flatMap((ins) => {
    const path = (ins.data as { path?: { instructions: { action: string; data: unknown[] }[] } }).path;
    return (path?.instructions ?? [])
      .filter((i) => i.action === 'rect')
      .map((i) => (i.data as number[]).slice(0, 4));
  });
}
