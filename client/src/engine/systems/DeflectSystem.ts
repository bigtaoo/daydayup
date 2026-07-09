/**
 * Step 6 — Deflect (parry). Deflection is NOT a separate held state: it is part of
 * a melee swing. For each player whose melee weapon swung THIS tick (justSwung) and
 * whose spec has `deflect`, any enemy bullet inside the swing's sector (same
 * `range` + `arcHalf` the damage uses) flips faction to 'player' and is redirected
 * toward the nearest alive enemy (or mirror-forward along facing when the arena is
 * clear), at the weapon's deflect speed. Runs BEFORE hit resolution (design/08) so
 * a just-deflected bullet can't still damage the swinger this tick.
 *
 * design/03/05: parry is melee-only and lives inside the attack — swing at the
 * right moment and the arc that hits enemies also bats bullets back. No block key.
 */
import { mulFp } from '../math/fixed';
import { atan2Brad, bradDiff, cosFp, sinFp } from '../math/trig';
import type { Brad } from '../math/trig';
import type { GameState } from '../state/GameState';
import type { MeleeSimSpec } from '../state/entities';
import { nearestAliveEnemy } from './geom';

const DEFLECT_LIFE_TICKS = 90; // redirected bullet gets a fresh lifespan (demo reset)

export class DeflectSystem {
  tick(state: GameState): void {
    for (const p of state.players) {
      if (!p.alive) continue;
      const w = p.weapon;
      if (!w || w.spec.kind !== 'melee' || !w.justSwung || !w.spec.deflect) continue;
      const spec: MeleeSimSpec = w.spec;

      for (const b of state.projectiles) {
        if (!b.alive || b.faction !== 'enemy') continue;
        const dx = b.gx - p.gx;
        const dy = b.gy - p.gy;
        if (dx * dx + dy * dy > spec.range * spec.range) continue; // swing reach
        const toBullet = atan2Brad(dy, dx);
        if (Math.abs(bradDiff(toBullet, p.facing)) > spec.arcHalf) continue; // swing arc

        const target = nearestAliveEnemy(state.enemies, b.gx, b.gy);
        const a: Brad = target
          ? atan2Brad(target.gy - b.gy, target.gx - b.gx)
          : p.facing;
        b.vx = mulFp(cosFp(a), spec.deflectSpeed);
        b.vy = mulFp(sinFp(a), spec.deflectSpeed);
        b.faction = 'player';
        b.lifeTicks = DEFLECT_LIFE_TICKS;
        state.events.push({ type: 'deflect', gx: b.gx, gy: b.gy });
      }
    }
  }
}
