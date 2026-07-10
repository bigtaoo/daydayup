/**
 * Step 4 — Movement. Integrate vx/vy (fp displacement already baked per tick) on
 * the 2D ground plane; push actors out of static round solids (pillars); clamp
 * players inside the world bounds. Movement is strictly 2D — there is no z axis /
 * gravity (jump was removed; a future dodge is a planar blink, not a hop).
 * Actor–actor collision proper is design/07 (still deferred); this realizes the
 * static-solid half against round pillars. Enemies are stationary (vx/vy = 0) but
 * are integrated + resolved uniformly so future moving mobs need no special-casing.
 *
 * Ports Game.ts updatePlayer() move+clamp, float px → fp. Push-out uses isqrt
 * (design/06 banned Math.sqrt).
 */
import { addFp, isqrt } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { PLAYER } from '../content/players';
import type { GameState } from '../state/GameState';
import type { Actor } from '../state/entities';

export class MovementSystem {
  tick(state: GameState): void {
    for (const p of state.players) {
      if (!p.alive) continue;
      this.integrate(p);
      this.resolveObstacles(state, p);
      this.clampToWorld(state, p);
    }
    for (const e of state.enemies) {
      if (!e.alive) continue;
      this.integrate(e);
      this.resolveObstacles(state, e);
    }
  }

  private integrate(a: Actor): void {
    // Chill (ice status) scales this tick's displacement down; the stored vx/vy are
    // untouched (players re-derive them each tick from input, enemies are 0), so the
    // slow is purely a movement-time factor. Integer per-mille scale (design/06).
    let vx = a.vx;
    let vy = a.vy;
    const st = a.status;
    if (st.chillTicks > 0 && st.chillSlow > 0) {
      const keep = 1000 - st.chillSlow; // fraction of speed retained, per-mille
      vx = Math.trunc((vx * keep) / 1000) as Fp;
      vy = Math.trunc((vy * keep) / 1000) as Fp;
    }
    a.gx = addFp(a.gx, vx);
    a.gy = addFp(a.gy, vy);
  }

  /**
   * Push the actor out of any static round solid it overlaps. Circle-vs-circle:
   * if centre distance < r_actor + r_obstacle, shift the actor out along the
   * centre line by the penetration depth. Obstacles are static, so the actor
   * absorbs the full push (design/07's half-each split is for actor–actor).
   * Iterated in fixed array order — deterministic when solids overlap.
   */
  private resolveObstacles(state: GameState, a: Actor): void {
    for (const o of state.obstacles) {
      const dx = a.gx - o.gx;
      const dy = a.gy - o.gy;
      // Feet footprint, not the full body — lets the tall sprite overlap the solid.
      const minDist = a.footprintRadius + o.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minDist * minDist) continue; // no overlap
      const dist = isqrt(distSq);
      if (dist === 0) {
        // Exactly concentric — no defined push direction; nudge along +x by the
        // full clearance so the choice is deterministic across clients.
        a.gx = addFp(a.gx, minDist as Fp);
        continue;
      }
      const pen = minDist - dist; // fp penetration depth
      // (dx,dy)/dist is the unit outward normal; × pen gives the fp displacement.
      a.gx = (a.gx + Math.trunc((dx * pen) / dist)) as Fp;
      a.gy = (a.gy + Math.trunc((dy * pen) / dist)) as Fp;
    }
  }

  private clampToWorld(state: GameState, a: Actor): void {
    const m = PLAYER.margin;
    a.gx = Math.max(m, Math.min(state.worldW - m, a.gx)) as Fp;
    a.gy = Math.max(m, Math.min(state.worldH - m, a.gy)) as Fp;
  }
}
