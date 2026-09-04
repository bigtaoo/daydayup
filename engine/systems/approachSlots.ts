/**
 * Where a mob is walking TO — the destination half of the two-volume rule
 * (ENGINE_VERSION 56, live report 2026-09-04: *"我希望的是在设置寻路终点时就考虑到这个站立体
 * 积。现在的做法是怪先跑到一起，然后再分散开。我希望的是一步到位"*).
 *
 * v55 gave an arrived mob a standing volume (`standoffRadius`) and a pass that drifts two
 * arrived mobs apart (`MovementSystem.resolveStandingSpacing`). That works, and the report
 * above is about the half second it takes: every mob was still AIMED at the same point — the
 * player — so a garrison converged into one silhouette first and unpacked afterwards. The
 * standing volume was a correction applied to the destination, never an input to choosing it.
 *
 * This module is that input. Each mob approaching the target is given its own point on a ring
 * around it, far enough round the ring from every other mob's point that mobs which arrive are
 * already `standoffRadius`-apart the tick they get there. Nothing about the TRAVELLING volume
 * moves — the mob still walks at its body radius and still fits every gap the level authored —
 * and `resolveStandingSpacing` still runs afterwards as the correction for everything a
 * destination cannot predict (knockback, a player shouldering through a crowd, a mob pinned by
 * geometry).
 *
 * ## The four rules that make it a spot rather than a slot number
 *
 * **A mob keeps the angle it already has unless someone else has claimed it.** There is no
 * global slot grid, on purpose: quantizing to one would make a LONE mob slide up to half a slot
 * sideways on arrival for no reason a player could see. Claims are laid down in priority order
 * and each mob takes its own bearing if that bearing is free, so one mob against one player
 * walks in exactly as straight a line as it did in v37.
 *
 * **Arrived mobs claim first.** Priority is `holding`, then array order (= ascending id = spawn
 * order, `GameState.nextId`). A mob that is standing somewhere keeps standing there and the
 * newcomer routes around it, rather than the pair swapping places because the newcomer happened
 * to spawn earlier.
 *
 * **A spot is never further from the target than the mob already is.** The ring is a place to
 * stop closing, not a place to retreat to: a mob the player has walked up to stays where it is
 * and spreads sideways, instead of backing off to its engage ring. There is no kiting in this
 * game (`AIDecideSystem`, v37) and this is not the pass that adds it.
 *
 * **A mob never walks round the player, or into a wall, to find room.** The nearest free angle
 * is searched only within `MAX_SLOT_DEVIATION` of the mob's own bearing; past that the mob is
 * placed one ring further out (`APPROACH_RINGS`), so a crowd forms an arc and then a second arc
 * behind it rather than a conga line cutting across the player. And a spot the mob cannot walk
 * to in a straight line is not a spot: `pathIsClear` rejects it and the mob falls back to the
 * radial approach it would have taken in v55. That fallback is what keeps the v55 report's own
 * example working — a mob standing in the mouth of a 1.5-body slit does not make the slit
 * impassable to the mob behind it, because there is no route to any spread spot from out there
 * and the straight-at-the-player route is still open.
 *
 * ## Determinism
 *
 * Integer throughout (design/06): `atan2Brad`/`cosFp`/`sinFp`/`isqrt`, never `Math.atan2` or
 * `Math.sqrt`. The buckets are keyed in first-seen order, the sort is stable and keyed on a
 * boolean, and candidate angles are visited in claim order with `+` before `-` and a STRICT
 * improvement test, so ties resolve the same way on every client.
 */
import { FP_SCALE, isqrt } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { atan2Brad, cosFp, sinFp, normBrad, BRAD_FULL, BRAD_HALF, BRAD_QUARTER } from '../math/trig';
import {
  DEFAULT_ENEMY_ENGAGE_RANGE_FP,
  DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
} from '../content/enemies';
import { blockingRadius, standoffRadius } from '../state/actorRadius';
import type { GameState } from '../state/GameState';
import type { EnemyActor } from '../state/entities';
import { pushOutOfObstacle, pushOutOfWall, queryRadiusFor, type Point } from './solidBounds';

/** The point a mob is walking to this tick. Recomputed every tick — never stored on state. */
export interface ApproachSlot {
  x: Fp;
  y: Fp;
}

