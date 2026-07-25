/**
 * Step 6 — Deflect (parry). Deflection is NOT a separate held state: it is part of
 * a melee swing. For each player whose melee weapon swung THIS tick (justSwung) and
 * whose spec has `deflect`, any bullet HOSTILE to that player inside the swing's
 * sector (same `range` + `arcHalf` the damage uses) — design/15: no longer just
 * "enemy-faction," so a rival player's bullet can be parried too — flips to the
 * deflector's own team + faction and is redirected toward the nearest actor hostile
 * to the deflector (or mirror-forward along facing when none is in range), at the
 * weapon's deflect speed. Runs BEFORE hit resolution (design/08) so a just-deflected
 * bullet can't still damage the swinger this tick.
 *
 * design/03/05: parry is melee-only and lives inside the attack — swing at the
 * right moment and the arc that hits enemies also bats bullets back. No block key.
 */
import { mulFp } from '../math/fixed';
import { atan2Brad, bradDiff, cosFp, sinFp } from '../math/trig';
import type { Brad } from '../math/trig';
import type { GameState } from '../state/GameState';
import type { MeleeSimSpec } from '../state/entities';
import { isHostile } from '../state/entities';
import { nearestHostile } from './targeting';

const DEFLECT_LIFE_TICKS = 90; // redirected bullet gets a fresh lifespan (demo reset)

export class DeflectSystem {
  tick(state: GameState): void {
    for (const p of state.players) {
      if (!p.alive) continue;
      const w = p.weapon;
      if (!w || w.spec.kind !== 'melee' || !w.justSwung || !w.spec.deflect) continue;
      const spec: MeleeSimSpec = w.spec;

      for (const b of state.projectiles) {
        if (!b.alive || !isHostile(p, b)) continue;
        const dx = b.gx - p.gx;
        const dy = b.gy - p.gy;
        if (dx * dx + dy * dy > spec.range * spec.range) continue; // swing reach
        const toBullet = atan2Brad(dy, dx);
        if (Math.abs(bradDiff(toBullet, p.facing)) > spec.arcHalf) continue; // swing arc

        const target = nearestHostile(state, p, b.gx, b.gy);
        const a: Brad = target
          ? atan2Brad(target.gy - b.gy, target.gx - b.gx)
          : p.facing;
        b.vx = mulFp(cosFp(a), spec.deflectSpeed);
        b.vy = mulFp(sinFp(a), spec.deflectSpeed);
        b.faction = 'player';
        b.teamId = p.teamId; // now hostile to the ORIGINAL owner's team, not the deflector's
        b.lifeTicks = DEFLECT_LIFE_TICKS;
        state.events.push({ type: 'deflect', gx: b.gx, gy: b.gy });
      }
    }
  }
}
