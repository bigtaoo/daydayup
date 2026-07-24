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
import { HEAL_PICKUP_AMOUNT } from '../content/drops';
import { WEAPON_SIM_BY_ID, makeWeapon } from '../content/weapons';
import { RUN_BUFFS, sumBuffs } from '../balance/runbuffs';
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
          buffId: item.buffId,
          materialId: item.materialId,
          qty: item.qty,
        });
        break;
      }
    }
    retainAlive(state.pickups);
  }

  private apply(p: PlayerActor, item: PickupItem): void {
    switch (item.kind) {
      case 'heal':
        p.hp = Math.min(p.maxHp, p.hp + HEAL_PICKUP_AMOUNT);
        break;
      case 'material':
        break; // no in-sim effect yet — a distinct, not-yet-banked currency (design/05; banking is 1.4/1.5)
      case 'weapon':
        if (item.weaponId) this.applyWeapon(p, item.weaponId);
        break;
      case 'buff':
        if (item.buffId) this.applyBuff(p, item.buffId);
        break;
    }
  }

  /**
   * Add a run buff to the player's stack (design/14). mult_* buffs take effect at use
   * time (WeaponFire / HitResolve read the summed stack); flat_hp is cumulative actor
   * state, so it is applied HERE — but Σ-then-clamp still holds: we add only the
   * *delta* the new buff contributes to the clamped total (0 once the cap is reached),
   * and grow both maxHp and current hp by it. Unknown id → no-op (forward-compat).
   */
  private applyBuff(p: PlayerActor, buffId: string): void {
    if (!RUN_BUFFS[buffId]) return;
    const before = sumBuffs(p.buffs).flat_hp;
    p.buffs.push(buffId);
    const delta = sumBuffs(p.buffs).flat_hp - before;
    if (delta > 0) {
      p.maxHp += delta;
      p.hp += delta;
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
