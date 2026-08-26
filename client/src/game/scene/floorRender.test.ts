/**
 * `floorRender.ts` — the floor's own variation (2026-08-20). What is worth pinning here is not any
 * colour but the three properties the look depends on:
 *
 * 1. **Coverage.** A stamped region must be covered exactly — no gap (the backdrop shows through)
 *    and no overhang (floor paints out into the void past the room). The old TilingSprite got this
 *    for free; a hand-built tile grid does not.
 * 2. **World alignment.** Two adjacent regions must produce tiles on the SAME lattice, or the stone
 *    steps at every room boundary.
 * 3. **Determinism.** Same room, same floor, every time and on every client (design/06's rule
 *    applied to the render layer, as with `Pickup`'s golden-angle bob phase). A `Math.random` here
 *    would be invisible in one screenshot and wrong in every co-op session.
 *
 * The decal counts are asserted as "scales with area and is not zero" rather than as exact numbers,
 * because the exact ones are tuning; what would be a real defect is a room that gets none.
 */
import { describe, it, expect } from 'vitest';
import { Graphics, Texture, TextureSource } from 'pixi.js';
import {
  drawDoorWear,
  drawFloorDecals,
  drawFloorMottle,
  drawRoomWash,
  hash2,
  stampFloor,
  tileVariant,
  unit,
} from './floorRender';
import type { RectPx } from './wallGeometry';
import { biomePalette } from '../theme';

function tex(size: number): Texture {
  return new Texture({ source: new TextureSource({ width: size, height: size }) });
}

/** A comparable digest of what was drawn into a Graphics: the fill colour/alpha and the geometry
 *  of each instruction. `JSON.stringify` on the instruction list itself cannot be used — a fill
 *  style holds a Texture, whose source holds an event emitter that closes a cycle back to it. */
function digest(g: Graphics): string {
  return g.context.instructions
    .map((ins) => {
      const data = ins.data as {
        style?: { color?: number; alpha?: number };
        path?: { instructions: { action: string; data: unknown[] }[] };
      };
      const style = `${data.style?.color ?? ''}@${data.style?.alpha ?? ''}`;
      const path = (data.path?.instructions ?? [])
        .map((p) => `${p.action}(${p.data.filter((v) => typeof v === 'number').map((v) => (v as number).toFixed(3)).join(',')})`)
        .join('|');
      return `${ins.action} ${style} ${path}`;
    })
    .join(';');
}

/** Every drawn shape, flattened across fills: `{action, data, color, alpha}`. Pixi merges
 *  consecutive same-style fills into ONE instruction carrying a path of many shapes, so counting
 *  instructions undercounts badly (nine identical glow rings arrive as one). */
function shapes(g: Graphics): { action: string; nums: number[]; color: number; alpha: number }[] {
  return g.context.instructions.flatMap((ins) => {
    const data = ins.data as {
      style?: { color?: number; alpha?: number };
      path?: { instructions: { action: string; data: unknown[] }[] };
    };
    return (data.path?.instructions ?? []).map((i) => ({
      action: i.action,
      nums: i.data.filter((v): v is number => typeof v === 'number'),
      color: data.style?.color ?? 0,
      alpha: data.style?.alpha ?? 0,
    }));
  });
}

/** Total area actually painted by a stamp, and its bounding box. `Sprite.width` is scale-signed for
 *  a mirrored tile, so both are taken as absolutes — a negative width here would mean the flip had
 *  moved the tile off its own cell, which is the bug `anchor.set(0.5)` exists to prevent. */
function painted(sprites: ReturnType<typeof stampFloor>): {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let area = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of sprites) {
    const w = Math.abs(s.width);
    const h = Math.abs(s.height);
    area += w * h;
    const x0 = s.x - w * s.anchor.x;
    const y0 = s.y - h * s.anchor.y;
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x0 + w);
    maxY = Math.max(maxY, y0 + h);
  }
  return { area, minX, minY, maxX, maxY };
}

