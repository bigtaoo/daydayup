import { Graphics } from 'pixi.js';

// Split out of RigSkin.ts (2026-08-18, 500-line convention): the DEPTH-CUE marks a rig
// draws on top of its own flat-cel art — the sphere shading over its body bone, and the
// tint/scale shade a far-side weapon module takes. Pure geometry and pure colour maths, no
// Pixi scene state and no dependency back on RigSkin (which imports this, never the
// reverse). Everything here is what makes a 2D rig read as a lit volume rather than a
// cut-out, so it is worth having one place to tune it.
/** Depth cues stacked on top of that z-flip (2026-08-18): a module on the FAR side of the
 *  core is further from the camera, so it is drawn smaller and darker as well as behind.
 *  The z-flip alone reads as "it changed layer"; all three together read as "it orbited
 *  around a sphere", which is the whole point of the orbiting-module body plan (design/13). */
export const MODULE_BEHIND_SCALE = 0.86;
export const MODULE_BEHIND_SHADE = 0.68;

// Sphere shading (2026-08-18 depth pass, user report *"希望能再强化一下立体效果"*). The eye
// now slides and the modules now orbit, but nothing in the assembled character said its
// SHELL was a sphere rather than a disc — the art is flat-cel by design (design/13) and the
// only lighting in the scene was `NormalLitFilter`'s luminance-derived relief, which
// sharpens edges without ever establishing a form. This adds the two marks that do: a fixed
// specular highlight and a curved terminator, drawn (not authored) because they must stay
// pinned to the key light's screen-space direction while the body they sit on mirrors and
// the eye they sit beside travels. Eye moving + highlight not moving is precisely what reads
// as a sphere turning under a fixed light.
//
// Every shape is a filled ellipse or a stroked arc strictly INSIDE the body radius, so no
// mask/clip is needed (a mask per actor would be 30 stencil passes in a busy room) and
// nothing can ever spill past the silhouette onto transparent background.
const SHADE_KEY_ANGLE = -Math.PI * 0.75; // toward the upper-left key light, y-down screen space
/** Smallest bodyR (authoring px) worth shading — below this the marks would be sub-pixel
 *  noise on screen. Filters out an orb-core socket (13) and keeps shell (40) / critter body
 *  (50) / boss core (70). */
export const SHADE_MIN_BODY_R = 24;
/** Specular highlight: `[centre distance, radius, alpha]` as fractions of bodyR, brightest
 *  last. `dist + radius < 1` for every ring, which is what keeps it inside the silhouette. */
const SHADE_HIGHLIGHT: ReadonlyArray<readonly [number, number, number]> = [
  [0.36, 0.3, 0.1],
  [0.36, 0.19, 0.16],
  [0.34, 0.1, 0.34],
];
/** Terminator: `[arc radius, angular half-width (rad), stroke width, alpha]` — radius and
 *  width as fractions of bodyR. Concentric arcs centred on the direction AWAY from the key
 *  light, narrowing and fading inward, which is a shadow core falling off toward the lit
 *  side rather than a hard band. */
// Alphas roughly doubled on 2026-08-18 after a 7x live render of the assembled hero: at
// 0.20/0.16/0.12/0.08 the terminator was invisible. design/13's shells are near-WHITE flat-cel
// art, and a fifth-opacity black arc over white is nothing — the mark has to be strong enough
// to survive both the bright base colour and `NormalLitFilter` brightening it further.
const SHADE_TERMINATOR: ReadonlyArray<readonly [number, number, number, number]> = [
  // Outermost radius + half its stroke width must stay under 1.0 — see rigShading.test.ts's
  // "strictly inside the body radius", which is what lets this work with no mask at all.
  [0.91, 1.2, 0.13, 0.38],
  [0.8, 1.05, 0.13, 0.3],
  [0.69, 0.88, 0.12, 0.22],
  [0.58, 0.68, 0.11, 0.14],
];
const SHADE_DARK = 0x05080f;
const SHADE_LIGHT = 0xffffff;
/** Faint full-perimeter inner rim AO, so the silhouette's edge turns away everywhere rather
 *  than only on the shadow side: `[radius, width, alpha]` as fractions of bodyR. */
const SHADE_RIM: readonly [number, number, number] = [0.92, 0.1, 0.13];

/** Multiply a hex colour by a scalar, saturating per channel — how a Pixi tint darkens a
 *  sprite without a second filter (used for the far-side module's depth shade). Exported for
 *  `RigSkin.test.ts`, which asserts the behind-tint is strictly darker than the front one. */
export function shadeHex(hex: number, factor: number): number {
  const ch = (shift: number) => Math.max(0, Math.min(255, Math.round(((hex >> shift) & 0xff) * factor)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * The static sphere-shading overlay for a body of radius `bodyR` (authoring px), centred on
 * (0,0) — a specular highlight toward the key light and a terminator falling away from it.
 * See the SHADE_* constants for what each mark is and why none of them can spill outside the
 * silhouette. Pure geometry, drawn once per rig instance; `RigSkin.update` only repositions
 * it. Exported for tests.
 */
export function drawSphereShading(bodyR: number): Graphics {
  const g = new Graphics();

  // Terminator first (under the highlight — they never overlap, but this is the physical
  // order): concentric arcs centred on the direction AWAY from the key light.
  const awayAngle = SHADE_KEY_ANGLE + Math.PI;
  for (const [rFrac, halfWidth, widthFrac, alpha] of SHADE_TERMINATOR) {
    g.arc(0, 0, bodyR * rFrac, awayAngle - halfWidth, awayAngle + halfWidth).stroke({
      color: SHADE_DARK,
      width: bodyR * widthFrac,
      alpha,
    });
  }

  // Faint inner rim all the way round, so the edge reads as curvature everywhere.
  const [rimR, rimW, rimA] = SHADE_RIM;
  g.circle(0, 0, bodyR * rimR).stroke({ color: SHADE_DARK, width: bodyR * rimW, alpha: rimA });

  // Specular highlight, vertically squashed like every other round thing in this view.
  const hx = Math.cos(SHADE_KEY_ANGLE);
  const hy = Math.sin(SHADE_KEY_ANGLE);
  for (const [dist, radius, alpha] of SHADE_HIGHLIGHT) {
    g.ellipse(hx * bodyR * dist, hy * bodyR * dist, bodyR * radius, bodyR * radius * 0.8).fill({
      color: SHADE_LIGHT,
      alpha,
    });
  }

  return g;
}
