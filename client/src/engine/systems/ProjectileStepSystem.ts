/**
 * Step 5 — Projectile step. Advance each bullet by its per-tick velocity, count
 * down its lifespan, and expire it when it dies or leaves the world margin.
 * Expired bullets are only marked dead here; the projectiles array is compacted
 * once at the end of HitResolve (step 7), after block/deflect and hits have also
 * had their say this tick.
 *
 * Ports Game.ts updateBullets() step()+bounds check (float px → fp). Bullet–wall
 * stop/expire proper is design/07; Stage B keeps the demo's out-of-bounds despawn.
 */
import { addFp } from '../math/fixed';
import { SIM } from '../sim.config';
import type { GameState } from '../state/GameState';

export class ProjectileStepSystem {
  tick(state: GameState): void {
    const m = SIM.bullet.oobMargin;
    for (const b of state.projectiles) {
      if (!b.alive) continue;
      b.gx = addFp(b.gx, b.vx);
      b.gy = addFp(b.gy, b.vy);
      b.lifeTicks--;
      if (b.lifeTicks <= 0) {
        b.alive = false;
        continue;
      }
      if (b.gx < -m || b.gx > state.worldW + m || b.gy < -m || b.gy > state.worldH + m) {
        b.alive = false;
      }
    }
  }
}
