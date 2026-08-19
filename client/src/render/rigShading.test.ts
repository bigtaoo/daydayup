/**
 * `rigShading` — the depth-cue marks a rig draws on top of its own flat-cel art (2026-08-18,
 * user report *"希望能再强化一下立体效果"*). Split out of RigSkin.ts; `RigSkin.test.ts` covers
 * how they are wired into the rig, this file covers the geometry and colour maths.
 *
 * **Rewritten 2026-08-19** with the marks themselves (see `rigShading.ts`'s header for the
 * measured A/B that replaced a white specular + four dark arcs + a rim ring with a warm wash,
 * a smooth chord-band ramp and an underside occlusion). The properties worth machine-checking
 * are the ones a hand-tuned constant can silently break:
 *
 *   - every mark stays strictly INSIDE the body radius (nothing may spill onto the transparent
 *     background — which is what lets this work with no mask at all);
 *   - the light has ONE direction, and the warm side and the dark side oppose it;
 *   - the ramp is monotonic and its steps are small enough to be invisible;
 *   - the reflected-light rollback exists, i.e. the darkest band is NOT the outermost one. That
 *     is the difference between a body that reads as round and one that reads as smudged, and
 *     it is a single constant away from silently disappearing.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import {
  drawModuleContacts,
  drawSphereShading,
  shadeHex,
  MODULE_BEHIND_SCALE,
  MODULE_BEHIND_SHADE,
  SHADE_MIN_BODY_R,
} from './rigShading';

interface Instr {
  action: string;
  data: {
    style?: { color: number; alpha: number };
    path?: { instructions: Array<{ action: string; data: number[] }> };
  };
}

const instructions = (g: Graphics): Instr[] => g.context.instructions as Instr[];

/**
 * Every filled shape in `g`, as `{ color, alpha, kind, data }` where `data` is flattened x,y
 * pairs for a poly and `[cx, cy, rx, ry]` for an ellipse.
 *
 * Pixi's retained path instructions are not uniform: a `poly` carries `[points[], close, matrix]`
 * so its points are nested one level down, an `ellipse` carries `[cx, cy, rx, ry, matrix]` and is
 * preceded by a bookkeeping `moveTo`. Normalizing here is what lets the assertions below read as
 * geometry rather than as index arithmetic.
 */
function fills(g: Graphics): Array<{ color: number; alpha: number; kind: string; data: number[] }> {
  const out: Array<{ color: number; alpha: number; kind: string; data: number[] }> = [];
  for (const i of instructions(g)) {
    if (i.action !== 'fill') continue;
    for (const pi of i.data.path?.instructions ?? []) {
      const raw = pi.data as unknown[];
      if (pi.action === 'poly') {
        out.push({ color: i.data.style!.color, alpha: i.data.style!.alpha, kind: 'poly', data: raw[0] as number[] });
      } else if (pi.action === 'ellipse') {
        out.push({
          color: i.data.style!.color,
          alpha: i.data.style!.alpha,
          kind: 'ellipse',
          data: (raw as number[]).slice(0, 4),
        });
      }
    }
  }
  return out;
}

/** The centroid of a chord band (a 4-corner poly), which is where along the light axis it sits. */
function centroid(points: number[]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let i = 0; i < points.length; i += 2) {
    x += points[i]!;
    y += points[i + 1]!;
  }
  const n = points.length / 2;
  return { x: x / n, y: y / n };
}

/** Unit vector toward the key light (upper-left, y-down screen space) — restated here rather
 *  than imported, so a sign flip in `SHADE_KEY_ANGLE` fails a test instead of moving it. */
const KEY = { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };
const DARK_MARKS = (g: Graphics) => fills(g).filter((f) => f.color !== 0xffd9a8);
const WARM_MARKS = (g: Graphics) => fills(g).filter((f) => f.color === 0xffd9a8);

