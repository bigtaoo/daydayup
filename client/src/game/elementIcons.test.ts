/**
 * `elementIcons` exists to be a SECOND channel. Every test here is therefore about the
 * property that makes it one — that the five glyphs are actually different pictures, that
 * each is solid enough to survive the size it is drawn at, and that neither of the two
 * silhouettes design/13 borrowed from elsewhere in this game has converged with its
 * original. A layout-box test alone would pass just as happily on five identical circles,
 * which would be a fake second channel and precisely the bug worth guarding.
 */
import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import type { DamageType } from '@dd/engine';
import {
  drawElementGlyph,
  drawElementBadge,
  elementBadgeRadius,
  ELEMENT_GLYPH_HOLE,
} from './elementIcons';
import { drawHudIcon } from './ui/hudIcons';
import { elementColor } from './theme';

/** Enumerated from design/13's locked five, not from a loop over some registry — if a sixth
 *  element is ever added, this list failing to mention it is the correct outcome. */
const ALL: readonly DamageType[] = ['fire', 'ice', 'lightning', 'poison', 'physical'];

const STROKE_SLOP = 2;

function drawn(element: DamageType, cx = 20, cy = 20, r = 8, color = 0xffffff): Graphics {
  const g = new Graphics();
  drawElementGlyph(g, element, cx, cy, r, color);
  return g;
}

interface PathInstr {
  action: string;
  data: unknown[];
}
interface Instr {
  action: string;
  data: { style?: { color?: number; alpha?: number }; path?: { instructions: PathInstr[] } };
}

function instrs(g: Graphics): Instr[] {
  return g.context.instructions as unknown as Instr[];
}

/** Every path primitive drawn, flattened, as `action(numbers…)` — the same digest shape
 *  `doorRender.test.ts` uses, and for the same reason (the instruction list itself holds
 *  cyclic Texture references and cannot be stringified).
 *
 *  It flattens ONE level of nesting, which that file's version does not, and the difference
 *  is load-bearing: `poly` carries its vertices as a nested `number[]`, so a digest that only
 *  kept top-level numbers rendered every poly-only glyph as the empty string `poly()` — the
 *  ice star and the lightning bolt came out byte-identical. The distinctness test below caught
 *  it, which is the whole reason to write that test as a sweep over the real glyphs rather than
 *  as a fixture: the fixture would have made two different things equal. */
function numbersIn(data: unknown[]): string {
  const out: number[] = [];
  for (const v of data) {
    if (typeof v === 'number') out.push(v);
    else if (Array.isArray(v)) for (const n of v) if (typeof n === 'number') out.push(n);
  }
  return out.map((n) => n.toFixed(2)).join(',');
}

function shapeDigest(g: Graphics): string {
  return instrs(g)
    .map((ins) => {
      // `moveTo` is Pixi's own path bookkeeping, emitted or not depending on what was drawn
      // into the same Graphics before this shape. Keeping it would make an identical glyph
      // digest differently on a bare Graphics than inside a badge, which is exactly the
      // comparison the badge tests below need to make.
      const path = (ins.data.path?.instructions ?? [])
        .filter((i) => i.action !== 'moveTo')
        .map((i) => `${i.action}(${numbersIn(i.data)})`)
        .join('|');
      return `${ins.action} ${ins.data.style?.color ?? ''} ${path}`;
    })
    .join(';');
}

/** Guard for the digest itself: it must actually record vertex data, or every distinctness
 *  assertion above it passes vacuously. Two polys that differ only in their points must
 *  digest differently. */
function digestSeesVertices(): boolean {
  const a = new Graphics().poly([0, 0, 10, 0, 5, 9]).fill({ color: 0xffffff });
  const b = new Graphics().poly([0, 0, 20, 0, 5, 9]).fill({ color: 0xffffff });
  return shapeDigest(a) !== shapeDigest(b);
}

/**
 * Total filled AREA, as a fraction of the (2r x 2r) box — shoelace for polys, pi-r-squared for
 * circles, minus anything drawn in the hole colour. Bounds are NOT a substitute: a six-armed
 * hairline star fills its whole bounding box and 1.5% of its area, which is exactly the
 * "measures correct, invisible at the size it is drawn" defect `art/props/prompts.md` records.
 */
