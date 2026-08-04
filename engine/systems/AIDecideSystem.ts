/**
 * Step 2 — AI decide (PvE only). Each enemy sets its own intent from state +
 * aiPrng: face the (first alive) player and request fire; the weapon cooldown
 * gates the actual shot in WeaponFire. Enemies are stationary in the slice, so no
 * move intent is produced.
 *
 * Ports client/src/game/Enemy.ts tick() (atan2 facing + fire request), radians →
 * brad. The demo's `gx % 1` fire-phase jitter is replaced by an aiPrng-seeded
 * initial cooldown set in SpawnSystem — a real determinism fix.
 *
 * Room activation gate (design/05 "Room & door model", 2026-08-04): in dungeon
 * mode, an enemy whose room hasn't activated yet (no player has ever reached it)
 * runs NO decision logic at all — `firing` is simply left at whatever it already
 * was (false for a freshly-spawned enemy, since `SpawnSystem` never sets it),
 * i.e. inert. This is the one and only place "AI behavior" is gated — this
 * engine has no enemy movement logic to gate alongside it (see module doc above).
 */
import { atan2Brad } from '../math/trig';
import type { GameState } from '../state/GameState';

export class AIDecideSystem {
  tick(state: GameState): void {
    // Enemies ignore downed players (design/07, 3.2) — no camping a body that can't fight back.
    const target = state.players.find((p) => p.alive && !p.downed) ?? null;
    for (const e of state.enemies) {
      if (!e.alive) continue;
      if (state.dungeonEnabled && !this.isActivated(state, e.roomId)) continue;
      if (!target) {
        e.firing = false;
        continue;
      }
      e.facing = atan2Brad(target.gy - e.gy, target.gx - e.gx);
      e.firing = true;
    }
  }

  private isActivated(state: GameState, roomId: string | undefined): boolean {
    if (roomId === undefined) return false;
    const idx = state.dungeonRoomIndexById.get(roomId);
    if (idx === undefined) return false;
    return state.dungeonRoomRuntime[idx]?.activated ?? false;
  }
}
