/**
 * Per-floor weapon allowance — the payout half (design/05, ENGINE_VERSION 57).
 *
 * Split out of `DeathDropsSystem` because the allowance has TWO trigger sites and one
 * payment. A floor owes 2-3 weapons (`GameState.floorWeaponQuota`); if its kills did
 * not produce that many, the remainder is handed over when the floor is finished. Where
 * "finished" lands depends on what the floor's capstone room actually is:
 *
 *   - **A boss room** — paid on the boss's body the tick its garrison drops
 *     (`DeathDropsSystem`, step 9). The owner's call, 2026-09-05: the player is already
 *     standing there and already looking, and loot that appears where the fight ended
 *     reads as loot rather than as a vending machine.
 *   - **An extraction room** — paid at the room's own centre when the checkpoint opens
 *     (`ExtractionSystem`, step 12), because there is no body to put it on. This is not
 *     an edge case: of the five hand-authored floors in the shipped level, FOUR end in
 *     `ember_l1_extraction`, which has zero enemy spawns. Without this path the
 *     guarantee silently applied to one floor in five — which is exactly what the first
 *     measured sweep showed (completed floors reading 1-3 weapons against a 2-3 quota).
 *
 * Both go through this one function so there is a single definition of what the floor
 * owes and a single place that spends `dropPrng` on it.
 */
import { WEAPON_DROP_POOL } from '../content/drops';
import type { Fp } from '../math/fixed';
import type { GameState } from '../state/GameState';
import { dropClearance } from '../state/actorRadius';
import { clampToWalkable } from './geom';

/**
 * Hand over whatever weapons this floor still owes, at `(gx, gy)`. Idempotent by
 * construction: it pays the gap and closes it, so a caller that runs every tick (the
 * checkpoint one does) pays exactly once.
 *
 * A no-op for any config without a dungeon — `floorWeaponQuota` is -1 there, the
 * marker for "this config has no floor to allocate against" as distinct from 0's
 * "this floor's allowance is spent".
 */
export function payFloorWeaponShortfall(state: GameState, gx: Fp, gy: Fp): void {
  if (!state.dungeonEnabled || state.floorWeaponQuota < 0) return;
  const shortfall = state.floorWeaponQuota - state.floorWeaponsDropped;
  if (shortfall <= 0) return;

  // Clamped by the PLAYER's clearance, not the pickup's: the thing that has to reach
  // this spot is a player's body, same reasoning as `DeathDropsSystem`'s own drop
  // clamp (see `state/actorRadius.ts`). A boss can die flush against a wall, and a
  // room's geometric centre can sit inside a pillar.
  const pos = clampToWalkable(gx, gy, dropClearance(), state);
  for (let i = 0; i < shortfall; i++) {
    state.pickups.push({
      id: state.nextId(),
      kind: 'weapon',
      weaponId: WEAPON_DROP_POOL[state.dropPrng.nextInt(WEAPON_DROP_POOL.length)]!,
      gx: pos.gx,
      gy: pos.gy,
      spawnTick: state.tick,
      alive: true,
    });
  }
  state.floorWeaponsDropped += shortfall;
}

/**
 * The centre of this floor's capstone (boss / extraction) room — where the checkpoint
 * pays a shortfall when no boss died to pay it on. `undefined` before a floor has been
 * placed. The capstone is always the LAST placed room (`generateFloor` /
 * `placeAuthoredFloor` both append it last), the same assumption `ExtractionSystem`'s
 * own `capstoneCleared` scan already makes.
 */
export function capstoneCentre(state: GameState): { gx: Fp; gy: Fp } | undefined {
  const entry = state.dungeonRoomRects[state.dungeonRoomRects.length - 1];
  if (entry === undefined) return undefined;
  const { x, y, w, h } = entry.rect;
  // Integer halves: every Fp in the sim is a whole number, and a fractional one here
  // would put a non-integer into hashed state (design/06).
  return { gx: (x + Math.floor(w / 2)) as Fp, gy: (y + Math.floor(h / 2)) as Fp };
}