describe('hash2 / unit — deterministic, and actually varying', () => {
  it('is stable for the same inputs and different for neighbours', () => {
    expect(hash2(3, 7)).toBe(hash2(3, 7));
    expect(hash2(3, 7)).not.toBe(hash2(4, 7));
    expect(hash2(3, 7)).not.toBe(hash2(3, 8));
    expect(hash2(-2, 5)).toBe(hash2(-2, 5)); // negative offsets happen: rooms can sit at any origin
  });

  it('spreads `unit` over 0..1 rather than clustering (a hash that always returns 0.5 is useless)', () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 400; i++) buckets[Math.min(9, Math.floor(unit(i, i * 3 + 1) * 10))]++;
    expect(Math.min(...buckets)).toBeGreaterThan(10); // every decile visited
    expect(Math.max(...buckets)).toBeLessThan(120); // none of them dominant
  });

  it('gives independent series per salt, so position/radius/alpha never move together', () => {
    expect(unit(5, 5, 1)).not.toBe(unit(5, 5, 2));
  });
});

describe('tileVariant — mirrors only', () => {
  it('is deterministic per grid cell and uses all four mirror combinations', () => {
    expect(tileVariant(2, 3)).toEqual(tileVariant(2, 3));
    const seen = new Set<string>();
    for (let j = 0; j < 12; j++) {
      for (let i = 0; i < 12; i++) {
        const v = tileVariant(i, j);
        seen.add(`${v.flipX ? 1 : 0}${v.flipY ? 1 : 0}`);
      }
    }
    expect(seen.size).toBe(4);
  });

  it('offers no rotation at all — a 90° turn would break a seamless tile\'s seams', () => {
    // The variant type carries flips and nothing else. Stated as a test because "just add a
    // rotation for more variety" is the obvious next idea and it is wrong: a seamless tile's left
    // edge matches its right edge, which is what makes a mirror safe; a rotation brings the other
    // axis's edges to the seam, where nothing guarantees a match.
    expect(Object.keys(tileVariant(1, 1)).sort()).toEqual(['flipX', 'flipY']);
  });
});

describe('stampFloor — covers its region exactly', () => {
  const region: RectPx = { x: 0, y: 0, w: 512, h: 384 };

  it('covers the whole region with no gap and no overhang', () => {
    const sprites = stampFloor(tex(256), region);
    const p = painted(sprites);
    expect(p.minX).toBeCloseTo(region.x, 3);
    expect(p.minY).toBeCloseTo(region.y, 3);
    expect(p.maxX).toBeCloseTo(region.x + region.w, 3);
    expect(p.maxY).toBeCloseTo(region.y + region.h, 3);
    // Tiles do not overlap, so painted area == region area exactly. (The old TilingSprite had this
    // trivially; a grid built by hand is where an off-by-one shows up as a seam of backdrop.)
    expect(p.area).toBeCloseTo(region.w * region.h, 3);
  });

  it('crops the partial row/column instead of letting it hang over the edge', () => {
    const sprites = stampFloor(tex(256), region); // 384 is 1.5 tiles tall
    const cropped = sprites.filter((s) => Math.abs(s.height) < 256 - 0.01);
    expect(cropped.length).toBe(2); // the bottom row, both columns
    for (const s of cropped) {
      expect(Math.abs(s.height)).toBeCloseTo(128, 3);
      expect(s.anchor.y).toBe(0); // positioned by its corner, and never mirrored
      expect(s.scale.x).toBe(1);
      expect(s.scale.y).toBe(1);
    }
  });

  it('puts the tile grid in WORLD space, so two regions line up instead of stepping', () => {
    // A region starting mid-tile must not restart the lattice at its own origin.
    const a = stampFloor(tex(256), { x: 0, y: 0, w: 256, h: 256 });
    const b = stampFloor(tex(256), { x: 300, y: 0, w: 500, h: 256 });
    expect(a[0]!.x).toBeCloseTo(128, 3); // centred in cell (0,0)
    const bMinX = Math.min(...b.map((s) => s.x - Math.abs(s.width) * s.anchor.x));
    expect(bMinX).toBeCloseTo(300, 3); // clipped to the region...
    // ...but its full tile still belongs to cell (2,0): 512..768 of the world lattice.
    const full = b.find((s) => Math.abs(s.width) >= 256 - 0.01)!;
    expect(full.x).toBeCloseTo(512 + 128, 3);
  });

  it('handles a region at a negative origin and a degenerate one', () => {
    expect(painted(stampFloor(tex(256), { x: -512, y: -256, w: 512, h: 256 })).area).toBeCloseTo(512 * 256, 3);
    expect(stampFloor(tex(256), { x: 0, y: 0, w: 0, h: 100 })).toHaveLength(0);
  });
});

