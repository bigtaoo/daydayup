/**
 * Step 9 — Pickup. A player overlapping a collectable pickup applies it and the
 * pickup is consumed. Pickups dropped THIS tick are skipped (spawnTick guard) so a
 * kill in step 8 isn't vacuumed the same frame (design/08 ordering note). Collected
 * pickups are compacted out in place.
 *
 * Effects (design/05 the in-run power ramp):
 *   health — heal up to maxHp.
 *   coin   — no sim effect (score is derived render-side from the event).
 *   weapon — replace the active slot with the dropped weapon and reset its cooldown.
 *
 * Ports Game.ts updatePickups(): float px → fp, squared-distance overlap. The
 * render-only hover bob is dropped (visual, not sim).
 */
import { SIM } from '../sim.config';
import { HEALTH_PICKUP_HEAL } from '../content/drops';
import { WEAPON_SIM_BY_ID, makeWeapon } from '../content/weapons';
import type { GameState } from '../state/GameState';
import type { PickupItem, PlayerActor } from '../state/entities';
import { circlesOverlap, retainAlive } from './geom';

export class PickupSystem {
  tick(state: GameState): void {
    for (const item of state.pickups) {
      if (!item.alive || item.spawnTick === state.tick) continue;
      for (const p of state.players) {
        if (!p.alive) continue;
        if (!circlesOverlap(item.gx, item.gy, SIM.pickupRadius, p.gx, p.gy, p.radius)) continue;
        this.apply(p, item);
        item.alive = false;
        state.events.push({
          type: 'pickup',
          kind: item.kind,
          gx: item.gx,
          gy: item.gy,
          weaponId: item.weaponId,
        });
        break;
      }
    }
    retainAlive(state.pickups);
  }

  private apply(p: PlayerActor, item: PickupItem): void {
    switch (item.kind) {
      case 'health':
        p.hp = Math.min(p.maxHp, p.hp + HEALTH_PICKUP_HEAL);
        break;
      case 'coin':
        break; // score is render-side
      case 'weapon':
        if (item.weaponId) this.applyWeapon(p, item.weaponId);
        break;
    }
  }

  private applyWeapon(p: PlayerActor, weaponId: string): void {
    const spec = WEAPON_SIM_BY_ID[weaponId];
    if (!spec) return; // forward-compat: unknown weapon id → no-op (design/09)
    // Swap the active slot for a fresh runtime of the dropped weapon.
    const w = makeWeapon(spec);
    p.weapons[p.activeSlot] = w;
    p.weapon = w;
  }
}
