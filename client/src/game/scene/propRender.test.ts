/**
 * `propRender` — decorative room dressing (`RoomPiece.props`). No pixel readback is
 * possible for a `Graphics` object, but its retained instruction list is (same technique
 * `pillarRender.test.ts`/`wallRender.test.ts` use): these assert the actual draw calls,
 * not just that "something" was added to a `Container`.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Sprite, Texture, TextureSource } from 'pixi.js';
import {
  buildPropBody,
  propBodyHeight,
  propFootprintWidth,
  propShadowRadius,
  propTint,
  PROP_HEIGHT_CEILING_PX,
  resolvePropKind,
  type PropKind,
} from './propRender';
import { biomePalette } from '../theme';

interface Instr {
  action: string;
  data: { style?: { color: number; alpha: number; width?: number }; path?: { instructions: Array<{ action: string; data: number[] }> } };
}

function fills(g: Graphics): Array<{ color: number; alpha: number }> {
  return (g.context.instructions as Instr[])
    .filter((i) => i.action === 'fill')
    .map((i) => ({ color: i.data.style!.color, alpha: i.data.style!.alpha }));
}

function strokes(g: Graphics): Array<{ color: number; alpha: number }> {
  return (g.context.instructions as Instr[])
    .filter((i) => i.action === 'stroke')
    .map((i) => ({ color: i.data.style!.color, alpha: i.data.style!.alpha }));
}

/** `roundRect`/`rect` path data, in draw order — `[x, y, w, h]` (`roundRect` has a 5th,
 *  the corner radius). Read back off the real instructions rather than restated, same
 *  reason `pillarRender.test.ts` does it: geometry a colour-only assertion cannot see. */
function rects(g: Graphics, action: 'roundRect' | 'rect'): number[][] {
  return (g.context.instructions as Instr[])
    .flatMap((i) => i.data.path?.instructions ?? [])
    .filter((pi) => pi.action === action)
    .map((pi) => pi.data);
}

function ellipses(g: Graphics): number[][] {
  return (g.context.instructions as Instr[])
    .flatMap((i) => i.data.path?.instructions ?? [])
    .filter((pi) => pi.action === 'ellipse')
    .map((pi) => pi.data);
}

function bodyGraphics(kind: PropKind, palette = biomePalette(undefined)): Graphics {
  const c = buildPropBody(kind, palette);
  const g = c.children.find((ch) => ch instanceof Graphics) as Graphics;
  expect(g).toBeDefined();
  return g;
}

describe('resolvePropKind — PropPlacement.id forward-compat, same rule as SpawnPoint.type', () => {
  it('passes every known kind through unchanged', () => {
    expect(resolvePropKind('crate')).toBe('crate');
    expect(resolvePropKind('barrel')).toBe('barrel');
    expect(resolvePropKind('rubble')).toBe('rubble');
  });

  it('falls back to crate for an unrecognized or missing id — never draws nothing', () => {
    expect(resolvePropKind('prop_1')).toBe('crate'); // the map-editor's auto-generated id
    expect(resolvePropKind('anything-else')).toBe('crate');
    expect(resolvePropKind(undefined)).toBe('crate');
  });
});

describe('propShadowRadius / propFootprintWidth — the authored size table', () => {
  it('pins the shipped ground radius per kind', () => {
    expect(propShadowRadius('crate')).toBe(9);
    expect(propShadowRadius('barrel')).toBe(8);
    expect(propShadowRadius('rubble')).toBe(11);
  });

  it('pins the shipped footprint width per kind', () => {
    expect(propFootprintWidth('crate')).toBe(18);
    expect(propFootprintWidth('barrel')).toBe(16);
    expect(propFootprintWidth('rubble')).toBe(22);
  });
});