describe('the floor variation layers', () => {
  const room: RectPx = { x: 0, y: 0, w: 512, h: 512 };

  it('draws mottle into both the dark and the additive layer, scaled by room area', () => {
    const smallDark = new Graphics();
    const smallLight = new Graphics();
    drawFloorMottle(smallDark, smallLight, { x: 0, y: 0, w: 256, h: 256 }, 1, 256);
    const bigDark = new Graphics();
    const bigLight = new Graphics();
    drawFloorMottle(bigDark, bigLight, { x: 0, y: 0, w: 1600, h: 1600 }, 1, 256);
    const count = (g: Graphics): number => g.context.instructions.length;
    expect(count(smallDark)).toBeGreaterThan(0);
    expect(count(smallLight)).toBeGreaterThan(0);
    expect(count(bigDark)).toBeGreaterThan(count(smallDark));
  });

  it('gives two rooms at different positions different washes, and the same room the same one', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const g = new Graphics();
      drawRoomWash(g, room, i);
      seen.add(digest(g));
    }
    expect(seen.size).toBeGreaterThan(10); // not one constant wash for every room

    const a = new Graphics();
    const b = new Graphics();
    drawRoomWash(a, room, 7);
    drawRoomWash(b, room, 7);
    expect(digest(a)).toBe(digest(b));
  });

  it('scatters stains and rubble inside the room, skipping the wall footprints', () => {
    const dark = new Graphics();
    const light = new Graphics();
    drawFloorDecals(dark, light, room, 3, []);
    const withWalls = new Graphics();
    const withWallsLight = new Graphics();
    // A wall covering the room's whole western half must swallow every speck that lands there.
    drawFloorDecals(withWalls, withWallsLight, room, 3, [{ x: 0, y: 0, w: 256, h: 512 }]);
    expect(withWallsLight.context.instructions.length).toBeLessThan(light.context.instructions.length);
    expect(withWallsLight.context.instructions.length).toBeGreaterThan(0);
  });

  it('is deterministic — the same room draws the identical decals twice', () => {
    const a = new Graphics();
    const aLight = new Graphics();
    const b = new Graphics();
    const bLight = new Graphics();
    drawFloorDecals(a, aLight, room, 42, []);
    drawFloorDecals(b, bLight, room, 42, []);
    expect(digest(a)).toBe(digest(b));
    expect(digest(aLight)).toBe(digest(bLight));
  });

  it('elongates door wear along the passage\'s SHORT axis — the direction of travel', () => {
    // A 64x128 passage is a hole through a wall 64 px thick: people walk across the 64, so the worn
    // patch reaches out along x. Getting this backwards would smear the wear along the wall.
    const tall = new Graphics();
    drawDoorWear(tall, { x: 0, y: 0, w: 64, h: 128 });
    const first = tall.context.instructions[0]!.data as { path: { instructions: { data: number[] }[] } };
    const [, , rx, ry] = first.path.instructions[0]!.data;
    expect(rx).toBeGreaterThan(ry);

    const wide = new Graphics();
    drawDoorWear(wide, { x: 0, y: 0, w: 128, h: 64 });
    const w1 = wide.context.instructions[0]!.data as { path: { instructions: { data: number[] }[] } };
    const [, , wrx, wry] = w1.path.instructions[0]!.data;
    expect(wry).toBeGreaterThan(wrx);
  });
});