function areaFraction(g: Graphics, r: number, hole = ELEMENT_GLYPH_HOLE): number {
  let a = 0;
  for (const ins of instrs(g)) {
    if (ins.action !== 'fill') continue;
    const sign = ins.data.style?.color === hole ? -1 : 1;
    for (const pi of ins.data.path?.instructions ?? []) {
      if (pi.action === 'circle') {
        const [, , rad] = pi.data as number[];
        a += sign * Math.PI * rad! * rad!;
      } else if (pi.action === 'poly') {
        const pts = (pi.data.find((v) => Array.isArray(v)) ?? []) as number[];
        let sh = 0;
        for (let i = 0; i < pts.length; i += 2) {
          const j = (i + 2) % pts.length;
          sh += pts[i]! * pts[j + 1]! - pts[j]! * pts[i + 1]!;
        }
        a += (sign * Math.abs(sh)) / 2;
      } else if (pi.action === 'roundRect') {
        const [, , w, h] = pi.data as number[];
        a += sign * w! * h!;
      }
    }
  }
  return a / (4 * r * r);
}

/** Vertices of every poly drawn, as offsets from (cx, cy). */
function polyVertices(g: Graphics, cx: number, cy: number): Array<Array<[number, number]>> {
  return instrs(g).flatMap((ins) =>
    (ins.data.path?.instructions ?? [])
      .filter((pi) => pi.action === 'poly')
      .map((pi) => {
        const pts = (pi.data.find((v) => Array.isArray(v)) ?? []) as number[];
        const out: Array<[number, number]> = [];
        for (let i = 0; i < pts.length; i += 2) out.push([pts[i]! - cx, pts[i + 1]! - cy]);
        return out;
      }),
  );
}

/** Every fill's alpha in draw order. */
function fillAlphas(g: Graphics): number[] {
  return instrs(g)
    .filter((i) => i.action === 'fill')
    .map((i) => i.data.style?.alpha ?? 1);
}

/** Every stroke's alpha in draw order. */
function strokeAlphas(g: Graphics): number[] {
  return instrs(g)
    .filter((i) => i.action === 'stroke')
    .map((i) => i.data.style?.alpha ?? 1);
}

/** Circles drawn into `g`, as `[cx, cy, r]`. */
function circles(g: Graphics): number[][] {
  return instrs(g).flatMap((ins) =>
    (ins.data.path?.instructions ?? [])
      .filter((pi) => pi.action === 'circle')
      .map((pi) => pi.data.filter((v): v is number => typeof v === 'number')),
  );
}

/** Circles drawn in the HOLE colour — a punched detail rather than part of the mass. */
function holes(g: Graphics, hole = ELEMENT_GLYPH_HOLE): number[][] {
  return instrs(g)
    .filter((ins) => ins.data.style?.color === hole)
    .flatMap((ins) =>
      (ins.data.path?.instructions ?? [])
        .filter((pi) => pi.action === 'circle')
        .map((pi) => pi.data.filter((v): v is number => typeof v === 'number')),
    );
}

describe('drawElementGlyph — layout contract (same as drawHudIcon)', () => {
  it.each(ALL)('%s draws visible geometry', (element) => {
    const b = drawn(element).getLocalBounds();
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  });

  it.each(ALL)('%s stays inside its declared (cx±r, cy±r) box', (element) => {
    const cx = 20;
    const cy = 20;
    const r = 8;
    const b = drawn(element, cx, cy, r).getLocalBounds();
    expect(b.left).toBeGreaterThanOrEqual(cx - r - STROKE_SLOP);
    expect(b.right).toBeLessThanOrEqual(cx + r + STROKE_SLOP);
    expect(b.top).toBeGreaterThanOrEqual(cy - r - STROKE_SLOP);
    expect(b.bottom).toBeLessThanOrEqual(cy + r + STROKE_SLOP);
  });

  it.each(ALL)('%s scales with r rather than baking in a pixel size', (element) => {
    const small = drawn(element, 40, 40, 4).getLocalBounds();
    const large = drawn(element, 40, 40, 16).getLocalBounds();
    expect(large.width).toBeGreaterThan(small.width * 3);
    expect(large.height).toBeGreaterThan(small.height * 3);
  });

  it.each(ALL)('%s translates with (cx, cy)', (element) => {
    const at0 = drawn(element, 0, 0, 8).getLocalBounds();
    const at100 = drawn(element, 100, 60, 8).getLocalBounds();
    expect(at100.left - at0.left).toBeCloseTo(100, 4);
    expect(at100.top - at0.top).toBeCloseTo(60, 4);
    expect(at100.width).toBeCloseTo(at0.width, 4);
  });

  it.each(ALL)('%s appends rather than clearing (a badge draws chip then glyph)', (element) => {
    const g = new Graphics();
    drawElementGlyph(g, element, 20, 20, 8, 0xffffff);
    const one = g.getLocalBounds().width;
    drawElementGlyph(g, element, 60, 20, 8, 0xffffff);
    expect(g.getLocalBounds().width).toBeGreaterThan(one);
  });

  it.each(ALL)('%s draws in the colour it was handed, not a baked one', (element) => {
    const g = drawn(element, 20, 20, 8, 0x123456);
    const colors = instrs(g).map((i) => i.data.style?.color);
    expect(colors).toContain(0x123456);
  });
});

