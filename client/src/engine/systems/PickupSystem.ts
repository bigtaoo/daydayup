/**
 * Step 9 — Pickup. A player overlapping a collectable pickup applies it and the
 * pickup is consumed. Pickups dropped THIS tick are skipped (spawnTick guard) so a
 * kill in step 8 isn't vacuumed the same frame (design/08 ordering note). Collected
 * pickups are compacted out in place.
 *
 * Effects (design/05 the in-run power ramp):
 *   health — heal up to maxHp.
 *   coin   — no sim effect (score is derived render-side from the event).
 *   affix  — append to the run stack; a weapon-kind affix re-resolves every weapon
 *            slot (base + stack), an actor-kind affix (flat_maxhp) grows+heals hp.
 *   weapon — replace the active slot's base with the dropped weapon, re-applying the
 *            current affix stack (you keep your buffs), and reset its cooldown.
 *
 * Ports Game.ts updatePickups(): float px → fp, squared-distance overlap. The
 * render-only hover bob is dropped (visual, not sim).
 */
import { SIM } from '../sim.config';
import { HEALTH_PICKUP_HEAL } from '../content/drops';
import { WEAPON_SIM_BY_ID } from '../content/weapons';
import { AFFIX_FIELD_MAP, WEAPON_AFFIX_KINDS, applyAffixes, type Affix } from '../balance/affixes';
import { resolveWeapon } from '../balance/build';
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
          affix: item.affix,
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
      case 'affix':
        if (item.affix) this.applyAffix(p, item.affix);
        break;
      case 'weapon':
        if (item.weaponId) this.applyWeapon(p, item.weaponId);
        break;
    }
  }

  private applyAffix(p: PlayerActor, affix: Affix): void {
    p.affixes.push(affix);
    const def = AFFIX_FIELD_MAP[affix.id];
    if (!def) return; // forward-compat: unknown id recorded but no-op (design/09)
    if (WEAPON_AFFIX_KINDS.has(def.kind)) {
      // Re-resolve every slot from its base with the grown stack, keeping cooldown.
      for (const w of p.weapons) w.spec = applyAffixes(w.base, p.affixes);
    } else if (def.kind === 'flat_maxhp') {
      p.maxHp += affix.value;
      p.hp = Math.min(p.maxHp, p.hp + affix.value);
    }
  }

  private applyWeapon(p: PlayerActor, weaponId: string): void {
    const base = WEAPON_SIM_BY_ID[weaponId];
    if (!base) return; // forward-compat: unknown weapon id → no-op (design/09)
    // Swap the active slot for a fresh runtime carrying the current affix stack.
    const w = resolveWeapon(base, p.affixes);
    p.weapons[p.activeSlot] = w;
    p.weapon = w;
  }
}
