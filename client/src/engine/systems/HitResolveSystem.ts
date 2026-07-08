/**
 * Step 7 — Hit resolution. Bullet–actor overlap deals damage (enemy bullets vs
 * players, player/deflected bullets vs enemies) and consumes the bullet; a melee
 * swing that started this tick (justSwung) deals arc damage to every enemy in its
 * sector, once. Damage only lowers hp here — death is decided in step 8, matching
 * design/08's separation. The projectiles array is compacted in place at the end,
 * after step/block/hit have all resolved.
 *
 * Ports the hit branches of Game.ts updateBullets() and resolveMeleeHit();
 * radians → brad, float px → fp, squared-distance overlap tests. Knockback / armor
 * / i-frames are design/07 and land later. (The demo's per-frame multi-hit melee
 * is intentionally corrected to once-per-swing, per design/07.)
 */
import { atan2Brad, bradDiff } from '../math/trig';
import type { GameState } from '../state/GameState';
import type { MeleeSimSpec } from '../state/entities';
import { circlesOverlap, retainAlive } from './geom';

export class HitResolveSystem {
  tick(state: GameState): void {
    for (const b of state.projectiles) {
      if (!b.alive) continue;
      if (b.faction === 'enemy') {
        for (const p of state.players) {
          if (!p.alive) continue;
          if (!circlesOverlap(b.gx, b.gy, b.radius, p.gx, p.gy, p.radius)) continue;
          p.hp -= b.damage;
          b.alive = false;
          state.events.push({ type: 'hit', target: p.id, faction: 'enemy', gx: p.gx, gy: p.gy, damage: b.damage });
          break;
        }
      } else {
        for (const e of state.enemies) {
          if (!e.alive) continue;
          if (!circlesOverlap(b.gx, b.gy, b.radius, e.gx, e.gy, e.radius)) continue;
          e.hp -= b.damage;
          b.alive = false;
          state.events.push({ type: 'hit', target: e.id, faction: 'player', gx: e.gx, gy: e.gy, damage: b.damage });
          break;
        }
      }
    }

    for (const p of state.players) {
      const w = p.weapon;
      if (!p.alive || !w || w.spec.kind !== 'melee' || !w.justSwung) continue;
      this.meleeArc(state, p, w.spec);
    }

    retainAlive(state.projectiles);
  }

  private meleeArc(state: GameState, p: GameState['players'][number], spec: MeleeSimSpec): void {
    for (const e of state.enemies) {
      if (!e.alive) continue;
      const dx = e.gx - p.gx;
      const dy = e.gy - p.gy;
      const reach = spec.range + e.radius;
      if (dx * dx + dy * dy > reach * reach) continue;
      const ang = atan2Brad(dy, dx);
      if (Math.abs(bradDiff(ang, p.facing)) > spec.arcHalf) continue;
      e.hp -= spec.damage;
      state.events.push({ type: 'hit', target: e.id, faction: 'player', gx: e.gx, gy: e.gy, damage: spec.damage });
    }
  }
}