describe('drawElementGlyph — the glyphs are five different pictures', () => {
  it('the shape digest can tell two polys apart at all (guards the tests below)', () => {
    expect(digestSeesVertices()).toBe(true);
  });

  it('no two elements draw the same geometry', () => {
    const seen = new Map<string, DamageType>();
    for (const element of ALL) {
      const d = shapeDigest(drawn(element));
      const clash = seen.get(d);
      expect(clash, `${element} draws the same shape as ${clash}`).toBeUndefined();
      seen.set(d, element);
    }
    expect(seen.size).toBe(ALL.length);
  });

  it('every glyph spans its box in both axes', () => {
    const r = 8;
    for (const element of ALL) {
      const b = drawn(element, 20, 20, r).getLocalBounds();
      expect(b.width, element).toBeGreaterThan(r); // > half the box across
      expect(b.height, element).toBeGreaterThan(r);
    }
  });

  it('every glyph fills a real share of its box by AREA, not just by extent', () => {
    // The measure that matters, and the one bounds cannot give. Measured on the shipped
    // glyphs: bolt 0.158 (the thinnest, and correctly so — it is a zigzag), ice 0.345, fire
    // 0.410, gem 0.522, skull 0.550. A hairline six-armed star measures 0.015 and fills its
    // bounding box completely, so an extent test passes it and this one does not.
    const r = 8;
    for (const element of ALL) {
      expect(areaFraction(drawn(element, 20, 20, r), r), element).toBeGreaterThan(0.1);
    }
  });

  it('at the smallest size the world actually draws (r = 3) every glyph is still >= 3 px across', () => {
    // `Actor`'s aura floor is 3 and `Pickup`'s weapon badge glyph is 3 — the sizes that decide
    // whether the icon channel exists in play at all, rather than only in a unit test at r = 8.
    for (const element of ALL) {
      const b = drawn(element, 20, 20, 3).getLocalBounds();
      expect(b.width, element).toBeGreaterThanOrEqual(3);
      expect(b.height, element).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('drawElementGlyph — the shape each glyph has to keep to mean what it means', () => {
  it('ice keeps SIXFOLD symmetry, which is the part that says frost', () => {
    // A five-pointed version measures as a perfectly good solid star and is the `score` HUD
    // chip. Sixfold is the whole read, so it is asserted on the vertices rather than left to a
    // digest comparison (a 5-point star at a slightly different inner radius digests
    // differently from the score chip while looking identical to a player).
    const r = 8;
    const verts = polyVertices(drawn('ice', 20, 20, r), 20, 20);
    expect(verts).toHaveLength(1);
    const pts = verts[0]!;
    expect(pts).toHaveLength(12); // 6 outer + 6 inner
    const outer = pts.filter(([x, y]) => Math.abs(Math.hypot(x, y) - r) < 1e-6);
    expect(outer).toHaveLength(6);
  });

  it('the score HUD chip is a FIVE-point star, so ice cannot quietly become it', () => {
    const g = new Graphics();
    drawHudIcon(g, 'score', 20, 20, 8, 0xffffff);
    expect(polyVertices(g, 20, 20)[0]).toHaveLength(10);
  });

  it('the flame carries its inner core, which is what stops it reading as a leaf', () => {
    const alphas = fillAlphas(drawn('fire', 20, 20, 8));
    expect(alphas.length).toBeGreaterThanOrEqual(2);
    // The core is a translucent highlight over the solid body: one fill fully opaque, one not.
    expect(alphas.some((a) => a === 1)).toBe(true);
    expect(alphas.some((a) => a > 0.15 && a < 1)).toBe(true);
  });

  it('the gem carries its table facet, for the same reason', () => {
    const alphas = fillAlphas(drawn('physical', 20, 20, 8));
    expect(alphas.some((a) => a > 0.15 && a < 1)).toBe(true);
  });
});

describe('the two silhouette collisions design/13 created, pinned as invariants', () => {
  it("physical's gem is WIDER than tall; the material crystal it must not become is TALLER than wide", () => {
    // Resolved by silhouette, not by renaming — so the resolution has to be a measurement, or
    // the next edit to either shape can quietly converge them and nothing would say so.
    const gem = drawn('physical', 20, 20, 8).getLocalBounds();
    const crystal = new Graphics();
    drawHudIcon(crystal, 'banked', 20, 20, 8, 0xffffff);
    const shard = crystal.getLocalBounds();
    expect(gem.width / gem.height).toBeGreaterThan(1);
    expect(shard.width / shard.height).toBeLessThan(1);
  });

  it("poison keeps the locked skull (two off-centre sockets); the enemies chip is now a ONE-eyed head", () => {
    const skull = holes(drawn('poison', 20, 20, 8));
    expect(skull).toHaveLength(2);
    // Two sockets, mirrored either side of the centre — a skull.
    expect(skull[0]![0]).toBeLessThan(20);
    expect(skull[1]![0]).toBeGreaterThan(20);

    const critter = new Graphics();
    drawHudIcon(critter, 'enemies', 20, 20, 8, 0xffffff);
    const eye = holes(critter, 0x0b0e14);
    expect(eye).toHaveLength(1);
    expect(eye[0]![0]).toBeCloseTo(20, 6); // centred — one eye, not a pair of sockets
  });
});

describe('drawElementBadge', () => {
  it.each(ALL)('%s draws a chip of exactly elementBadgeRadius(r), in the element hue', (element) => {
    const g = new Graphics();
    const r = 6;
    drawElementBadge(g, element, 50, 30, r);
    const chip = elementBadgeRadius(r);
    // The chip is the first (largest) circle drawn; the ring is half a px inside it.
    const cs = circles(g);
    expect(cs[0]).toEqual([50, 30, chip]);
    const colors = instrs(g).map((i) => i.data.style?.color);
    expect(colors).toContain(elementColor(element));
  });

  it.each(ALL)('%s keeps the whole badge inside the chip it advertises', (element) => {
    const g = new Graphics();
    const r = 6;
    drawElementBadge(g, element, 0, 0, r);
    const b = g.getLocalBounds();
    const chip = elementBadgeRadius(r);
    expect(b.left).toBeGreaterThanOrEqual(-chip - STROKE_SLOP);
    expect(b.right).toBeLessThanOrEqual(chip + STROKE_SLOP);
    expect(b.top).toBeGreaterThanOrEqual(-chip - STROKE_SLOP);
    expect(b.bottom).toBeLessThanOrEqual(chip + STROKE_SLOP);
  });

  it('the chip leaves real margin around the glyph (a glyph merging into its border is one blob)', () => {
    const glyphR = 6;
    expect(elementBadgeRadius(glyphR)).toBeGreaterThan(glyphR * 1.2);
  });

  it('badges are element-distinct too, not just glyphs (the chip must not swamp the glyph)', () => {
    const seen = new Set<string>();
    for (const element of ALL) {
      const g = new Graphics();
      drawElementBadge(g, element, 0, 0, 6);
      seen.add(shapeDigest(g));
    }
    expect(seen.size).toBe(ALL.length);
  });

  it.each(ALL)('%s badge actually contains the glyph, not just the chip', (element) => {
    // The distinctness test above passes on a badge that draws NO glyph at all — five chips
    // whose rings differ in colour are still five different digests. So the glyph's own
    // geometry is asserted directly, against an independently drawn reference.
    const r = 6;
    const badge = new Graphics();
    drawElementBadge(badge, element, 50, 30, r);
    const reference = new Graphics();
    drawElementGlyph(reference, element, 50, 30, r, elementColor(element), ELEMENT_GLYPH_HOLE);
    expect(shapeDigest(badge)).toContain(shapeDigest(reference));
  });

  it('the chip is an opaque-enough backing plate to be one (design/13 dark background)', () => {
    // The chip exists because the icon channel has to survive a lit stone floor or a tinted
    // body behind it. A near-transparent plate is not a plate.
    const g = new Graphics();
    drawElementBadge(g, 'fire', 0, 0, 6);
    expect(fillAlphas(g)[0]).toBeGreaterThan(0.6);
  });

  it('the ring reads as a ring (an element-hue outline, not a ghost)', () => {
    const g = new Graphics();
    drawElementBadge(g, 'fire', 0, 0, 6);
    expect(Math.max(...strokeAlphas(g))).toBeGreaterThan(0.6);
  });
});
