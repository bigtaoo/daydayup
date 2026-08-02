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
import { addFp, mulFp, type Fp } from '../math/fixed';
import { atan2Brad, bradDiff, cosFp, sinFp, normBrad, type Brad } from '../math/trig';

export type BallisticId = 'straight' | 'homing' | 'lob' | 'beam' | 'boomerang' | 'orbit';

export const BALLISTIC_IDS: readonly BallisticId[] = ['straight', 'homing', 'lob', 'beam', 'boomerang', 'orbit'];

/**
 * Emission pattern (design/03 "orthogonal to ballistic", the radial follow-up to 1.1's
 * spread). How a multi-pellet trigger LAYS OUT its pellets — independent of each pellet's
 * ballistic motion afterward:
 *   - 'spread' — the original cone: pellets jitter within ±spreadHalf of facing, each a
 *     combatPrng draw (a single-pellet weapon is pinpoint and draws nothing).
 *   - 'radial' — a full even ring: pellets are placed at equal 65536/bullets brad steps
 *     around facing, DETERMINISTIC (no PRNG draw). The "nova" burst — fire in all
 *     directions at once. spreadHalf is unused.
 */
export type EmissionPattern = 'spread' | 'radial';

/** Radial emission (design/03): the i-th of `count` pellets, placed at an equal brad step
 * around `facing`. Integer brad only, deterministic (no PRNG) — pellet 0 fires straight
 * ahead, the rest fan evenly around the full circle. */
export function radialDir(facing: Brad, i: number, count: number): Brad {
  return normBrad(facing + Math.floor((65536 * i) / count));
}

/**
 * Orbit (design/03/09 Frame axis): a projectile pinned to its owner, circling at a fixed
 * `radius` while its angle advances `angularVelBrad` per tick — a spinning blade/shield
 * rather than a travelling shot. Position is set ABSOLUTELY from the (moving) owner each
 * tick, so it tracks the owner; the standard `pos += vel` integrate is a no-op for it.
 * Pure: callers pass the owner's current centre and the bullet's prior angle.
 */
export function orbitStep(
  ownerX: Fp,
  ownerY: Fp,
  angleBrad: Brad,
  angularVelBrad: number,
  radius: Fp,
): { angle: Brad; x: Fp; y: Fp } {
  const angle = normBrad(angleBrad + angularVelBrad);
  return {
    angle,
    x: addFp(ownerX, mulFp(cosFp(angle), radius)),
    y: addFp(ownerY, mulFp(sinFp(angle), radius)),
  };
}

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
