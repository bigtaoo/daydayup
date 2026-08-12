/**
 * Step 8 — Death & drops. Any actor at hp<=0 dies (death event); a dead enemy
 * rolls the dropPrng against the DROP_TABLE (design/05/09) for a coin / health /
 * weapon pickup, tagged with this tick so the next step's Pickup pass can't
 * auto-vacuum it the same frame (design/08 note on ordering). Players don't drop.
 * Dead enemies are compacted out in place.
 *
 * Ports Game.ts onEnemyKilled() — Math.random() → dropPrng (a real determinism
 * fix), float px → fp. Score is not tracked in the engine; render derives it from
 * the death/pickup/wave_clear events (design/08 "events are the only channel").
 */
import { rollDrop, rollArenaDrop } from '../content/drops';
import { buildEnemyActor } from '../content/enemies';
import { DOWNED_BLEEDOUT_TICKS } from '../config';
import { toFp, addFp, mulFp } from '../math/fixed';
import { cosFp, sinFp, BRAD_FULL } from '../math/trig';
import { SIM } from '../sim.config';
import type { GameState } from '../state/GameState';
import type { PickupItem } from '../state/entities';
import { clampToWalkable, retainAlive } from './geom';

export class DeathDropsSystem {
  tick(state: GameState): void {
    for (const e of state.enemies) {
      if (!e.alive || e.hp > 0) continue;
      e.alive = false;
      state.events.push({ type: 'death', id: e.id, faction: 'enemy', gx: e.gx, gy: e.gy });
      // Boss adds (design/09 aspirational `onDeathSpawn`, ENGINE_VERSION 27, funny's
      // own onDeathSpawn design/07 already named as the intended home for this).
      // Ringed evenly around the dying boss's own body radius — PRNG-free, same even-
      // ring convention as `radialDir`'s emission pattern — then clamped into walkable
      // space (a boss can die flush against a wall, same reasoning as v24's pickup
      // clamp). Pushing into state.enemies mid-loop is safe: a freshly spawned minion
      // has hp>0, so this SAME loop's own guard skips it as a no-op on the iteration
      // it's visited (never double-processed, never contributes a second death/drop).
      if (e.onDeathSpawn) {
        for (let i = 0; i < e.onDeathSpawn.count; i++) {
          const ang = Math.round((i * BRAD_FULL) / e.onDeathSpawn.count);
          const rawGx = addFp(e.gx, mulFp(cosFp(ang), e.radius));
          const rawGy = addFp(e.gy, mulFp(sinFp(ang), e.radius));
          const minion = buildEnemyActor(state, rawGx, rawGy, e.onDeathSpawn.type);
          // Clamp by the MINION's own footprint (not the constant SIM.pickupRadius
          // used for pickups above — a spawned actor needs its own solid clearance).
          const pos = clampToWalkable(rawGx, rawGy, minion.footprintRadius, state);
          minion.gx = pos.gx;
          minion.gy = pos.gy;
          // Inherit the dying boss's own roomId DIRECTLY (never left to next tick's
          // EnvironmentSystem inference) — same reasoning as SpawnSystem's
          // dispatchDungeonSpawns (engine/systems/SpawnSystem.ts). Without this,
          // DoorSystem's hasLiveEnemy scan (step 11.5, this SAME tick) skips the
          // minion as roomId===undefined and sees the boss room as cleared for one
          // tick — the door briefly unlocks, then re-locks (and force-regroups the
          // player back) the instant EnvironmentSystem catches up next tick.
          minion.roomId = e.roomId;
          state.enemies.push(minion);
        }
      }
      // Arena mode rolls its own table (design/15, ROADMAP 4.3) — never `material`,
      // zero connection to the PvE account/materials economy. Depth signal for the
      // PvE material tier (design/09 materialTierByDepth, ROADMAP 1.5): state.floorIndex
      // is 0 for every config without floors, so this is identical to the old no-arg
      // call for every existing config.
      const drop = state.zoneEnabled ? rollArenaDrop(state.dropPrng) : rollDrop(state.dropPrng, state.floorIndex);
      // Clamp off the dying enemy's own position — a knockback or a large
      // footprint can leave that position on/behind a wall, which would otherwise
      // drop the pickup somewhere the player can't reach (design/07 pickups).
      const pos = clampToWalkable(e.gx, e.gy, SIM.pickupRadius, state);
      const item: PickupItem = {
        id: state.nextId(),
        kind: drop.kind,
        gx: pos.gx,
        gy: pos.gy,
        spawnTick: state.tick,
        alive: true,
      };
      if (drop.kind === 'weapon') item.weaponId = drop.weaponId;
      if (drop.kind === 'buff') item.buffId = drop.buffId;
      if (drop.kind === 'material') {
        item.materialId = drop.materialId;
        item.qty = drop.qty;
        item.tier = drop.tier;
      }
      state.pickups.push(item);
    }

    // A player at 0 HP goes DOWNED, not dead (design/05/07, ROADMAP 3.2): frozen and
    // revivable by a teammate. Permanent death (alive=false) only happens later, in
    // ReviveSystem, if the bleedout timer expires unrevived. Skip already-downed players
    // (their hp is already 0) so we don't re-trigger the transition every tick.
    for (const p of state.players) {
      if (!p.alive || p.downed || p.hp > 0) continue;
      p.downed = true;
      p.hp = 0; // clamp any overkill to 0
      p.bleedoutTicks = DOWNED_BLEEDOUT_TICKS;
      p.reviveProgressTicks = 0;
      p.vx = toFp(0);
      p.vy = toFp(0); // frozen in place (design/07)
      p.firing = false;
      state.events.push({ type: 'downed', id: p.id, gx: p.gx, gy: p.gy });
    }

    retainAlive(state.enemies);
  }
}