describe('drawSphereShading — the marks that make a flat-cel body read as a sphere', () => {
  it('keeps every mark strictly inside the body radius, so none can spill past the silhouette', () => {
    // The whole reason no mask/clip is needed (a mask per actor would be 30 stencil passes in
    // a busy room). If a tuning change pushed a band or the underside occlusion past the rim,
    // it would render as a grey/warm blob on transparent background outside the character.
    for (const bodyR of [24, 40, 50, 70]) {
      const b = drawSphereShading(bodyR).bounds;
      const reach = Math.max(-b.minX, b.maxX, -b.minY, b.maxY);
      expect(reach).toBeLessThanOrEqual(bodyR);
    }
  });

  /** The furthest any drawn mark reaches from the body centre. NOT the same as `bounds`, which is
   *  an axis-aligned box: the ramp runs diagonally, so its extreme points sit at 45 degrees and the
   *  box never comes near them. This is the number that decides whether a mark can spill. */
  function maxMarkRadius(g: Graphics): number {
    let max = 0;
    for (const f of fills(g)) {
      if (f.kind === 'poly') {
        for (let i = 0; i < f.data.length; i += 2) max = Math.max(max, Math.hypot(f.data[i]!, f.data[i + 1]!));
      } else {
        const [cx, cy, rx, ry] = f.data as [number, number, number, number];
        max = Math.max(max, Math.hypot(Math.abs(cx) + rx, Math.abs(cy) + ry));
      }
    }
    return max;
  }

  it('keeps every band CORNER inside the body circle, not merely inside its bounding box', () => {
    // Bounds cannot catch a rotated band whose corner pokes out through the circle diagonally —
    // exactly the failure mode a chord band computed from the wrong edge would have. `chordBand`
    // sizes each band from whichever of its two edges is FURTHER from the centre for this reason.
    for (const bodyR of [24, 40, 70]) {
      expect(maxMarkRadius(drawSphereShading(bodyR))).toBeLessThanOrEqual(bodyR + 1e-9);
    }
  });

  it('leaves a real margin at the rim rather than sitting flush against it', () => {
    // The caller passes the DRAWN radius, which is a half-WIDTH, and none of this art is a circle:
    // `critter-core`'s crystal cluster is 35 wide by 38 tall with gaps at its corners, so a ramp
    // flush to that width still showed a faint arc of shading on the background diagonally out
    // from it. A margin here is what covers every non-circular body at once — and it is invisible
    // to any `bounds`-based assertion, since the ramp's extremes are at 45 degrees.
    const bodyR = 40;
    const reach = maxMarkRadius(drawSphereShading(bodyR));
    expect(reach).toBeLessThan(bodyR * 0.98);
    expect(reach).toBeGreaterThan(bodyR * 0.85); // ...and not so shy that the limb stops reading
  });

  it('draws real geometry, scaled with the body it is given', () => {
    const small = drawSphereShading(24).bounds;
    const big = drawSphereShading(70).bounds;
    expect(small.width).toBeGreaterThan(0);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.width / small.width).toBeCloseTo(70 / 24, 1);
  });
});

describe('drawSphereShading — the light has one direction, and the two washes oppose it', () => {
  const bodyR = 40;

  it('puts the WARM wash on the key-light side — upper left, the project\'s one direction', () => {
    // Shared with NormalLitFilter's KEY_DIR and the pillar/wall shading. The light mark is warm
    // rather than white because design/13's shells are near-white flat-cel art: measured at 255
    // before any shading, so a white specular over them is arithmetically a no-op. Hue is the
    // only channel left, and it also does real work on the dark re-tinted enemy bodies.
    const warm = WARM_MARKS(drawSphereShading(bodyR));
    expect(warm.length).toBeGreaterThan(4);
    for (const f of warm) {
      const c = centroid(f.data);
      expect(c.x * KEY.x + c.y * KEY.y).toBeGreaterThan(0); // toward the light
    }
  });

  it('puts the form shadow on the diametrically OPPOSITE side, toward the lower right', () => {
    // Weighted, not per-band: a smooth ramp deliberately starts before the terminator, so the
    // faintest bands DO sit on the lit side. What must hold is where the shadow's mass is, and
    // that nothing substantial lands on the light's own side.
    const dark = DARK_MARKS(drawSphereShading(bodyR)).filter((f) => f.kind === 'poly');
    expect(dark.length).toBeGreaterThan(4);
    const peak = Math.max(...dark.map((f) => f.alpha));
    let mass = 0;
    for (const f of dark) {
      const c = centroid(f.data);
      const along = c.x * KEY.x + c.y * KEY.y;
      mass += along * f.alpha;
      // Half-darkness and beyond must be past the body's centre — the definition of a
      // terminator. Below that a smooth ramp legitimately reaches onto the lit hemisphere.
      if (f.alpha > peak * 0.5) expect(along).toBeLessThan(1e-9);
    }
    expect(mass).toBeLessThan(0);
  });

  it('holds the two washes a full 180° apart, not merely on different sides', () => {
    // A single sign error in SHADE_KEY_ANGLE would stack both on one side, which reads as a
    // smudge rather than as a lit form — and would still pass a looser "opposite sides" check.
    const g = drawSphereShading(bodyR);
    const warmest = centroid(WARM_MARKS(g)[0]!.data);
    const darkest = DARK_MARKS(g).filter((f) => f.kind === 'poly').at(-1)!;
    const d = centroid(darkest.data);
    const dot = (warmest.x * d.x + warmest.y * d.y) / (Math.hypot(warmest.x, warmest.y) * Math.hypot(d.x, d.y));
    expect(dot).toBeCloseTo(-1, 6);
  });
});

