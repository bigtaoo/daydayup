/**
 * Step 4 — Movement. Integrate vx/vy (fp displacement already baked per tick) on
 * the 2D ground plane; push actors out of static round solids (pillars) AND static
 * rectangular solids (AABB tile/wall geometry, design/07/09 ROADMAP 1.2); clamp
 * players inside the world bounds. Movement is strictly 2D — there is no z axis /
 * gravity (jump was removed; a future dodge is a planar blink, not a hop).
 * Actor–actor collision proper is design/07 (still deferred); this realizes the
 * static-solid half against round pillars + AABB walls. Enemies are stationary
 * (vx/vy = 0) but are integrated + resolved uniformly so future moving mobs need
 * no special-casing.
 *
 * Ports Game.ts updatePlayer() move+clamp, float px → fp. Push-out uses isqrt
 * (design/06 banned Math.sqrt).
 */
import { addFp, isqrt } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { PLAYER_BASE } from '../content/players';
import type { GameState } from '../state/GameState';
import type { Actor } from '../state/entities';

export class MovementSystem {
  tick(state: GameState): void {
    for (const p of state.players) {
      if (!p.alive) continue;
      this.integrate(p);
      this.resolveObstacles(state, p);
      this.resolveWalls(state, p);
      this.clampToWorld(state, p);
    }
    for (const e of state.enemies) {
      if (!e.alive) continue;
      this.integrate(e);
      this.resolveObstacles(state, e);
      this.resolveWalls(state, e);
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
    for (const idx of state.spatialIndex.queryObstacles(a.gx, a.gy, a.footprintRadius)) {
      const o = state.obstacles[idx]!;
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

  /**
   * Push the actor's feet footprint out of any overlapping AABB wall (design/07/09,
   * ROADMAP 1.2 — the "axis-separation push" deferred alongside RoomState). Two
   * cases, matching standard circle-vs-rect resolution:
   *   - centre outside the rect: push along the normal to the nearest edge point,
   *     same style as the round-pillar resolver above (isqrt, no Math.sqrt).
   *   - centre inside the rect (fully engulfed footprint): axis-separation — push
   *     out along whichever single axis reaches open air soonest. Ties (equal
   *     distance to two edges) resolve in a fixed +x/+y-preferring order so every
   *     client picks the same edge (mirrors the round-pillar concentric-overlap rule).
   */
  private resolveWalls(state: GameState, a: Actor): void {
    for (const idx of state.spatialIndex.queryWalls(a.gx, a.gy, a.footprintRadius)) {
      const w = state.walls[idx]!;
      const r = a.footprintRadius;
      const right = (w.x + w.w) as Fp;
      const bottom = (w.y + w.h) as Fp;
      const closestX = Math.max(w.x, Math.min(a.gx, right)) as Fp;
      const closestY = Math.max(w.y, Math.min(a.gy, bottom)) as Fp;
      const dx = a.gx - closestX;
      const dy = a.gy - closestY;
      const distSq = dx * dx + dy * dy;
      if (distSq > 0) {
        if (distSq >= r * r) continue; // no overlap
        const dist = isqrt(distSq);
        const pen = r - dist;
        a.gx = (a.gx + Math.trunc((dx * pen) / dist)) as Fp;
        a.gy = (a.gy + Math.trunc((dy * pen) / dist)) as Fp;
        continue;
      }
      // Centre is inside the rect: push out along the nearest single edge.
      const pushLeft = (a.gx - w.x) as number;
      const pushRight = (right - a.gx) as number;
      const pushTop = (a.gy - w.y) as number;
      const pushBottom = (bottom - a.gy) as number;
      const min = Math.min(pushLeft, pushRight, pushTop, pushBottom);
      if (min === pushRight) a.gx = (right + r) as Fp;
      else if (min === pushLeft) a.gx = (w.x - r) as Fp;
      else if (min === pushBottom) a.gy = (bottom + r) as Fp;
      else a.gy = (w.y - r) as Fp;
    }
  }

  private clampToWorld(state: GameState, a: Actor): void {
    const m = PLAYER_BASE.margin;
    a.gx = Math.max(m, Math.min(state.worldW - m, a.gx)) as Fp;
    a.gy = Math.max(m, Math.min(state.worldH - m, a.gy)) as Fp;
  }
}
