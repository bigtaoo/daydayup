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
// sharpens edges without ever establishing a form.
//
// **Rebuilt 2026-08-19 after measuring the first version in a real frame** (an A/B extract
// of the shipped hero at 11x, `shade_on`/`shade_off`). It was three marks: a white specular
// toward the key light, four concentric dark ARCS as a terminator, and a faint
// full-perimeter rim ring. Measured, all three were wrong:
//
//   1. **The specular contributed exactly nothing.** design/13's shells are near-white
//      flat-cel art — the lit cap of the hero's shell reads 255 before any shading — and a
//      0.34-alpha WHITE ellipse over white is a no-op. Value can only travel one direction
//      on white art, so the light side has to be expressed as a HUE shift (a warm wash),
//      not as a value lift. The wash also does real work on the dark, re-tinted enemy
//      bodies the same code shades, where the old white blob was merely a pale spot.
//   2. **The terminator read as a smudge, not as a curve.** Four arcs at radii 0.58-0.91
//      put the darkest band right ON the rim, with visibly hard angular cut-offs at each
//      arc's ends, so the lower-right of the shell looked dirty rather than turned-away.
//      Replaced by a full linear ramp across the body (see `drawSphereShading`), which has
//      no ends to cut off, plus a REFLECTED-LIGHT rollback that keeps the outermost sliver
//      brighter than the shadow core — the single change that most restores the crisp
//      flat-cel silhouette design/13 asks for.
//   3. **The rim ring greyed the silhouette.** A faint dark circle just inside the edge, all
//      the way round, is indistinguishable from a muddy outline at play scale. Deleted; the
//      ramp already darkens the turning-away edge, which is the only place it belonged.
//
// A gradient fill would be the obvious tool for a smooth ramp and is deliberately NOT used:
// Pixi 8's `FillGradient` calls `DOMAdapter.createCanvas()` at `fill()` time, which throws
// in this repo's canvas-free test environment — and reading the retained Graphics
// instruction list is exactly how the look is machine-checked here (`rigShading.test.ts`).
// The ramp is therefore built from NON-OVERLAPPING chord bands, which is also strictly
// better than stacked translucent shapes: each band's alpha IS its ramp value, so the steps
// never compound into the opacity banding that stacked arcs showed on the pillars.

/** Toward the upper-left key light, y-down screen space. Shared with `NormalLitFilter`'s
 *  KEY_DIR and the pillar/wall shading — the project has exactly one light direction. */
const SHADE_KEY_ANGLE = -Math.PI * 0.75;
/** Smallest bodyR (authoring px) worth shading — below this the marks would be sub-pixel
 *  noise on screen. Filters out an orb-core socket (13) and keeps shell (40) / critter body
 *  (50) / boss core (70). */
export const SHADE_MIN_BODY_R = 24;

/** Safety margin on the DRAWN body radius the caller passes in: just inside 1.0 so an
 *  antialiased band edge can never bleed past the art's own silhouette. That is what lets the
 *  whole thing work with no mask — a mask per actor would be 30 stencil passes in a busy room.
 *
 *  **The radius has to be the drawn one, and until 2026-08-19 it was not.** `RigSkin` passed the
 *  body bone's `bodyR`, i.e. the rig's DECLARED radius, on the assumption that the art fills it.
 *  Measuring the shipped PNGs' alpha bounding boxes (`skinRegistry.BODY_FILL`) showed they paint
 *  0.68-1.00 of it, so for `critter-core` (0.70) every band outside 0.70 landed on transparent
 *  background — and since nothing is masked, that painted a hard-edged dark DISC around the
 *  crystal, visible in any 4x render and easy to mistake for an over-large ground shadow (an
 *  earlier session did exactly that). The hero's 0.81 put a fainter dark halo just outside its
 *  white shell for the same reason. */
// 0.97 -> 0.92 (2026-08-19, third look): the drawn radius is a HALF-WIDTH, and none of this art
// is a circle — `critter-core`'s crystal cluster is 35.1 wide by 38.3 tall with pointed gaps at
// the corners, so a circular ramp sized flush to its width still showed a faint arc of shading on
// the background diagonally out from it. A few percent of margin costs nothing visually and covers
// every non-circular body the same way.
const SHADE_FIT = 0.92;
/** Bands across the body, along the light axis. The count is set by the largest alpha STEP any
 *  band-to-band transition may show — a step is a contour the eye can find, and on near-white
 *  art 0.025 alpha is already ~6/255. At 40 the worst step (in the reflected-light rollback,
 *  which is the steepest part of the curve, not the terminator) is ~0.02. Cheap regardless:
 *  this is one Graphics built once per rig instance and never redrawn, only repositioned. */
