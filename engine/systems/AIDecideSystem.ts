/**
 * Step 2 — AI decide (PvE only). Each enemy sets its own intent from state +
 * aiPrng: face the (first alive) player and request fire; the weapon cooldown
 * gates the actual shot in WeaponFire. Enemies are stationary in the slice, so no
 * move intent is produced.
 *
 * Ports client/src/game/Enemy.ts tick() (atan2 facing + fire request), radians →
 * brad. The demo's `gx % 1` fire-phase jitter is replaced by an aiPrng-seeded
 * initial cooldown set in SpawnSystem — a real determinism fix.
 */
import { atan2Brad } from '../math/trig';
import type { GameState } from '../state/GameState';

export class AIDecideSystem {
  tick(state: GameState): void {
    // Enemies ignore downed players (design/07, 3.2) — no camping a body that can't fight back.
    const target = state.players.find((p) => p.alive && !p.downed) ?? null;
    for (const e of state.enemies) {
      if (!e.alive) continue;
      if (!target) {
        e.firing = false;
        continue;
      }
      e.facing = atan2Brad(target.gy - e.gy, target.gx - e.gx);
      e.firing = true;
    }
  }
}
