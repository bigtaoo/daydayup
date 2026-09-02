import type { Sprite } from 'pixi.js';

// Split out of RigSkin.ts (2026-09-02, 500-line convention, form ① independent functions):
// eye tracking is one self-contained cue over one bone, computed from the aim alone, with no
// Pixi state of its own beyond the sprite handed to it. Same category and same folder as
// `rigShading.ts` / `rigTethers.ts` / `rigWeaponMount.ts`, and moved for the same reason —
// RigSkin was sitting exactly on the 500-line limit.
//
// Eye tracking (2026-08-18). A 2D rig can't turn a head, and the two-hemisphere billboard
// (`facingFromAngle`) only has four states — L/R flip × front/back — so a 360° aim used to
// read as four discrete poses. For a body plan that is mostly one big eye (design/13), the
// direction cue nobody has to be taught is where the eye is LOOKING: the eye slot slides
// inside the shell along the aim direction, which turns those four states into a continuous
// read using the art that already ships. Free of new assets by construction.

/** The bone this cue applies to. A rig without it is simply unaffected. */
export const EYE_BONE_ID = 'eye';
/** How far the eye slides from its authored rest position, in rig authoring px. The shell's
 *  own `bodyR` is 40 and the eye's is 16 (`orbCoreRig`), so 14 keeps it inside the shell
 *  with a margin rather than riding the rim. */
export const EYE_TRACK_R = 14;
/** The vertical half of that slide is squashed: this is a tilted view (design/01), so a
 *  sphere's surface covers less screen distance vertically than horizontally.
 *
 *  Note this is NOT the same question as `rigWeaponMount`'s mount offsets, which stopped
 *  being squashed on 2026-09-02: those place a module OUT IN THE WORLD on the ground plane,
 *  where the projection is 1:1 and a squash put the drawn gun off its own bullets' line. This
 *  one really does walk across a sphere's surface — it stays inside the shell. */
export const EYE_TRACK_SQUASH = 0.45;
/** How much the eye shrinks as the aim turns away from the camera — a little perspective
 *  on top of the front/back texture swap, so crossing the hemisphere isn't a hard cut. */
export const EYE_AWAY_SHRINK = 0.15;

/**
 * Slide the eye sprite along the aim and report the scale multiplier that goes with it.
 *
 * `canonicalAngle` is the pre-mirror aim (`RigSkin.canonicalSocketAngleRad`) and `aimRad` the
 * true one; both are needed and they are not interchangeable. The OFFSET is computed in
 * canonical space, like the sockets', so `view.scale.x` mirroring the whole rig lands it on
 * the correct side of the shell: cos(π−a) = −cos(a) unflips to +cos(a), while sin is
 * unchanged — which is exactly right, since the vertical component must not mirror. The
 * SHRINK is a fact about which way the eye faces the camera, which the mirror does not
 * change, so it reads the true aim.
 */
export function trackEye(sprite: Sprite, canonicalAngle: number, aimRad: number): number {
  sprite.x += Math.cos(canonicalAngle) * EYE_TRACK_R;
  sprite.y += Math.sin(canonicalAngle) * EYE_TRACK_R * EYE_TRACK_SQUASH;
  return 1 - EYE_AWAY_SHRINK * Math.max(0, -Math.sin(aimRad));
}