/**
 * brad per radian, truncated (65536 / 2π = 10430.38). Turns an arc length on the ring into an
 * angle — an ARC, deliberately, rather than the chord two mob centres are actually separated by,
 * because the chord needs an arcsine and this file is integer-only.
 *
 * The approximation is worth stating in the direction it errs: an arc is longer than its chord,
 * so asking for `standoffRadius` of arc leaves two mobs about 0.5% CLOSER than that in a straight
 * line (14 fp, under half a pixel, at the shipped numbers). `MovementSystem.resolveStandingSpacing`
 * closes that last fraction, which is one of the reasons that pass is still load-bearing after
 * this one — the destination gets a garrison to within half a pixel of its spacing on the tick it
 * arrives, and the correction finishes the job.
 */
const BRAD_PER_RADIAN = 10430;

/**
 * How far round the ring a mob may be pushed from its own bearing before it is sent to the next
 * ring out instead. A quarter circle: at 90° the straight line to the destination already
 * passes at ~0.87 of the ring radius from the target, and anything wider starts cutting across
 * the player rather than curving around them.
 */
const MAX_SLOT_DEVIATION = BRAD_QUARTER;

/** Rings tried before a mob gives up and stands at its own bearing on the outermost one. */
const APPROACH_RINGS = 3;

/**
 * How many walking steps INSIDE its engage range a mob's innermost spot sits.
 *
 * `AIDecideSystem` stops a mob once it is within one step of its spot (a step is the finest
 * move it has; a tighter tolerance only buys a permanent one-tick-out, one-tick-back jitter),
 * so a spot placed at exactly `engageRangeFp` would let it settle one step OUTSIDE the range
 * it is supposed to be shooting from and then stand there not shooting. Two steps of margin
 * covers that step plus the couple of fp the atan2 → cos/sin round trip costs at `FP_SCALE`
 * 1000, and comes to 5 px at the shipped numbers — a mob stands just inside its own range
 * rather than balanced on the edge of it.
 */
const RING_MARGIN_STEPS = 2;

/**
 * Most points sampled along a candidate route by `pathIsClear`. The sample step is the mob's
 * own clearance, which cannot skip over any wall this game authors, and the cap only widens
 * that step on a long route — where a missed thin wall costs one tick of walking at a spot the
 * mob will re-evaluate (denser, because closer) on the next one.
 */
const PATH_SAMPLE_CAP = 16;

/** A spot already taken on some ring, in the target's frame. */
interface Claim {
  angle: number;
  half: number;
  ring: number;
}

/** Mobs with no `roomId` (a flat `waves`/tutorial config) share one bucket — the arena is
 *  their room, the same convention `AIDecideSystem`'s fire budget uses. */
const NO_ROOM = '#unroomed';

/** Reused by the walkability probe below: refilled per call, never read across calls. */
const probe: Point = { x: 0 as Fp, y: 0 as Fp };

/**
 * Fill `out[i]` with the point `mobs[i]` should walk to, given a target at (`tx`, `ty`).
 *
 * `mobs` must be alive, aggroed and chasing that target, in `state.enemies` order. `out` is
 * resized to match and is caller-owned scratch — this runs every tick for every activated room,
 * so the points are written in place rather than allocated afresh.
 */
export function assignApproachSlots(
  state: GameState,
  mobs: readonly EnemyActor[],
  tx: Fp,
  ty: Fp,
  out: ApproachSlot[],
): void {
  out.length = mobs.length;
  // Mobs only ever crowd the mobs of their own room — the room is this game's aggro unit
  // (design/05), and bucketing keeps the O(k²) search below scoped to one garrison.
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < mobs.length; i++) {
    const key = mobs[i]!.roomId ?? NO_ROOM;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }

  for (const idxs of buckets.values()) {
    // Stable sort over an already-ascending array: arrived mobs first, everyone else in spawn
    // order. `Array.prototype.sort` is specified stable, so this is a two-tier priority and not
    // a reshuffle.
    idxs.sort((a, b) => rank(mobs[a]!) - rank(mobs[b]!));
    const claims: Claim[] = [];
    for (const i of idxs) {
      const e = mobs[i]!;
      const into = out[i] ?? (out[i] = { x: 0 as Fp, y: 0 as Fp });
      placeOne(state, e, tx, ty, claims, into);
    }
  }
}

