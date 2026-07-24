/**
 * Step 5 — Projectile step. Advance each bullet by its per-tick velocity, count
 * down its lifespan, and expire it when it dies or leaves the world margin.
 * Expired bullets are only marked dead here; the projectiles array is compacted
 * once at the end of HitResolve (step 7), after block/deflect and hits have also
 * had their say this tick.
 *
 * Ports Game.ts updateBullets() step()+bounds check (float px → fp). Bullet–wall
 * stop/expire proper is design/07; Stage B keeps the demo's out-of-bounds despawn.
 *
 * Ballistic motion (design/03/09 Frame axis, ROADMAP 1.1) — each shape's per-tick
 * rule, read from the fields WeaponFireSystem froze onto the bullet:
 *   - homing: turn `vx/vy` toward the nearest opposite-faction actor, ≤turnRateBrad
 *   - boomerang: reverse `vx/vy` once ticksAlive reaches returnAfterTicks
 *   - lob: moves exactly like straight; on natural lifespan expiry (landing) it is
 *     flagged `landed` instead of killed — HitResolveSystem (step 7) resolves the
 *     AoE blast through the normal resist/status hit path, then kills it (matching
 *     design/08's movement-vs-hit-resolution split)
 *   - beam: does not move at all (bulletSpeed 0); only its own beamTicksLeft
 *     counts down here — HitResolveSystem (step 7) owns its damage-over-window
 *   - straight: unchanged (`ballistic` undefined for pre-1.1 bullets is the same path)
 */
import { addFp, negFp } from '../math/fixed';
import { SIM } from '../sim.config';
import { circlesOverlap } from './geom';
import { turnToward } from '../content/ballistics';
import type { GameState } from '../state/GameState';
import type { Actor, Faction } from '../state/entities';

export class ProjectileStepSystem {
  tick(state: GameState): void {
    const m = SIM.bullet.oobMargin;
    for (const b of state.projectiles) {
      if (!b.alive) continue;

      if (b.ballistic === 'beam') {
        // Hitscan channel: frozen in place, no lifespan/oob/solid checks — only
        // its own duration matters (HitResolveSystem ticks its damage).
        if (b.beamTicksLeft !== undefined) {
          b.beamTicksLeft--;
          if (b.beamTicksLeft <= 0) b.alive = false;
        }
        continue;
      }

      if (b.ballistic === 'homing' && b.turnRateBrad !== undefined && b.speed !== undefined) {
        const target = nearestOpposing(state, b.faction, b.gx, b.gy);
        if (target) {
          const { vx, vy } = turnToward(b.vx, b.vy, b.speed, target.gx, target.gy, b.gx, b.gy, b.turnRateBrad);
          b.vx = vx;
          b.vy = vy;
        }
      } else if (b.ballistic === 'boomerang' && b.returnAfterTicks !== undefined && b.ticksAlive !== undefined) {
        b.ticksAlive++;
        if (b.ticksAlive === b.returnAfterTicks) {
          b.vx = negFp(b.vx);
          b.vy = negFp(b.vy);
        }
      }

      b.gx = addFp(b.gx, b.vx);
      b.gy = addFp(b.gy, b.vy);
      b.lifeTicks--;
      if (b.lifeTicks <= 0) {
        if (b.ballistic === 'lob' && b.blastRadius !== undefined) {
          b.landed = true; // HitResolveSystem (step 7) resolves the blast, then kills it
        } else {
          b.alive = false;
        }
        continue;
      }
      if (b.gx < -m || b.gx > state.worldW + m || b.gy < -m || b.gy > state.worldH + m) {
        b.alive = false;
        continue;
      }
      // Pillars are solid: a bullet that reaches one is absorbed (design/07 wall
      // stop). Pillars are tall, so no z-band gating — nothing shoots over them.
      // Endpoint test, matching the demo's despawn discipline (swept test is 07).
      for (const o of state.obstacles) {
        if (circlesOverlap(b.gx, b.gy, b.radius, o.gx, o.gy, o.radius)) {
          b.alive = false;
          break;
        }
      }
    }
  }
}

/** Nearest alive actor of the faction opposite `faction` — the homing target pool. */
function nearestOpposing(state: GameState, faction: Faction, x: number, y: number): Actor | null {
  const pool: readonly Actor[] = faction === 'player' ? state.enemies : state.players;
  let best: Actor | null = null;
  let bestSq = Infinity;
  for (const a of pool) {
    if (!a.alive) continue;
    const dx = (a.gx - x) as number;
    const dy = (a.gy - y) as number;
    const d = dx * dx + dy * dy;
    if (d < bestSq) {
      bestSq = d;
      best = a;
    }
  }
  return best;
}