describe('buildPropBody — no texture (the Graphics fallback every prop draws today)', () => {
  const palette = biomePalette('ember');

  it('draws a crate as a filled body plus a lighter lid and two seam lines', () => {
    const g = bodyGraphics('crate', palette);
    const f = fills(g);
    // body + lid + 2 seams = 4 opaque fills, distinct colours for body vs lid.
    expect(f).toHaveLength(4);
    expect(f[0]!.color).not.toBe(f[1]!.color);
    expect(strokes(g)).toHaveLength(1); // the silhouette
  });

  it('sizes the crate\'s body/lid/seams/silhouette to its own footprint, not a stray constant', () => {
    const g = bodyGraphics('crate', palette);
    const [body, lid] = rects(g, 'roundRect');
    const halfW = propFootprintWidth('crate') / 2;
    const h = propBodyHeight('crate');
    expect(body!.slice(0, 5)).toEqual([-halfW, -h, halfW * 2, h, 1.5]);
    expect(lid![2]).toBeCloseTo(halfW * 2, 6); // as wide as the body
    expect(lid![3]).toBeGreaterThan(0);
    expect(lid![3]).toBeLessThan(15); // a BAND across the top, not the whole face
    const seams = rects(g, 'rect');
    expect(seams).toHaveLength(2);
    expect(seams[0]![0]).toBeCloseTo(-halfW * 0.34, 6); // one seam left of centre...
    expect(seams[1]![0]).toBeCloseTo(halfW * 0.34 - 1, 6); // ...one right, mirrored
    const stroke = (g.context.instructions as Instr[]).find((i) => i.action === 'stroke')!;
    const strokeRect = (stroke.data.path?.instructions ?? []).find((pi) => pi.action === 'roundRect')!.data;
    expect(strokeRect.slice(0, 5)).toEqual(body!.slice(0, 5)); // silhouette traces the SAME rect as the fill
  });

  it('draws a barrel as a body, two hoop bands, and a lighter top ellipse', () => {
    const g = bodyGraphics('barrel', palette);
    const f = fills(g);
    expect(f).toHaveLength(4); // body + 2 hoops + top
    expect(strokes(g)).toHaveLength(1);
  });

  it('places the barrel\'s hoops inside the body and its lid ellipse centred on top', () => {
    const g = bodyGraphics('barrel', palette);
    const halfW = propFootprintWidth('barrel') / 2;
    const height = propBodyHeight('barrel');
    const hoops = rects(g, 'rect');
    expect(hoops).toHaveLength(2);
    expect(hoops[0]!.slice(0, 4)).toEqual([-halfW, -height + height * 0.28, halfW * 2, 2]);
    expect(hoops[1]!.slice(0, 4)).toEqual([-halfW, -height + height * 0.68, halfW * 2, 2]);
    const [lid] = ellipses(g);
    expect(lid!.slice(0, 4)).toEqual([0, -height, halfW * 0.9, halfW * 0.35]);
  });

  it('draws the barrel body\'s corner rounding proportional to its own width', () => {
    const g = bodyGraphics('barrel', palette);
    const halfW = propFootprintWidth('barrel') / 2;
    const [body] = rects(g, 'roundRect');
    const h = propBodyHeight('barrel');
    expect(body!.slice(0, 5)).toEqual([-halfW, -h, halfW * 2, h, halfW * 0.4]);
  });

  it('draws rubble as a handful of overlapping stones, with NO silhouette stroke', () => {
    // Deliberately not a standing object with an edge — a pile, not a box.
    const g = bodyGraphics('rubble', palette);
    const f = fills(g);
    expect(f.length).toBeGreaterThanOrEqual(5);
    expect(strokes(g)).toHaveLength(0);
  });

  it('scatters the stones across the footprint rather than stacking them on one point', () => {
    const g = bodyGraphics('rubble', palette);
    const stones = ellipses(g);
    expect(stones.length).toBeGreaterThanOrEqual(5);
    const xs = stones.map((s) => s[0]!);
    const halfW = propFootprintWidth('rubble') / 2;
    // Real spread, not five stones stacked on one point.
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(halfW * 0.5);
    // Squashed vertically (ry = rx * 0.6), same foreshortening every ground-lying shape in
    // this room uses (`Entity.SHADOW_SQUASH`'s own sibling constant, just local to this shape).
    for (const [, , rx, ry] of stones) expect(ry).toBeCloseTo(rx! * 0.6, 6);
  });

  it('every prop stays well under a wall/pillar\'s height (70-104) — short enough the x-ray never needs it', () => {
    // The DRAWN extent, not `height`: the barrel's lid ellipse sits centred on `-height` and
    // the silhouette stroke straddles the outline, so both reach past the metric. Whether a
    // prop can hide a character is a question about what lands on screen.
    for (const kind of ['crate', 'barrel', 'rubble'] as const) {
      const g = bodyGraphics(kind, palette);
      expect(g.bounds.height).toBeLessThanOrEqual(PROP_HEIGHT_CEILING_PX);
    }
    // ...and the shortest object that DOES need the x-ray stands 70 px, so the ceiling has
    // to stay well under that or the exemption this module claims stops being true.
    expect(PROP_HEIGHT_CEILING_PX).toBeLessThan(70 / 2);
  });

  it('is deterministic — two props of the same kind draw identically', () => {
    const a = fills(bodyGraphics('crate', palette));
    const b = fills(bodyGraphics('crate', palette));
    expect(a).toEqual(b);
  });

  it('shifts tone with the biome, so an ember room\'s crate is not a neutral room\'s', () => {
    const ember = fills(bodyGraphics('crate', biomePalette('ember')));
    const neutral = fills(bodyGraphics('crate', biomePalette(undefined)));
    expect(ember).not.toEqual(neutral);
  });

  it('mixes in exactly PROP_BIOME_MIX (0.16) of the room\'s own wall colour, not some other amount', () => {
    // Solve for the mix amount from the two observable outputs rather than hardcoding the
    // private base hue: outputEmber - outputNeutral = amount * (emberWall - neutralWall),
    // since both outputs share the same (unknown) base and the same amount.
    const emberWall = biomePalette('ember').wall;
    const neutralWall = biomePalette(undefined).wall;
    const emberBody = fills(bodyGraphics('crate', biomePalette('ember')))[0]!.color;
    const neutralBody = fills(bodyGraphics('crate', biomePalette(undefined)))[0]!.color;
    const channel = (hex: number, shift: number) => (hex >> shift) & 0xff;
    for (const shift of [16, 8]) { // R and G — B is identical between ember/neutral wall here
      const denom = channel(emberWall, shift) - channel(neutralWall, shift);
      expect(Math.abs(denom)).toBeGreaterThan(0); // guard: the two palettes must actually differ
      const amount = (channel(emberBody, shift) - channel(neutralBody, shift)) / denom;
      expect(amount).toBeCloseTo(0.16, 1);
    }
  });

  it('stays desaturated (env dressing, design/13) rather than reaching for a saturated pickup hue', () => {
    // The kind of regression this guards: someone reaching for THEME.colors.pickup* (bright,
    // saturated — reserved for loot/hazards) instead of the muted wood/stone tones here.
    for (const kind of ['crate', 'barrel'] as const) {
      const g = bodyGraphics(kind, biomePalette('ember'));
      for (const { color } of fills(g)) {
        const r = (color >> 16) & 0xff, gg = (color >> 8) & 0xff, b = color & 0xff;
        const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
        // A cheap saturation proxy: a bright saturated hue has a wide max-min spread relative
        // to its own brightness. Every wood/stone tone here is close to neutral by comparison.
        expect(max - min).toBeLessThan(90);
      }
    }
  });
});