/** Arrived mobs (0) are placed before travelling ones (1) — see the module note. */
function rank(e: EnemyActor): number {
  return e.holding ? 0 : 1;
}

/**
 * Give one mob a spot: its own bearing on the innermost ring if that is free, else the nearest
 * free angle within `MAX_SLOT_DEVIATION` on that ring, else the same search one ring out.
 *
 * Two things can send it back to the radial spot it would have walked to in v55 — nothing on
 * any ring was free (packed that hard, `resolveStandingSpacing` is the right thing to be doing
 * the work), or the spread spot is behind a wall from where the mob is standing. In both cases
 * the mob registers no claim: it is not going to stand there, so reserving it would only push
 * the next mob out of a spot nobody is using.
 */
function placeOne(
  state: GameState,
  e: EnemyActor,
  tx: Fp,
  ty: Fp,
  claims: Claim[],
  into: ApproachSlot,
): void {
  const bearing = atan2Brad(e.gy - ty, e.gx - tx) as number;
  const away = isqrt((e.gx - tx) * (e.gx - tx) + (e.gy - ty) * (e.gy - ty));
  const standoff = standoffRadius(e) as number;
  const speed = e.moveSpeedPerTick ?? DEFAULT_ENEMY_MOVE_SPEED_PER_TICK;
  const engage = e.engageRangeFp ?? DEFAULT_ENEMY_ENGAGE_RANGE_FP;
  const base = Math.max(engage - RING_MARGIN_STEPS * speed, 1);
  // Never further out than the mob already stands — the ring stops it closing, it does not
  // pull it back (see the module note's third rule).
  const radial = Math.min(base, away);

  for (let ring = 0; ring < APPROACH_RINGS; ring++) {
    // One standing DIAMETER between rings, the same distance two mobs keep side by side.
    const radius = Math.min(base + ring * 2 * standoff, away);
    const half = halfWidthAt(standoff, radius);
    const angle = nearestFreeAngle(bearing, half, claims, ring);
    if (angle === null) continue;
    if (angle === bearing && radius === radial) {
      // The spread asked for nothing this mob was not already going to do.
      claims.push({ angle, half, ring });
      ringPoint(tx, ty, radius, angle, into);
      return;
    }
    ringPoint(tx, ty, radius, angle, into);
    if (pathIsClear(state, e, into.x, into.y)) {
      claims.push({ angle, half, ring });
      return;
    }
    break; // walled off from the spread spots; the radial approach is still open
  }
  ringPoint(tx, ty, radial, bearing, into);
}

/**
 * Half the angle a mob's standing volume subtends at `radius` — its `standoffRadius` measured
 * as an arc rather than a chord, so two mobs whose half-widths just touch are about the sum of
 * their standoff radii apart along the ring (see `BRAD_PER_RADIAN` for which way that errs).
 *
 * DELIBERATELY UNBOUNDED above. A mob standing almost on top of the target subtends most of the
 * circle and the arithmetic says so; the natural instinct is to clamp that to a quarter circle,
 * and a mutation battery showed such a clamp is inert — `nearestFreeAngle` already refuses any
 * candidate further than `MAX_SLOT_DEVIATION` from the mob's own bearing, and every candidate a
 * quarter-circle-wide claim generates is past that, so clamped and unclamped reach the same
 * fallback by the same route. An inert guard that reads as load-bearing is worse than no guard:
 * it invites the next reader to assume `half` is bounded when nothing enforces it.
 *
 * The zero guard below is real, though: `radius` is 0 for a mob standing exactly on the target
 * (the clamp in `placeOne` allows it), and that is a divide by zero.
 */
function halfWidthAt(standoff: number, radius: number): number {
  if (radius <= 0) return BRAD_QUARTER;
  return Math.trunc((standoff * BRAD_PER_RADIAN) / radius);
}

/**
 * The free angle on `ring` closest to `bearing`, or null if every angle within
 * `MAX_SLOT_DEVIATION` conflicts with a claim.
 *
 * Candidates are just the two edges of each existing claim — the nearest free point to a
 * bearing that lands inside occupied arcs is always flush against one of them — so this is
 * O(claims²) per mob with no search resolution to tune and no drift as the numbers move.
 */
