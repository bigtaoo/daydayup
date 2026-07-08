/**
 * Step 4 — Movement. Integrate vx/vy (fp displacement already baked per tick) and
 * vz + gravity on the z axis; clamp players inside the world bounds. Actor–wall /
 * actor–actor collision proper is design/07 (deferred); Stage B keeps the demo's
 * clamp-to-arena behavior. Enemies are stationary (vx/vy = 0) but are integrated
 * uniformly so future moving mobs need no special-casing.
 *
 * Ports Game.ts updatePlayer() move+clamp and Actor.updatePhysics() gravity,
 * float px → fp.
 */
import { addFp, subFp } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { SIM } from '../sim.config';
import type { GameState } from '../state/GameState';
import type { Actor } from '../state/entities';

export class MovementSystem {
  tick(state: GameState): void {
    for (const p of state.players) {
      if (!p.alive) continue;
      this.integrate(p);
      this.clampToWorld(state, p);
    }
    for (const e of state.enemies) {
      if (!e.alive) continue;
      this.integrate(e);
    }
  }

  private integrate(a: Actor): void {
    a.gx = addFp(a.gx, a.vx);
    a.gy = addFp(a.gy, a.vy);
    if (a.z > 0 || a.vz > 0) {
      a.vz = subFp(a.vz, SIM.player.gravity);
      a.z = addFp(a.z, a.vz);
      if (a.z < 0) {
        a.z = 0 as Fp;
        a.vz = 0 as Fp;
      }
    }
  }

  private clampToWorld(state: GameState, a: Actor): void {
    const m = SIM.player.margin;
    a.gx = Math.max(m, Math.min(state.worldW - m, a.gx)) as Fp;
    a.gy = Math.max(m, Math.min(state.worldH - m, a.gy)) as Fp;
  }
}