describe('buildPropBody — real art, when a texture is supplied', () => {
  function tex(w = 64, h = 96): Texture {
    return new Texture({ source: new TextureSource({ width: w, height: h }) });
  }

  it('mounts a bottom-anchored sprite scaled by the kind\'s own width, art sets the height', () => {
    const t = tex(64, 128);
    const c = buildPropBody('barrel', biomePalette(undefined), t);
    const sprite = c.children.find((ch) => ch instanceof Sprite) as Sprite;
    expect(sprite).toBeDefined();
    expect(sprite.anchor.x).toBeCloseTo(0.5, 6);
    expect(sprite.anchor.y).toBeCloseTo(1, 6);
    const w = propFootprintWidth('barrel');
    expect(sprite.width).toBeCloseTo(w, 4);
    expect(sprite.height).toBeCloseTo(w * (128 / 64), 4);
    // No Graphics fallback drawn alongside the real art.
    expect(c.children.some((ch) => ch instanceof Graphics)).toBe(false);
  });

  it('lets the art\'s own aspect set the height — a wider file stands shorter', () => {
    const wide = buildPropBody('crate', biomePalette(undefined), tex(128, 64));
    const tall = buildPropBody('crate', biomePalette(undefined), tex(64, 128));
    const wideSprite = wide.children.find((ch) => ch instanceof Sprite) as Sprite;
    const tallSprite = tall.children.find((ch) => ch instanceof Sprite) as Sprite;
    expect(wideSprite.width).toBeCloseTo(tallSprite.width, 4); // same footprint width...
    expect(wideSprite.height).toBeLessThan(tallSprite.height); // ...different height
  });

  it('tints the sprite toward the room, so the art is not a fixed decal across biomes', () => {
    // The bug this exists for: the sprite branch took `palette` and never read it, so the
    // moment real art landed, `PROP_BIOME_MIX` silently stopped applying to anything the
    // player could see — the Graphics fallback kept mixing and the shipped sprite did not.
    const spriteFor = (biome: string | undefined) => {
      const c = buildPropBody('crate', biomePalette(biome), tex());
      return c.children.find((ch) => ch instanceof Sprite) as Sprite;
    };
    expect(spriteFor('ember').tint).not.toBe(0xffffff);
    expect(spriteFor('ember').tint).not.toBe(spriteFor('ice').tint);
  });

  it('pulls the sprite by the SAME amount the Graphics fallback pulls itself', () => {
    // Not just "a tint is set" — the two branches have to agree, or swapping between them
    // (which is exactly what a missing texture does) visibly changes the object's colour.
    // A sprite can only multiply, so the equivalent of mixing `mix` of the wall into a tone
    // is mixing `mix` of the wall into white: check the tint against that directly.
    const channel = (hex: number, shift: number) => (hex >> shift) & 0xff;
    for (const biome of ['ember', 'ice', undefined]) {
      const palette = biomePalette(biome);
      const t = propTint(palette);
      for (const shift of [16, 8, 0]) {
        const wall = channel(palette.wall, shift);
        const amount = (0xff - channel(t, shift)) / (0xff - wall);
        expect(amount).toBeCloseTo(0.16, 1);
      }
    }
  });

  it('leaves the tint a pure biome pull — white wall, white tint, art unchanged', () => {
    // Guards the direction of the mix. `mixHex(palette.wall, 0xffffff, MIX)` compiles, reads
    // the same, and is backwards: it would tint every prop nearly white and wash the art out.
    expect(propTint({ ...biomePalette(undefined), wall: 0xffffff })).toBe(0xffffff);
  });
});