describe('drawSphereShading — the ramp is smooth, and it rolls back at the limb', () => {
  const bodyR = 40;

  it('steps the form shadow up in alpha by amounts too small to see', () => {
    // The whole point of many non-overlapping bands: each band's alpha IS its ramp value, so the
    // step between neighbours is what a viewer could notice as a contour. On near-white art a
    // step of 0.02 is ~5/255, which is invisible; the old 4-arc version stepped ~0.08 AND
    // overlapped, which is what made the shadow side look dirty.
    const dark = DARK_MARKS(drawSphereShading(bodyR)).filter((f) => f.kind === 'poly');
    for (let i = 1; i < dark.length; i++) {
      expect(Math.abs(dark[i]!.alpha - dark[i - 1]!.alpha)).toBeLessThan(0.025);
    }
  });

  it('ramps UP monotonically until the reflected-light rollback, then back DOWN', () => {
    const dark = DARK_MARKS(drawSphereShading(bodyR)).filter((f) => f.kind === 'poly');
    const alphas = dark.map((f) => f.alpha);
    const peak = alphas.indexOf(Math.max(...alphas));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(alphas.length - 1); // NOT the outermost band — that is the point
    for (let i = 1; i <= peak; i++) expect(alphas[i]!).toBeGreaterThanOrEqual(alphas[i - 1]!);
    for (let i = peak + 1; i < alphas.length; i++) expect(alphas[i]!).toBeLessThan(alphas[i - 1]!);
  });

  it('leaves the outermost sliver of the shadow side visibly lighter than the shadow core', () => {
    // Reflected light. Physically the bounce off the floor and the walls; practically the
    // difference between a round body and a smudged one, because it leaves a lit edge tracing
    // the silhouette. The old version put its DARKEST arc at 0.91 of the radius — right on the
    // rim — and measured as a dirty outline.
    const alphas = DARK_MARKS(drawSphereShading(bodyR)).filter((f) => f.kind === 'poly').map((f) => f.alpha);
    const last = alphas.at(-1)!;
    expect(last).toBeLessThan(Math.max(...alphas) * 0.75);
    expect(last).toBeGreaterThan(0); // still in shadow, just not the darkest part of it
  });

  it('strengthens the shadow enough to survive near-white flat-cel art', () => {
    // design/13's shells are near-white, and the first tuning (terminator alphas 0.20 down to
    // 0.08) was invisible over them in a 7x render. This is a floor on that lesson.
    const alphas = DARK_MARKS(drawSphereShading(bodyR)).map((f) => f.alpha);
    expect(Math.max(...alphas)).toBeGreaterThan(0.25);
  });

  it('adds an underside occlusion, symmetric in x and low on the body', () => {
    // The form ramp only darkens the lower RIGHT. Measured, the shell's lower LEFT stayed pure
    // white right down to the silhouette, which reads as a disc lit from the side rather than as
    // a sphere sitting over a floor. These ellipses are the other half of that.
    const under = DARK_MARKS(drawSphereShading(bodyR)).filter((f) => f.kind === 'ellipse');
    expect(under.length).toBeGreaterThanOrEqual(3);
    for (const f of under) {
      const [cx, cy] = f.data;
      expect(cx).toBe(0); // symmetric in x — not part of the directional lighting
      expect(cy!).toBeGreaterThan(0); // y-down: low on the body
    }
  });

  it('draws no pure-white mark at all, since white over near-white art is a no-op', () => {
    for (const f of fills(drawSphereShading(bodyR))) expect(f.color).not.toBe(0xffffff);
  });
});