function nearestFreeAngle(
  bearing: number,
  half: number,
  claims: readonly Claim[],
  ring: number,
): number | null {
  if (isFree(bearing, half, claims, ring)) return bearing;
  let best: number | null = null;
  let bestDeviation = MAX_SLOT_DEVIATION + 1;
  for (const c of claims) {
    if (c.ring !== ring) continue;
    const need = half + c.half;
    // `+` before `-`, and a strict improvement test below, so an exact tie keeps the first
    // candidate found — one fixed answer on every client (design/06).
    for (const candidate of [normBrad(c.angle + need) as number, normBrad(c.angle - need) as number]) {
      const deviation = angularDistance(candidate, bearing);
      if (deviation > MAX_SLOT_DEVIATION || deviation >= bestDeviation) continue;
      if (!isFree(candidate, half, claims, ring)) continue;
      best = candidate;
      bestDeviation = deviation;
    }
  }
  return best;
}

/** Does a mob of half-width `half` standing at `angle` clear every claim on this ring? */
function isFree(angle: number, half: number, claims: readonly Claim[], ring: number): boolean {
  for (const c of claims) {
    if (c.ring !== ring) continue;
    if (angularDistance(angle, c.angle) < half + c.half) return false;
  }
  return true;
}

/** Shortest way round between two angles, in brad — always in [0, BRAD_HALF]. */
function angularDistance(a: number, b: number): number {
  const d = normBrad(a - b) as number;
  return d > BRAD_HALF ? BRAD_FULL - d : d;
}

/** Write the point at `angle` and `radius` from (`tx`, `ty`) into the caller's slot. */
function ringPoint(tx: Fp, ty: Fp, radius: number, angle: number, into: ApproachSlot): void {
  into.x = (tx + Math.trunc((radius * cosFp(angle)) / FP_SCALE)) as Fp;
  into.y = (ty + Math.trunc((radius * sinFp(angle)) / FP_SCALE)) as Fp;
}

/**
 * Can `e` walk from where it is to (`x`, `y`) without a solid in the way?
 *
 * Sampled rather than swept, because the answer only has to be good enough to choose between
 * two destinations — a mob's actual collision is still `MovementSystem`'s, and a wrong answer
 * here costs a tick of walking, never a body inside stone. Sampled at the mob's own clearance
 * so it cannot step over a wall this game authors (the thinnest are a grid cell), and the probe
 * is `MovementSystem`'s own push-out rather than a second opinion about what "inside a solid"
 * means — a point counts as blocked exactly when the movement code would shove an actor off it.
 */
function pathIsClear(state: GameState, e: EnemyActor, x: Fp, y: Fp): boolean {
  const r = blockingRadius(e);
  const dx = (x as number) - e.gx;
  const dy = (y as number) - e.gy;
  const len = isqrt(dx * dx + dy * dy);
  if (len === 0) return true;
  const steps = Math.min(Math.max(Math.trunc(len / Math.max(r as number, 1)), 1), PATH_SAMPLE_CAP);
  for (let i = 1; i <= steps; i++) {
    const px = (e.gx + Math.trunc((dx * i) / steps)) as Fp;
    const py = (e.gy + Math.trunc((dy * i) / steps)) as Fp;
    if (isInsideSolid(state, px, py, r)) return false;
  }
  return true;
}

/** Would `MovementSystem` push an actor of clearance `r` off this point? */
function isInsideSolid(state: GameState, x: Fp, y: Fp, r: Fp): boolean {
  for (const idx of state.spatialIndex.queryWalls(x, y, queryRadiusFor(r))) {
    probe.x = x;
    probe.y = y;
    pushOutOfWall(probe, r, state.walls[idx]!);
    if (probe.x !== x || probe.y !== y) return true;
  }
  for (const idx of state.spatialIndex.queryObstacles(x, y, r)) {
    probe.x = x;
    probe.y = y;
    pushOutOfObstacle(probe, r, state.obstacles[idx]!);
    if (probe.x !== x || probe.y !== y) return true;
  }
  return false;
}
