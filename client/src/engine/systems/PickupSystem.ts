/**
 * Step 9 — Pickup. A player overlapping a collectable pickup applies it (health
 * heals up to maxHp; coins are score, tracked render-side) and the pickup is
 * consumed. Pickups dropped THIS tick are skipped (spawnTick guard) so a kill in
 * step 8 isn't vacuumed the same frame (design/08 ordering note). Collected
 * pickups are compacted out in place.
 *
 * Ports Game.ts updatePickups(): float px → fp, squared-distance overlap. The
 * render-only hover bob is dropped (visual, not sim).
 */
import { SIM } from '../sim.config';
import type { GameState } from '../state/GameState';
import { circlesOverlap, retainAlive } from './geom';

export class PickupSystem {
  tick(state: GameState): void {
    for (const item of state.pickups) {
      if (!item.alive || item.spawnTick === state.tick) continue;
      for (const p of state.players) {
        if (!p.alive) continue;
        if (!circlesOverlap(item.gx, item.gy, SIM.pickupRadius, p.gx, p.gy, p.radius)) continue;
        if (item.kind === 'health') p.hp = Math.min(p.maxHp, p.hp + SIM.drop.healAmount);
        item.alive = false;
        state.events.push({ type: 'pickup', kind: item.kind, gx: item.gx, gy: item.gy });
        break;
      }
    }
    retainAlive(state.pickups);
  }
}
