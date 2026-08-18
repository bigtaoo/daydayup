/**
 * `rigShading` — the depth-cue marks a rig draws on top of its own flat-cel art (2026-08-18,
 * user report *"希望能再强化一下立体效果"*). Split out of RigSkin.ts; `RigSkin.test.ts` covers
 * how they are wired into the rig, this file covers the geometry and colour maths.
 *
 * The two properties worth machine-checking are the ones a hand-tuned constant can silently
 * break: every mark must stay strictly INSIDE the body radius (nothing may spill onto the
 * transparent background, which is what lets this work with no mask), and the highlight and
 * the terminator must sit on OPPOSITE sides — a sphere lit from one direction, not two.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { drawSphereShading, shadeHex, MODULE_BEHIND_SCALE, MODULE_BEHIND_SHADE, SHADE_MIN_BODY_R } from './rigShading';

describe('drawSphereShading — the marks that make a flat-cel body read as a sphere', () => {
  it('keeps every mark strictly inside the body radius, so none can spill past the silhouette', () => {
    // The whole reason no mask/clip is needed (a mask per actor would be 30 stencil passes in
    // a busy room). If a tuning change pushed a highlight ring or an arc stroke past the rim,
    // it would render as a grey/white blob on transparent background outside the character.
    for (const bodyR of [24, 40, 50, 70]) {
      const b = drawSphereShading(bodyR).bounds;
      const reach = Math.max(-b.minX, b.maxX, -b.minY, b.maxY);
      expect(reach).toBeLessThanOrEqual(bodyR);
    }
  });

  it('draws real geometry, scaled with the body it is given', () => {
    const small = drawSphereShading(24).bounds;
    const big = drawSphereShading(70).bounds;
    expect(small.width).toBeGreaterThan(0);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.width / small.width).toBeCloseTo(70 / 24, 1);
  });

  it('is symmetric about the body centre, so it lines up with the art it sits on', () => {
    // Both the rim circle and the terminator arcs are centred on (0,0) — the bone tip, which
    // is where the rig itself puts the bodyR circle the art was sized against.
    const b = drawSphereShading(40).bounds;
    expect(b.minX).toBeCloseTo(-b.maxX, 0);
  });
});

describe('shadeHex — the far-side module\'s depth tint', () => {
  it('darkens every channel without changing hue', () => {
    expect(shadeHex(0xffffff, 0.5)).toBe(0x808080);
    expect(shadeHex(0x8040c0, 0.5)).toBe(0x402060);
  });

  it('is the identity at factor 1, so a front-facing module is never re-tinted', () => {
    expect(shadeHex(0x66e0ff, 1)).toBe(0x66e0ff);
    expect(shadeHex(0xffffff, 1)).toBe(0xffffff);
  });

  it('saturates rather than wrapping — a factor over 1 can never roll a channel to black', () => {
    // A wrap would flip a bright element colour to a dark one, which is exactly the kind of
    // bug a bit-shifted colour helper invites.
    expect(shadeHex(0xffffff, 2)).toBe(0xffffff);
    expect(shadeHex(0x80ff40, 4)).toBe(0xffffff);
  });

  it('clamps at black, never below', () => {
    expect(shadeHex(0x102030, 0)).toBe(0x000000);
  });
});

describe('the module depth-cue constants', () => {
  it('make a far-side module both smaller and darker, but still clearly visible', () => {
    // The z-flip alone reads as "it changed layer"; scale + shade turn it into an orbit.
    // Neither may be so aggressive that the module disappears while the player is aiming
    // north, which is a third of the time in a twin-stick game.
    expect(MODULE_BEHIND_SCALE).toBeGreaterThan(0.7);
    expect(MODULE_BEHIND_SCALE).toBeLessThan(1);
    expect(MODULE_BEHIND_SHADE).toBeGreaterThan(0.5);
    expect(MODULE_BEHIND_SHADE).toBeLessThan(1);
  });

  it('sets the shading threshold above a decorative bone\'s radius and below a body\'s', () => {
    // orb-core: shell 40 (shaded), socket 13 (not); critter-core body 50; boss-core core 70.
    expect(SHADE_MIN_BODY_R).toBeGreaterThan(13);
    expect(SHADE_MIN_BODY_R).toBeLessThan(40);
  });
});

/** Filled ellipses drawn into `g`, as `[cx, cy, rx, ry]` — the specular highlight's rings. */
function highlightEllipses(g: Graphics): number[][] {
  const out: number[][] = [];
  for (const i of g.context.instructions as Instr[]) {
    if (i.action !== 'fill') continue;
    for (const pi of i.data.path?.instructions ?? []) if (pi.action === 'ellipse') out.push(pi.data);
  }
  return out;
}

/** Stroked arcs drawn into `g`, as `[cx, cy, radius, startAngle, endAngle]` — the terminator.
 *  The full-perimeter rim AO is a `circle`, not an `arc`, so it is excluded by construction. */
