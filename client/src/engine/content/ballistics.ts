/**
 * Ballistic-shape library (design/03/09 Frame axis, ROADMAP 1.1). A `BallisticId`
 * is a per-tick MOTION rule for a fired projectile — orthogonal to emission
 * (single/spread/burst/radial, which is just the `bullets`/`spreadDeg` fields on
 * RangedSpec). Only `straight` (plain `pos += vel`, no entry here) shipped before
 * this; the rest are implemented in ProjectileStepSystem (motion) and
 * HitResolveSystem (beam's damage-over-window — a hit-resolution concern, not
 * movement). This module holds only the id catalog + pure per-tick math helpers
 * on primitives (no GameState import, matching content/damage.ts's shape) so
 * content/state can depend on it without a cycle.
 *
 * Any change to a formula here alters flight/hit outcomes → bumps ENGINE_VERSION.
 */
import { mulFp, type Fp } from '../math/fixed';
import { atan2Brad, bradDiff, cosFp, sinFp, type Brad } from '../math/trig';

export type BallisticId = 'straight' | 'homing' | 'lob' | 'beam' | 'boomerang';
// 'orbit' + radial `pattern` remain the ROADMAP 1.1 follow-up (design/03 landing
// order tier 4) — deferred, not yet implemented.

export const BALLISTIC_IDS: readonly BallisticId[] = ['straight', 'homing', 'lob', 'beam', 'boomerang'];

/**
 * Homing (design/03/09): rotate the current velocity toward `targetX,targetY` by
 * at most `turnRateBrad` this tick, preserving speed. Integer/brad only — no trig
 * beyond the shared cos/sin table, no isqrt (speed is carried, not recomputed).
 */
export function turnToward(
  vx: Fp,
  vy: Fp,
  speed: Fp,
  targetX: Fp,
  targetY: Fp,
  fromX: Fp,
  fromY: Fp,
  turnRateBrad: number,
): { vx: Fp; vy: Fp } {
  const current = atan2Brad(vy, vx);
  const desired = atan2Brad((targetY - fromY) as Fp, (targetX - fromX) as Fp);
  const diff = bradDiff(desired, current);
  const clamped = Math.max(-turnRateBrad, Math.min(turnRateBrad, diff));
  const next = ((current + clamped) & 0xffff) as Brad;
  return { vx: mulFp(cosFp(next), speed), vy: mulFp(sinFp(next), speed) };
}

/** Lob landing blast (design/03/09): every opposite-faction actor within `blastRadius`
 * of the landing point takes `damage` (pre-resist; resist is still applied by the
 * shared hit path). Callers iterate the candidate list; this just tests reach. */
export function inBlastRadius(gx: Fp, gy: Fp, actorX: Fp, actorY: Fp, actorRadius: Fp, blastRadius: Fp): boolean {
  const dx = (actorX - gx) as number;
  const dy = (actorY - gy) as number;
  const reach = (blastRadius + actorRadius) as number;
  return dx * dx + dy * dy <= reach * reach;
}

/** Beam hitscan (design/03/09): true if `actor` is within `range` along `dir` from
 * `originX,originY`, using the same distance+arc test the melee arc uses, with a
 * narrow fixed half-angle standing in for a zero-width line (integer brad, no trig
 * beyond atan2Brad). */
const BEAM_HALF_ANGLE = 1500; // ~8.2 degrees of brad half-width — a thin but non-zero line

export function inBeamLine(
  originX: Fp,
  originY: Fp,
  dir: Brad,
  range: Fp,
  actorX: Fp,
  actorY: Fp,
  actorRadius: Fp,
): boolean {
  const dx = (actorX - originX) as number;
  const dy = (actorY - originY) as number;
  const reach = (range + actorRadius) as number;
  if (dx * dx + dy * dy > reach * reach) return false;
  const ang = atan2Brad(dy, dx);
  return Math.abs(bradDiff(ang, dir)) <= BEAM_HALF_ANGLE;
}
