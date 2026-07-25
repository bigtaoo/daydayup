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
 *   - homing: turn `vx/vy` toward the nearest HOSTILE actor (design/15), ≤turnRateBrad
 *   - boomerang: reverse `vx/vy` once ticksAlive reaches returnAfterTicks
 *   - lob: moves exactly like straight; on natural lifespan expiry (landing) it is
 *     flagged `landed` instead of killed — HitResolveSystem (step 7) resolves the
 *     AoE blast through the normal resist/status hit path, then kills it (matching
 *     design/08's movement-vs-hit-resolution split)
 *   - beam: does not move at all (bulletSpeed 0); only its own beamTicksLeft
 *     counts down here — HitResolveSystem (step 7) owns its damage-over-window
 *   - orbit: circles its owner at a fixed radius (position set absolutely from the
 *     owner's live centre; bulletSpeed 0, so the integrate is a no-op) until it hits
 *     something (consumed like any bullet), its lifespan ends, or the owner is gone
 *   - straight: unchanged (`ballistic` undefined for pre-1.1 bullets is the same path)
 */
import { addFp, negFp } from '../math/fixed';
import { SIM } from '../sim.config';
import { circleOverlapsAabb, circlesOverlap } from './geom';
import { orbitStep, turnToward } from '../content/ballistics';
import { nearestHostile } from './targeting';
import type { GameState } from '../state/GameState';
import type { Actor } from '../state/entities';

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
        const target = nearestHostile(state, b, b.gx, b.gy);
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
      } else if (
        b.ballistic === 'orbit' &&
        b.orbitAngleBrad !== undefined &&
        b.orbitAngularVelBrad !== undefined &&
        b.orbitRadius !== undefined
      ) {
        // Orbit tracks its (moving) owner: no owner ⇒ nothing to circle, so it dies.
        const owner = actorById(state, b.ownerId);
        if (!owner || !owner.alive) {
          b.alive = false;
          continue;
        }
        const { angle, x, y } = orbitStep(owner.gx, owner.gy, b.orbitAngleBrad, b.orbitAngularVelBrad, b.orbitRadius);
        b.orbitAngleBrad = angle;
        b.gx = x; // set absolutely from the owner; vx/vy are 0 so the integrate below is a no-op
        b.gy = y;
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
      let stopped = false;
      for (const o of state.obstacles) {
        if (circlesOverlap(b.gx, b.gy, b.radius, o.gx, o.gy, o.radius)) {
          b.alive = false;
          stopped = true;
          break;
        }
      }
      // AABB walls (design/07/09, ROADMAP 1.2) get the same stop/expire treatment.
      if (!stopped) {
        for (const w of state.walls) {
          if (circleOverlapsAabb(b.gx, b.gy, b.radius, w)) {
            b.alive = false;
            break;
          }
        }
      }
    }
  }
}

/** Find an actor by id across both arrays — the orbit owner lookup. Undefined id (any
 * non-orbit bullet) returns null without scanning. */
function actorById(state: GameState, id: number | undefined): Actor | null {
  if (id === undefined) return null;
  for (const p of state.players) if (p.id === id) return p;
  for (const e of state.enemies) if (e.id === id) return e;
  return null;
}