const SHADE_BANDS = 40;
/** Where the terminator sits along the light axis, as a 0..1 position from the lit pole to the
 *  dark limb, and how much of the body the transition is smeared across. 0.52/0.34 puts the
 *  ramp's HALF-darkness point just past the body's centre — which is what "terminator" means —
 *  with a long soft falloff either side of it: a sphere, not a cel-shaded step. The first
 *  attempt smeared it across 84% of the body, which is so soft that the lit hemisphere itself
 *  ends up carrying a fifth of the shadow and the contrast that reads as ROUND is spent. */
const SHADE_TERMINATOR_T = 0.52;
const SHADE_SOFTNESS = 0.34;
/** Peak darkness at the shadow core. Roughly what the old 4-arc stack reached, kept because
 *  that strength WAS right — it was its distribution that read as dirt. */
const SHADE_MAX_ALPHA = 0.34;
/** Reflected light: past this point along the axis the ramp rolls back DOWN to
 *  `SHADE_REFLECT_KEEP` of its peak by the limb. Physically the bounce off the floor and the
 *  surrounding walls; practically the difference between a round body and a smudged one,
 *  because it leaves a lit sliver tracing the silhouette on the shadow side. */
const SHADE_REFLECT_T = 0.68;
const SHADE_REFLECT_KEEP = 0.5;
const SHADE_DARK = 0x05080f;

/** The lit side's warm wash — see note 1 above for why the light mark is a hue, not a value.
 *  Peak alpha at the lit pole, falling to zero at `SHADE_WARM_T` along the axis. */
const SHADE_WARM = 0xffd9a8;
// 0.17 -> 0.28 (2026-08-19, second look): at 0.17 a warm wash over near-white art is still
// imperceptible, i.e. the light mark was doing nothing for the second time in this file's history
// — the first time in value, this time in hue. 0.28 actually tints: the lit cap of a white shell
// reads warm against the cool shadow side, which is the whole hue-not-value idea working.
const SHADE_WARM_MAX_ALPHA = 0.28;
const SHADE_WARM_T = 0.5;

/** Underside occlusion: nested ellipses low on the body, `[centre y, rx, ry, alpha]` as
 *  fractions of the shaded radius. Symmetric in x on purpose — the form ramp above only
 *  darkens the lower RIGHT, and the measured render showed the shell's lower LEFT staying
 *  pure white right down to the silhouette, which reads as a disc lit from the side rather
 *  than as a sphere over a floor. */
const SHADE_UNDERSIDE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.44, 0.66, 0.3, 0.07],
  [0.5, 0.55, 0.24, 0.08],
  [0.56, 0.42, 0.17, 0.09],
];

/** Contact shade where an orbiting module meets the core (`drawModuleContacts`) —
 *  `[rx, ry]` as fractions of the shaded radius, then the alpha of each nested pass. The
 *  modules hang off tethers with nothing to seat them against the shell, so at play scale
 *  they read as decals floating in front of the body rather than as objects in orbit. */
const MODULE_CONTACT_RX = 0.3;
const MODULE_CONTACT_RY = 0.19;
const MODULE_CONTACT_ALPHAS: readonly number[] = [0.1, 0.12, 0.14];

/** Multiply a hex colour by a scalar, saturating per channel — how a Pixi tint darkens a
 *  sprite without a second filter (used for the far-side module's depth shade). Exported for
 *  `RigSkin.test.ts`, which asserts the behind-tint is strictly darker than the front one. */
