/**
 * Step 6 — Block / deflect. For each player holding a melee block, any enemy
 * bullet inside the block arc flips faction to 'player' and is redirected toward
 * the nearest alive enemy (or mirror-forward along the blocker's facing when the
 * arena is clear), at the weapon's deflect speed. Runs BEFORE hit resolution
 * (design/08) so a just-deflected bullet can't still damage the blocker this tick.
 *
 * Ports the block/deflect branch of Game.ts updateBullets(): radians → brad,
 * float px → fp; the arc test uses integer bradDiff instead of atan2 differences.
 */
import { mulFp } from '../math/fixed';
import { atan2Brad, bradDiff, cosFp, sinFp } from '../math/trig';
import type { Brad } from '../math/trig';
import type { GameState } from '../state/GameState';
import type { MeleeSimSpec } from '../state/entities';
import { nearestAliveEnemy } from './geom';

const DEFLECT_LIFE_TICKS = 90; // redirected bullet gets a fresh lifespan (demo reset)

export class BlockDeflectSystem {
  tick(state: GameState): void {
    for (const p of state.players) {
      if (!p.alive) continue;
      const w = p.weapon;
      if (!w || w.spec.kind !== 'melee' || !w.blocking) continue;
      const spec: MeleeSimSpec = w.spec;

      for (const b of state.projectiles) {
        if (!b.alive || b.faction !== 'enemy') continue;
        const dx = b.gx - p.gx;
        const dy = b.gy - p.gy;
        if (dx * dx + dy * dy > spec.blockRange * spec.blockRange) continue;
        const toBullet = atan2Brad(dy, dx);
        if (Math.abs(bradDiff(toBullet, p.facing)) > spec.blockHalf) continue;

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
