/**
 * Step 8 — Death & drops. Any actor at hp<=0 dies (death event); a dead enemy
 * rolls the dropPrng for a health-or-coin pickup, tagged with this tick so the
 * next step's Pickup pass can't auto-vacuum it the same frame (design/08 note on
 * ordering). Players don't drop. Dead enemies are compacted out in place.
 *
 * Ports Game.ts onEnemyKilled() — Math.random() → dropPrng (a real determinism
 * fix), float px → fp. Score is not tracked in the engine; render derives it from
 * the death/pickup/wave_clear events (design/08 "events are the only channel").
 */
import { SIM } from '../sim.config';
import type { GameState } from '../state/GameState';
import { retainAlive } from './geom';

export class DeathDropsSystem {
  tick(state: GameState): void {
    for (const e of state.enemies) {
      if (!e.alive || e.hp > 0) continue;
      e.alive = false;
      state.events.push({ type: 'death', id: e.id, faction: 'enemy', gx: e.gx, gy: e.gy });
      const kind = state.dropPrng.nextInt(1000) < SIM.drop.healPerMille ? 'health' : 'coin';
      state.pickups.push({
        id: state.nextId(),
        kind,
        gx: e.gx,
        gy: e.gy,
        spawnTick: state.tick,
        alive: true,
      });
    }

    for (const p of state.players) {
      if (!p.alive || p.hp > 0) continue;
      p.alive = false;
      state.events.push({ type: 'death', id: p.id, faction: 'player', gx: p.gx, gy: p.gy });
    }

    retainAlive(state.enemies);
  }
}