export function shadeHex(hex: number, factor: number): number {
  const ch = (shift: number) => Math.max(0, Math.min(255, Math.round(((hex >> shift) & 0xff) * factor)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Smooth Hermite step, the standard shading falloff — 0 below `edge0`, 1 above `edge1`, and
 *  flat-tangented at both ends so a ramp built from it has no visible start or stop. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * One band of the ramp, as an explicit 4-corner polygon: a chord-limited slab perpendicular
 * to the light axis, spanning `[d0, d1]` along it.
 *
 * The slab's half-width is the circle's chord at whichever of its two edges is FURTHER from
 * the centre, which is what makes containment exact rather than approximate: a corner sits at
 * axis distance `d` and cross distance `hw`, and `d² + hw² ≤ dFar² + (R² − dFar²) = R²`. So
 * every corner of every band lands on or inside the body circle, for any band count.
 */
function chordBand(r: number, angle: number, d0: number, d1: number): number[] {
  const ax = Math.cos(angle);
  const ay = Math.sin(angle);
  const px = -ay;
  const py = ax;
  const dFar = Math.max(Math.abs(d0), Math.abs(d1));
  const hw = Math.sqrt(Math.max(0, r * r - dFar * dFar));
  return [
    ax * d0 + px * hw, ay * d0 + py * hw,
    ax * d1 + px * hw, ay * d1 + py * hw,
    ax * d1 - px * hw, ay * d1 - py * hw,
    ax * d0 - px * hw, ay * d0 - py * hw,
  ];
}

/**
 * The static sphere-shading overlay for a body whose ART is drawn out to `drawnR` (authoring
 * px — the body bone's `bodyR` times how much of it the bundle actually paints), centred on
 * (0,0) — a warm wash on the lit side, a smooth form-shadow ramp falling away from the key
 * light with a reflected-light sliver at the limb, and an underside occlusion.
 *
 * See the file header for why each mark is the shape it is, and `SHADE_*` for the tuning.
 * Pure geometry, drawn once per rig instance; `RigSkin.update` only repositions it. The
 * caller counter-flips it against the rig's own mirror so the light never travels with the
 * body — eye moving while the light does not is what reads as a sphere turning.
 */
export function drawSphereShading(drawnR: number): Graphics {
  const g = new Graphics();
  const r = drawnR * SHADE_FIT;
  // The ramp runs from the lit pole to the dark limb, i.e. AWAY from the key light.
  const away = SHADE_KEY_ANGLE + Math.PI;
  const step = (2 * r) / SHADE_BANDS;

  for (let i = 0; i < SHADE_BANDS; i++) {
    const d0 = -r + i * step;
    const d1 = d0 + step;
    const t = (i + 0.5) / SHADE_BANDS;
    const band = chordBand(r, away, d0, d1);

    // Warm light on the near side of the terminator: a hue shift, since value has nowhere
    // to go on near-white art.
    if (t < SHADE_WARM_T) {
      const warm = (1 - t / SHADE_WARM_T) * SHADE_WARM_MAX_ALPHA;
      g.poly(band).fill({ color: SHADE_WARM, alpha: warm });
    }

    // Form shadow, with the reflected-light rollback at the limb.
    // Both curves are smoothstepped, including the rollback: a LINEAR rollback over the last
    // sliver of the body is by far the steepest thing in the ramp (it was showing a 0.05 alpha
    // step per band, twice the terminator's) and would read as a hard contour parallel to the
    // rim — the exact defect this whole rebuild exists to remove.
    const dark = smoothstep(SHADE_TERMINATOR_T - SHADE_SOFTNESS, SHADE_TERMINATOR_T + SHADE_SOFTNESS, t)
      * (1 - (1 - SHADE_REFLECT_KEEP) * smoothstep(SHADE_REFLECT_T, 1, t));
    if (dark > 0.001) g.poly(band).fill({ color: SHADE_DARK, alpha: dark * SHADE_MAX_ALPHA });
  }

  for (const [cy, rx, ry, alpha] of SHADE_UNDERSIDE) {
    g.ellipse(0, r * cy, r * rx, r * ry).fill({ color: SHADE_DARK, alpha });
  }

  return g;
}

/**
 * Repaint `g` with one contact shade per orbiting module mount — `mounts` are the module
 * positions in the same body-centred space `drawSphereShading` draws in, i.e. the socket
 * bone tips relative to the body bone's tip.
 *
 * Each mount gets nested ellipses squashed toward the body's surface and pulled back TOWARD
 * the core, so the dark side of the blob is the side the module overlaps. Cleared and
 * redrawn per frame (the mounts orbit), which is why this takes a Graphics instead of
 * returning one.
 */
export function drawModuleContacts(g: Graphics, mounts: ReadonlyArray<{ x: number; y: number }>, drawnR: number): void {
  g.clear();
  const r = drawnR * SHADE_FIT;
  const rx = r * MODULE_CONTACT_RX;
  for (const m of mounts) {
    const len = Math.hypot(m.x, m.y);
    if (len < 0.001) continue;
    // Clamp the centre so the whole ellipse stays inside the body — a module hangs off a socket
    // bone whose TIP is well outside the shell (orb-core: socket len 52 vs shell bodyR 40), so
    // an unclamped blob would sit mostly on transparent background and paint a dark smudge
    // beside the character instead of a contact shade on it. Same invariant the ramp above
    // holds, and `rigShading.test.ts` checks both the same way.
    const reach = Math.min(len, Math.max(0, r - rx));
    const cx = (m.x / len) * reach;
    const cy = (m.y / len) * reach;
    for (let i = 0; i < MODULE_CONTACT_ALPHAS.length; i++) {
      const k = 1 - i * 0.28;
      g.ellipse(cx, cy, rx * k, r * MODULE_CONTACT_RY * k)
        .fill({ color: SHADE_DARK, alpha: MODULE_CONTACT_ALPHAS[i]! });
    }
  }
}
