/**
 * Integer geometry helpers shared by the collision-touching systems. All compares
 * are squared-distance so nothing calls isqrt/Math.sqrt (design/06 banned list).
 * Fp arithmetic on plain `+`/`-`/`*` is fine here: we only compare, never store.
 */
import type { Fp } from '../math/fixed';
import type { EnemyActor } from '../state/entities';

/** True if two circles overlap: (ax,ay,ar) vs (bx,by,br). */
export function circlesOverlap(ax: Fp, ay: Fp, ar: Fp, bx: Fp, by: Fp, br: Fp): boolean {
  const dx = ax - bx;
  const dy = ay - by;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Remove dead entries in place, preserving order (push order = iteration order,
 * design/08). Arrays on GameState are readonly fields, so systems compact in
 * place rather than reassigning. Deterministic: a stable front-to-back compaction.
 */
export function retainAlive<T extends { alive: boolean }>(arr: T[]): void {
  let w = 0;
  for (let r = 0; r < arr.length; r++) {
    const item = arr[r]!;
    if (item.alive) arr[w++] = item;
  }
  arr.length = w;
}

/** Nearest alive enemy to a point, or null. Ties broken by array order (deterministic). */
export function nearestAliveEnemy(enemies: readonly EnemyActor[], x: Fp, y: Fp): EnemyActor | null {
  let best: EnemyActor | null = null;
  let bestSq = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const dx = e.gx - x;
    const dy = e.gy - y;
    const d = dx * dx + dy * dy;
    if (d < bestSq) {
      bestSq = d;
      best = e;
    }
  }
  return best;
}
