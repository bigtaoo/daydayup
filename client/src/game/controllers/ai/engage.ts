// Shared "engage the nearest hostile" shape (design/08 "render only produces
// input") — extracted 2026-07-28 from AllyController.ts and PvpBotController.ts,
// which had independently hand-rolled the identical nearest-by-squared-distance
// search + advance/hold/fire command construction, differing only in which
// candidate pool each one searches (AllyController: s.enemies; PvpBotController:
// other-team s.players) and what happens when no candidate qualifies
// (AllyController falls back to regrouping on the leader; PvpBotController just
// idles) — that fallback stays caller-side rather than being forced into one
// over-parameterized function.
import { Button, makeCommand, quantizeMove, FP_SCALE, type Brad, type PlayerCommand } from '@dd/engine';

export const gridFp = (g: number): number => g * FP_SCALE; // 1 grid unit = FP_SCALE fp
export const FIRE_RANGE_FP = gridFp(11); // open fire once this close to a target
export const KEEP_DIST_FP = gridFp(4); //   stop advancing inside this ring (don't body-block)

export interface Point {
  gx: number;
  gy: number;
}

/** A bare "do nothing" command: no movement, no fire. Facing is engine-decided
 *  (design/10 v33) — the caller no longer needs to track/pass one. */
export function idleCommand(owner: number, tick: number): PlayerCommand {
  return makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });
}

/**
 * Move toward the nearest candidate (squared fp distance — JS doubles, no overflow
 * worry at arena/floor scale), holding spacing at KEEP_DIST_FP and firing once
 * within FIRE_RANGE_FP. Returns null if `candidates` is empty so the caller decides
 * its own no-target fallback. Facing is engine-decided (design/10 v33, ApplyInputSystem
 * auto-faces the nearest hostile) — this only decides movement + fire.
 */
export function engageNearest(owner: number, tick: number, me: Point, candidates: Iterable<Point>): PlayerCommand | null {
  let target: Point | null = null;
  let best = Infinity;
  for (const c of candidates) {
    const dx = c.gx - me.gx;
    const dy = c.gy - me.gy;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; target = c; }
  }
  if (!target) return null;

  const dx = target.gx - me.gx;
  const dy = target.gy - me.gy;
  const dist = Math.hypot(dx, dy);
  // Advance while out of spacing; hold position once close enough to fight.
  const move = dist > KEEP_DIST_FP ? quantizeMove(dx, dy) : { moveBrad: 0 as Brad, moveMag: 0 };
  const buttons = dist <= FIRE_RANGE_FP ? Button.FIRE : 0;
  return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, buttons });
}