describe('the variation layers, band by band — the decisions a mutation battery found untested', () => {
  const room: RectPx = { x: 0, y: 0, w: 512, h: 512 };

  it('offsets a cropped tile INTO the swatch, so a partial tile is not a repeat of its left edge', () => {
    // The crop's source frame has to move with the crop. Ignoring the offset draws the tile's
    // top-left corner at every partial cell instead — a duplicated strip along each room's east and
    // south edge, exactly where the eye is already looking for the wall line.
    const t = tex(256);
    const sprites = stampFloor(t, { x: 100, y: 60, w: 300, h: 300 });
    const partials = sprites.filter((sp) => Math.abs(sp.width) < 256 - 0.01 || Math.abs(sp.height) < 256 - 0.01);
    expect(partials.length).toBeGreaterThan(0);
    // The tile covering world x 100..256 is the right-hand 156 px of cell (0,0): source x = 100.
    const west = partials.find((sp) => Math.abs(sp.x - 100) < 0.01 && Math.abs(sp.y - 60) < 0.01)!;
    expect(west.texture.frame.x).toBeCloseTo(100, 3);
    expect(west.texture.frame.y).toBeCloseTo(60, 3);
    expect(west.texture.frame.width).toBeCloseTo(156, 3);
  });

  it('ramps each mottle blob to nothing at its rim instead of ending on an edge', () => {
    const dark = new Graphics();
    const light = new Graphics();
    drawFloorMottle(dark, light, { x: 0, y: 0, w: 512, h: 512 }, 5, 256);
    const ellipses = shapes(dark).filter((sh) => sh.action === 'ellipse');
    expect(ellipses.length).toBeGreaterThanOrEqual(4);
    // Within one blob the outermost band is the faintest and the radii shrink inward: a flat alpha
    // draws a visible arc on the floor, which is what the first three-band version did.
    const first = ellipses.slice(0, 3);
    expect(first[0]!.alpha).toBeLessThan(first[2]!.alpha);
    expect(first[0]!.nums[2]!).toBeGreaterThan(first[2]!.nums[2]!);
  });

  it('draws both a dark and an additive half of the mottle', () => {
    // Pixi fills only multiply down, so a floor with only dark mottle can only lose its mean.
    const dark = new Graphics();
    const light = new Graphics();
    drawFloorMottle(dark, light, room, 9, 256);
    expect(shapes(dark).length).toBeGreaterThan(0);
    expect(shapes(light).length).toBeGreaterThan(0);
  });

  it('uses BOTH wash directions across rooms, not one colour at varying alpha', () => {
    const colours = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const g = new Graphics();
      drawRoomWash(g, room, i);
      colours.add(shapes(g)[0]!.color);
    }
    expect(colours.size).toBe(2); // warm and cool — a room leans one way or the other
    // ...and the alpha genuinely varies too, or every room would lean by the same amount.
    const alphaValues = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const g = new Graphics();
      drawRoomWash(g, room, i);
      alphaValues.add(Math.round(shapes(g)[0]!.alpha * 1000));
    }
    expect(alphaValues.size).toBeGreaterThan(10);
  });

  it('scales the STAIN count with room area, not just the rubble', () => {
    const count = (w: number, h: number): number => {
      const dark = new Graphics();
      const light = new Graphics();
      drawFloorDecals(dark, light, { x: 0, y: 0, w, h }, 4, []);
      // Stains are the only dark ellipses whose radius is over 10 px; rubble specks are ~2-4.
      return shapes(dark).filter((sh) => sh.action === 'ellipse' && sh.nums[2]! > 10).length;
    };
    expect(count(1600, 1600)).toBeGreaterThan(count(320, 320));
    expect(count(320, 320)).toBeGreaterThan(0);
  });

  it('lights every rubble speck from the upper LEFT, like everything else in the room', () => {
    // The one direction every surface in this project agrees on (`Entity.SHADOW_SLANT_*`, the wall
    // cap's key light, the pillar shading). A highlight on the wrong side of a speck is invisible
    // on its own and wrong in aggregate: a floor lit from the other side than its walls.
    const dark = new Graphics();
    const light = new Graphics();
    drawFloorDecals(dark, light, room, 11, []);
    const specks = shapes(dark).filter((sh) => sh.action === 'ellipse' && sh.nums[2]! <= 10);
    const highlights = shapes(light).filter((sh) => sh.action === 'ellipse');
    expect(specks.length).toBeGreaterThan(5);
    expect(highlights.length).toBe(specks.length);
    for (let i = 0; i < specks.length; i++) {
      expect(highlights[i]!.nums[0]!).toBeLessThan(specks[i]!.nums[0]!); // up-light in x
      expect(highlights[i]!.nums[1]!).toBeLessThan(specks[i]!.nums[1]!); // and in y
    }
  });

  it('graduates the door wear instead of stamping one hard ellipse', () => {
    const g = new Graphics();
    drawDoorWear(g, { x: 0, y: 0, w: 64, h: 128 });
    const ellipses = shapes(g).filter((sh) => sh.action === 'ellipse');
    expect(ellipses.length).toBeGreaterThanOrEqual(3);
    // Concentric and shrinking: the widest first, so the rim is the faintest part of the patch.
    for (let i = 1; i < ellipses.length; i++) {
      expect(ellipses[i]!.nums[2]!).toBeLessThan(ellipses[i - 1]!.nums[2]!);
    }
  });
});