function terminatorArcs(g: Graphics): number[][] {
  const out: number[][] = [];
  for (const i of g.context.instructions as Instr[]) {
    if (i.action !== 'stroke') continue;
    for (const pi of i.data.path?.instructions ?? []) if (pi.action === 'arc') out.push(pi.data);
  }
  return out;
}

interface Instr {
  action: string;
  data: { style?: { color: number; alpha: number }; path?: { instructions: Array<{ action: string; data: number[] }> } };
}

// This is the assertion that actually holds the sphere read together, and the one a single sign
// flip in SHADE_KEY_ANGLE would silently invert — leaving the highlight and the shadow stacked on
// the same side, which reads as a smudge rather than as a lit form.
describe('drawSphereShading — the light has one direction, and the two marks oppose it', () => {
  const bodyR = 40;

  it('puts the specular highlight toward the upper LEFT — the project\'s one key-light direction', () => {
    // Shared with NormalLitFilter's KEY_DIR and RoomBuilder's pillar banding: "lit from upper
    // left" is a single convention, and screen space is y-down, so both components are negative.
    for (const [cx, cy] of highlightEllipses(drawSphereShading(bodyR))) {
      expect(cx).toBeLessThan(0);
      expect(cy).toBeLessThan(0);
    }
  });

  it('puts the terminator on the diametrically OPPOSITE side, toward the lower right', () => {
    const arcs = terminatorArcs(drawSphereShading(bodyR));
    expect(arcs.length).toBeGreaterThan(2);
    for (const [cx, cy, , start, end] of arcs) {
      expect(cx).toBe(0); // concentric on the body, unlike the highlight
      expect(cy).toBe(0);
      const mid = (start! + end!) / 2;
      expect(Math.cos(mid)).toBeGreaterThan(0); // to the east...
      expect(Math.sin(mid)).toBeGreaterThan(0); // ...and, y-down, to the south
    }
  });

  it('holds highlight and terminator a full 180° apart, not merely on different sides', () => {
    const g = drawSphereShading(bodyR);
    const [hx, hy] = highlightEllipses(g)[0]!;
    const arc = terminatorArcs(g)[0]!;
    const mid = (arc[3]! + arc[4]!) / 2;
    const hLen = Math.hypot(hx!, hy!);
    // Unit dot product of the two directions: -1 means exactly opposed.
    const dot = (hx! / hLen) * Math.cos(mid) + (hy! / hLen) * Math.sin(mid);
    expect(dot).toBeCloseTo(-1, 6);
  });

  it('narrows and fades the terminator inward, so it falls off instead of banding', () => {
    const g = drawSphereShading(bodyR);
    const strokes = (g.context.instructions as Instr[]).filter(
      (i) => i.action === 'stroke' && (i.data.path?.instructions ?? []).some((pi) => pi.action === 'arc'),
    );
    const arcs = terminatorArcs(g);
    let lastRadius = Infinity;
    let lastSpan = Infinity;
    let lastAlpha = Infinity;
    for (let i = 0; i < arcs.length; i++) {
      const [, , radius, start, end] = arcs[i]!;
      const span = end! - start!;
      expect(radius!).toBeLessThan(lastRadius);
      expect(span).toBeLessThan(lastSpan);
      expect(strokes[i]!.data.style!.alpha).toBeLessThan(lastAlpha);
      lastRadius = radius!;
      lastSpan = span;
      lastAlpha = strokes[i]!.data.style!.alpha;
    }
  });

  it('brightens the highlight toward its core and darkens nothing else light', () => {
    // The highlight is the only light mark; every other instruction is a dark one. A tuning
    // change that made the terminator light would read as two highlights.
    const g = drawSphereShading(bodyR);
    const fills = (g.context.instructions as Instr[]).filter((i) => i.action === 'fill');
    const strokes = (g.context.instructions as Instr[]).filter((i) => i.action === 'stroke');
    for (const f of fills) expect(f.data.style!.color).toBe(0xffffff);
    for (const s of strokes) expect(s.data.style!.color).not.toBe(0xffffff);
    // ...and the innermost highlight ring is the most opaque, so it reads as a specular point.
    const alphas = fills.map((f) => f.data.style!.alpha);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]).toBeGreaterThan(alphas[i - 1]!);
  });

  it('strengthens the marks enough to survive near-white flat-cel art', () => {
    // design/13's shells are near-white, and the first tuning (terminator alphas 0.20 down to
    // 0.08) was invisible over them in a 7x render. This is a floor on that lesson.
    const strokes = (drawSphereShading(bodyR).context.instructions as Instr[])
      .filter((i) => i.action === 'stroke');
    expect(Math.max(...strokes.map((s) => s.data.style!.alpha))).toBeGreaterThan(0.25);
  });
});