describe('drawModuleContacts — seating an orbiting module against the core', () => {
  /** A throwaway Graphics with the same instruction-list shape the others read. */
  function contacts(mounts: Array<{ x: number; y: number }>, bodyR = 40): Graphics {
    const g = drawSphereShading(bodyR); // any Graphics; cleared by drawModuleContacts
    drawModuleContacts(g, mounts, bodyR);
    return g;
  }


  it('clears whatever was there first, so a per-frame repaint cannot accumulate', () => {
    const g = contacts([]); // handed a Graphics already full of sphere shading
    expect(instructions(g)).toHaveLength(0);
  });

  it('draws nested ellipses per mount, pulled back from the mount TOWARD the core', () => {
    const mount = { x: 30, y: 0 };
    const drawn = fills(contacts([mount]));
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    for (const f of drawn) {
      expect(f.kind).toBe('ellipse');
      expect(f.data[0]!).toBeLessThan(mount.x); // pulled inward
      expect(f.data[0]!).toBeGreaterThan(0); // ...but still on the mount's side
    }
  });

  it('shrinks each nested pass and keeps every one of them faint', () => {
    const drawn = fills(contacts([{ x: 30, y: 0 }]));
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]!.data[2]!).toBeLessThan(drawn[i - 1]!.data[2]!);
    for (const f of drawn) expect(f.alpha).toBeLessThan(0.2);
  });

  it('squashes the contact vertically, like every other round thing in this tilted view', () => {
    for (const f of fills(contacts([{ x: 30, y: 0 }]))) expect(f.data[3]!).toBeLessThan(f.data[2]!);
  });

  it('clamps a FAR mount onto the body, and every ellipse with it', () => {
    // A socket bone's tip is well outside the body it hangs off (orb-core: len 52 vs bodyR 40),
    // so this is the normal case, not the edge case. Nothing here is masked, so an unclamped
    // blob would paint a dark smudge on the transparent background beside the character.
    const bodyR = 40;
    for (const f of fills(contacts([{ x: 200, y: 0 }], bodyR))) {
      expect(f.data[0]! + f.data[2]!).toBeLessThanOrEqual(bodyR); // centre + rx, inside the body
    }
  });

  it('leaves a NEAR mount where it is, rather than pushing it out to the clamp circle', () => {
    // The clamp is a ceiling, not a target: a module that a clip has pulled in close should have
    // its contact follow it in, or the shade detaches from the thing casting it.
    const near = fills(contacts([{ x: 6, y: 0 }]))[0]!;
    const far = fills(contacts([{ x: 200, y: 0 }]))[0]!;
    expect(near.data[0]!).toBeLessThan(far.data[0]!);
    expect(near.data[0]!).toBeGreaterThan(0);
  });

  it('places a contact on the same side as its mount, for a mount in any direction', () => {
    for (const [mx, my] of [[40, 0], [-40, 0], [0, 40], [0, -40], [-30, 30]]) {
      const c = fills(contacts([{ x: mx, y: my }]))[0]!;
      expect(Math.sign(c.data[0]!)).toBe(Math.sign(mx));
      expect(Math.sign(c.data[1]!)).toBe(Math.sign(my));
    }
  });

  it('skips a mount sitting exactly on the core, which has no direction to pull along', () => {
    expect(fills(contacts([{ x: 0, y: 0 }]))).toHaveLength(0);
  });

  it('handles two mounts independently — one contact per orbiting module', () => {
    const one = fills(contacts([{ x: 30, y: 0 }])).length;
    expect(fills(contacts([{ x: 30, y: 0 }, { x: -30, y: 4 }]))).toHaveLength(one * 2);
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