/**
 * Rec.709 luma of a packed 0xRRGGBB, on 0..255 — the same coefficients `perf/frameProbe.ts` reads a
 * real frame with, so a number here and a number off the screen mean the same thing.
 */
function lumaOf(hex: number): number {
  return 0.2126 * ((hex >> 16) & 0xff) + 0.7152 * ((hex >> 8) & 0xff) + 0.0722 * (hex & 0xff);
}

/** Every floor tone the game can actually paint: `biomePalette` resolves an unknown id to neutral,
 *  so these two ids are the two distinct palettes reachable from shipped content. */
const FLOOR_TONES = [undefined, 'ember'].map((id) => ({
  id: id ?? '(neutral)',
  luma: lumaOf(biomePalette(id).ground),
}));

describe('the worn patch across a doorway is VISIBLE — the decision a battery found unmeasured', () => {
  // `drawDoorWear`'s five constants had their GEOMETRY covered (elongation axis, band count, the
  // radius ramp, the centre) and its VALUE covered by nothing at all: a 2026-08-26 battery over
  // this file found `WEAR_ALPHA` 0.05 -> 0.01, 0.05 -> 0.2 and `WEAR_COLOR` -> a floor-coloured
  // hex all surviving the entire client suite. That matters more here than it looks: the patch
  // exists to say "this hole in the stone is a threshold you can walk through", which is the whole
  // reason the arena's 74 passages got one (2026-08-26, `arenaWallCoverage.test.ts`) — and a patch
  // nobody can see is the same as no patch, which is the defect it was added to fix.
  //
  // So the assertion is on the EFFECT, not on the constants: the patch lands on `floorLight`, whose
  // `blendMode = 'add'` is pinned by `groundLayer.test.ts`, so each band contributes
  // `luma(colour) * alpha` on top of whatever floor is under it, independent of that floor's tone.
  // Bounds are argued from what a player can see rather than transcribed from today's numbers, and
  // today's numbers sit ~2x inside both of them.

  /** A visible step. 1 level is the 8-bit quantisation floor; 3 is the smallest difference that
   *  reads as a difference rather than as dither, which is the claim being made. */
  const JND = 3;
  /** Above this the patch stops reading as worn stone and starts reading as a light source on the
   *  floor — it would be brighter than the neutral floor's own entire value (25.9). */
  const LAMP = 45;

  const bandsOf = (door: RectPx): Array<{ color: number; alpha: number }> => {
    const g = new Graphics();
    drawDoorWear(g, door);
    return g.context.instructions.map(
      (ins) => (ins.data as { style: { color: number; alpha: number } }).style,
    );
  };

  it('adds a visible step at its faintest edge, and stays short of reading as a lamp at its centre', () => {
    const bands = bandsOf({ x: 0, y: 0, w: 64, h: 96 });
    expect(bands.length).toBeGreaterThan(1); // concentric bands, not one flat blob
    const perBand = bands.map((s) => lumaOf(s.color) * s.alpha);
    // The bands are concentric, so the OUTER ring gets exactly one of them — that ring is where the
    // patch either reads or does not, which makes the faintest single band the visibility case.
    const faintest = Math.min(...perBand);
    const centre = perBand.reduce((a, b) => a + b, 0);
    expect(faintest, `faintest band adds ${faintest.toFixed(2)} luma`).toBeGreaterThan(JND); // 5.62
    expect(centre, `patch centre adds ${centre.toFixed(2)} luma`).toBeLessThan(LAMP); // 22.49
    // ...and the centre is a real amount of light, not JND x 4 — the patch has a readable gradient
    // from its rim to its middle, which is what makes it read as wear rather than as a decal.
    expect(centre / faintest).toBeGreaterThan(2);
  });

  it('is visible on every floor tone the game paints, and washes none of them out', () => {
    // The same two bounds re-asked as CONTRAST against the actual floor, because "3 luma" is only a
    // visible step relative to something. Both palettes are dark stone (25.9 and 27.0), so the
    // centre of the patch is a little under double the bare floor — and nothing clips to white.
    const centre = bandsOf({ x: 0, y: 0, w: 96, h: 64 })
      .map((s) => lumaOf(s.color) * s.alpha)
      .reduce((a, b) => a + b, 0);
    expect(FLOOR_TONES.length).toBeGreaterThan(1); // the sweep is a sweep
    for (const tone of FLOOR_TONES) {
      const ratio = centre / tone.luma;
      expect(ratio, `${tone.id}: patch centre is ${ratio.toFixed(2)}x its floor`).toBeGreaterThan(0.25);
      expect(ratio, `${tone.id}: patch centre is ${ratio.toFixed(2)}x its floor`).toBeLessThan(2.5);
      expect(tone.luma + centre, `${tone.id} clips to white`).toBeLessThan(200);
    }
  });

  it('and both bounds can really fire — the same arithmetic on the mutants that survived', () => {
    // The control this pair of bounds needs, for the reason the whole block exists: a bound nobody
    // has watched fail is a bound that might not be measuring anything. These are the three
    // surviving mutants, run through the identical computation.
    const bands = bandsOf({ x: 0, y: 0, w: 64, h: 96 });
    const colour = bands[0]!.color;
    const alpha = bands[0]!.alpha;
    const n = bands.length;
    expect(lumaOf(colour) * 0.01).toBeLessThan(JND); // WEAR_ALPHA 0.05 -> 0.01: 1.12, invisible
    expect(lumaOf(colour) * 0.2 * n).toBeGreaterThan(LAMP); // -> 0.2: 89.98, a lamp
    expect(lumaOf(0x3a3630) * alpha).toBeLessThan(JND); // a floor-coloured WEAR_COLOR: 2.72
  });
});
