/**
 * Step 9 — Pickup. A player overlapping a collectable pickup applies it and the
 * pickup is consumed. Pickups dropped THIS tick are skipped (spawnTick guard) so a
 * kill in step 8 isn't vacuumed the same frame (design/08 ordering note). Collected
 * pickups are compacted out in place.
 *
 * Effects (design/05 the in-run power ramp):
 *   heal     — restore up to maxHp. Auto, on overlap.
 *   material — added to this floor's un-banked buffer (state.floorMaterials,
 *              design/05, ROADMAP 1.4/1.5); banked at an extraction checkpoint
 *              (ExtractionSystem), forfeited on a run-ending death. Auto, on overlap.
 *   weapon   — design/03:121-126 "NOT auto-picked-up... button-driven": overlap alone
 *              does nothing; a freshly-pressed INTERACT (rising edge, mirrors
 *              ApplyInputSystem's own SWAP_WEAPON edge check) swaps it into the
 *              active slot AND drops the outgoing weapon back onto the floor as a
 *              new pickup at the player's position (`dropReplacedWeapon`) — "no
 *              manual drop button," the drop is only ever a side effect of a swap.
 *   buff     — added to the run-scoped stack. Auto, on overlap.
 *
 * The rising edge can't reuse `prevButtons` (`ApplyInputSystem`, step 1, already
 * overwrote it with THIS tick's bitfield before this step runs) — `wasInteracting`
 * is this system's own cross-tick memory instead, updated once per player per tick
 * regardless of whether a pickup was nearby.
 *
 * Ports Game.ts updatePickups(): float px → fp, squared-distance overlap. The
 * render-only hover bob is dropped (visual, not sim).
 */
import { SIM } from '../sim.config';
import { HEAL_PICKUP_AMOUNT, rollArenaDrop } from '../content/drops';
import { bankKey } from '../content/materials';
import { WEAPON_SIM_BY_ID, makeWeapon } from '../content/weapons';
import { PVP_SCALE_FACTOR, scaleWeaponDamage } from '../balance/build';
import { RUN_BUFFS, sumBuffs } from '../balance/runbuffs';
import { toFp } from '../math/fixed';
import type { GameState } from '../state/GameState';
import type { PickupItem, PlayerActor } from '../state/entities';
import { circlesOverlap, clampToWalkable, retainAlive } from './geom';

export class PickupSystem {
  tick(state: GameState): void {
    // Reveal pass FIRST, same tick, so a crate a player is already standing inside
    // (e.g. right as its room activates) can resolve AND be collected below without
    // waiting an extra tick.
    this.resolveCrates(state);

    // Snapshot each player's INTERACT rising edge ONCE up front, before any swap in
    // this same tick can push a fresh pickup back onto `state.pickups` — that new
    // item must never itself read as "just pressed" (it wasn't the input, the swap
    // was), and every player's `wasInteracting` memory must advance exactly once per
    // tick even if they're nowhere near a pickup.
    const interactPressed = state.players.map((p) => p.alive && p.interacting && !p.wasInteracting);

    for (const item of state.pickups) {
      if (!item.alive || item.spawnTick === state.tick) continue;
      // Never directly collectible — resolveCrates above always turns a crate into a
      // real kind before a player gets this close (lootRevealRadius > pickupRadius),
      // but guard explicitly rather than relying on that margin implicitly.
      if (item.kind === 'crate') continue;
      for (let i = 0; i < state.players.length; i++) {
        const p = state.players[i]!;
        if (!p.alive) continue;
        if (!circlesOverlap(item.gx, item.gy, SIM.pickupRadius, p.gx, p.gy, p.radius)) continue;
        if (item.kind === 'weapon' && !interactPressed[i]) continue; // button-driven, not auto (design/03)
        this.apply(state, p, item);
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
          tier: item.tier,
        });
        break;
      }
    }
    retainAlive(state.pickups);

    for (const p of state.players) p.wasInteracting = p.interacting;
  }

  /**
   * Roll an unresolved arena 'crate' (design/15) into a real weapon/buff/heal pickup
   * the first tick any player comes within `SIM.lootRevealRadius` — deferred from
   * spawn time (SpawnSystem.spawnArenaLoot) specifically so the value doesn't sit in
   * shared GameState, readable by a map-wide state/camera cheat, before a legitimate
   * player could plausibly have seen it. Iterates pickups then players in their
   * existing array order so the dropPrng draw sequence stays deterministic across
   * clients regardless of which player's loop iteration happens to trigger it.
   */
  private resolveCrates(state: GameState): void {
    for (const item of state.pickups) {
      if (!item.alive || item.kind !== 'crate') continue;
      for (const p of state.players) {
        if (!p.alive) continue;
        if (!circlesOverlap(item.gx, item.gy, SIM.lootRevealRadius, p.gx, p.gy, toFp(0))) continue;
        const drop = rollArenaDrop(state.dropPrng);
        item.kind = drop.kind;
        if (drop.kind === 'weapon') item.weaponId = drop.weaponId;
        if (drop.kind === 'buff') item.buffId = drop.buffId;
        break;
      }
    }
  }

  private apply(state: GameState, p: PlayerActor, item: PickupItem): void {
    switch (item.kind) {
      case 'heal':
        p.hp = Math.min(p.maxHp, p.hp + HEAL_PICKUP_AMOUNT);
        break;
      case 'material':
        if (item.materialId) {
          // Key by (material, rolled tier) so a recipe's minTier can gate it later
          // (design/14). Tier 0 keeps the flat key — byte-identical to pre-tier drops.
          const key = bankKey(item.materialId, item.tier ?? 0);
          state.floorMaterials[key] = (state.floorMaterials[key] ?? 0) + (item.qty ?? 0);
        }
        break;
      case 'weapon':
        if (item.weaponId) this.applyWeapon(state, p, item.weaponId);
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

  private applyWeapon(state: GameState, p: PlayerActor, weaponId: string): void {
    const base = WEAPON_SIM_BY_ID[weaponId];
    if (!base) return; // forward-compat: unknown weapon id → no-op (design/09)
    // PvP arena floor pickups are "the real power curve" (design/15) and must scale
    // exactly like the landing kit (balance/build.ts buildArenaSpecs) — re-deriving
    // from the canonical unscaled spec every equip (never compounding) so drop→re-pickup
    // cycles stay byte-identical regardless of how many hands a weapon passes through.
    const spec = state.zoneEnabled ? scaleWeaponDamage(base, PVP_SCALE_FACTOR) : base;
    // The outgoing weapon drops back to the floor (design/03:126) BEFORE the slot is
    // overwritten — a fresh PickupItem at the player's own position, same spawn-tick
    // convention as DeathDropsSystem so the just-created item isn't immediately
    // re-collected this same tick.
    const outgoing = p.weapons[p.activeSlot];
    if (outgoing) {
      const pos = clampToWalkable(p.gx, p.gy, SIM.pickupRadius, state);
      state.pickups.push({
        id: state.nextId(),
        kind: 'weapon',
        gx: pos.gx,
        gy: pos.gy,
        spawnTick: state.tick,
        alive: true,
        weaponId: outgoing.spec.name,
      });
    }
    // Swap the active slot for a fresh runtime of the picked-up weapon.
    const w = makeWeapon(spec);
    p.weapons[p.activeSlot] = w;
    p.weapon = w;
  }
}
