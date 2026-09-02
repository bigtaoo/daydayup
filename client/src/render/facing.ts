// Pure facing decision (design/12 "Facing model (twin-stick 360° aim)"), split out
// of RigSkin so it's testable without touching Pixi: L/R mirror by the input
// vector's horizontal sign, front/back hemisphere swap by its vertical sign
// (y-down screen space — pointing toward the bottom/camera is "front"). Drives the
// BODY orientation (RigSkin.setBodyFacing) — the weapon's own aim tracking
// (RigSkin.setAim) is a separate, independent angle.
//
// What FEEDS setBodyFacing changed 2026-08-18: it used to be the movement vector, on the
// humanoid "upper body aims, lower body walks" split this engine inherited from `funny`.
// The orb-core has no lower body — no legs, one big eye (design/13) — so the thing that
// should turn is the eye, and it should turn toward what the player is shooting at, which
// is what design/12's own facing-model text describes ("aim toward the bottom of the
// screen draws the front"). Strafing left while firing right used to point the eye away
// from the target, and standing still held whatever direction the player last walked.
// Scene.ts now feeds the AIM angle through `turnToward` below.
export interface FacingState {
  flipX: 1 | -1;
  showBack: boolean;
}

/** Radians the body may turn per SIM TICK (Scene.reconcile's cadence, 30 Hz) — a full
 *  180° about-face takes ~0.4 s. The orb-core turns to face its aim (below), and with
 *  auto-aim-to-nearest (design/10) the aim angle can jump the instant a closer enemy
 *  appears; snapping the body to it read as a twitch, so the turn is rate-limited. */
export const BODY_TURN_PER_TICK = 0.27;

/** Step `from` toward `to` by at most `maxStep`, the short way around the circle.
 *  Returns `to` exactly once it's within reach, so a settled body holds a stable angle
 *  instead of creeping by floating-point dust. */
export function turnToward(from: number, to: number, maxStep: number): number {
  const TAU = Math.PI * 2;
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  if (Math.abs(delta) <= maxStep) return to;
  return from + Math.sign(delta) * maxStep;
}

/**
 * The canonical (pre-mirror) local angle, in RADIANS, that renders as the true world angle
 * `rad` once `view.scale.x` has possibly mirrored the whole rig (`facingFromAngle().flipX`).
 *
 * Every offset a rig computes in body space — a socket's aim rotation, the eye's slide inside
 * the shell, the recoil's push along the barrel, the melee swing's arc — has to be stated in
 * this space, or the flip lands it on the wrong side of the body. `cos(pi - a) = -cos(a)`
 * unflips to `+cos(a)` while `sin` is unchanged, which is exactly right: the horizontal
 * component mirrors and the vertical one must not.
 *
 * Lives here rather than as a private on `RigSkin` (moved 2026-09-02, 500-line convention)
 * because it is the same pure facing decision this file already owns, and because a rule four
 * separate call sites depend on deserves its own test instead of only being exercised
 * indirectly through a posed Pixi rig.
 */
export function canonicalAimRad(rad: number, flipX: 1 | -1): number {
  return flipX === 1 ? rad : Math.PI - rad;
}

export function facingFromAngle(rad: number): FacingState {
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  return {
    flipX: dx < 0 ? -1 : 1,
    showBack: dy < 0,
  };
}
