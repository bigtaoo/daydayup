/**
 * Step 2 — AI decide (PvE only). Each enemy sets its own intent from state +
 * aiPrng: face the (first alive) player, close the distance toward it until
 * within gun range, then fire once actually in range; the weapon cooldown gates
 * the actual shot in WeaponFire. Enemies used to be fully stationary in the
 * slice (turn + shoot only, see ENGINE_VERSION_HISTORY.md v37) — reported as
 * "the AI doesn't move".
 *
 * Ports client/src/game/Enemy.ts tick() (atan2 facing + fire request), radians →
 * brad. The demo's `gx % 1` fire-phase jitter is replaced by an aiPrng-seeded
 * initial cooldown set in SpawnSystem — a real determinism fix.
 *
 * Fire-range gate (ENGINE_VERSION 40, design/05): a live player report — "the
 * instant I walk into a room, dozens of enemies gun me down before I can react"
 * — traced to `firing` being set unconditionally true the moment a room
 * activates, regardless of how far the enemy actually was from the player;
 * `engageRangeFp` only ever gated `chase()`'s stop-moving decision (v37), never
 * whether the mob was allowed to shoot. With level 1's hand-authored rooms
 * holding 15-30 enemies each (v38) and `ENEMY_GUN_SIM`'s bullet travel (~30
 * grid) comfortably covering a room's full diagonal, that meant every enemy in
 * an activated room opened fire on tick 1 no matter where it spawned — a
 * whole-room alpha strike with zero reaction time, the opposite of how a room
 * full of enemies plays in Soul Knight/Enter the Gungeon: enemies notice you
 * across the whole room (the room stays the aggro unit, unchanged), but only
 * the ones already close enough actually shoot; the rest have to visibly close
 * distance first, which is exactly the reaction window the report was missing.
 * Fixed: `firing` is now true only once the enemy is within its own
 * `engageRangeFp` (the same distance `chase()` already used to decide when to
 * stop closing) — "stop and shoot" is now literal instead of "shoot from
 * anywhere and also stop once close".
 *
 * Room activation gate (design/05 "Room & door model", 2026-08-04): in dungeon
 * mode, an enemy whose room hasn't activated yet (no player has ever reached it)
 * runs NO decision logic at all — `firing`/`vx`/`vy` are simply left at whatever
 * they already were (false/0 for a freshly-spawned enemy, since `SpawnSystem`
 * never sets them), i.e. inert. This is the one and only place "AI behavior" is
 * gated, movement included.
 */
import { isqrt } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { atan2Brad } from '../math/trig';
import { DEFAULT_ENEMY_MOVE_SPEED_PER_TICK, DEFAULT_ENEMY_ENGAGE_RANGE_FP } from '../content/enemies';
import type { GameState } from '../state/GameState';
import type { EnemyActor } from '../state/entities';

export class AIDecideSystem {
  tick(state: GameState): void {
    // Enemies ignore downed players (design/07, 3.2) — no camping a body that can't fight back.
    const target = state.players.find((p) => p.alive && !p.downed) ?? null;
    for (const e of state.enemies) {
      if (!e.alive) continue;
      if (state.dungeonEnabled && !this.isActivated(state, e.roomId)) continue;
      if (!target) {
        e.firing = false;
        e.vx = 0 as Fp;
        e.vy = 0 as Fp;
        continue;
      }
      const dx = target.gx - e.gx;
      const dy = target.gy - e.gy;
      e.facing = atan2Brad(dy, dx);
      this.chaseAndEngage(e, dx, dy);
    }
  }

  /**
   * Close the distance to the target until within the mob's engage range, then
   * stop AND fire (v37 first pass for the movement half — no hysteresis/kiting/
   * steering yet, see the module's matching content/enemies.ts default constants
   * for the tuning rationale; v40 added the firing gate, see the module doc
   * comment's "Fire-range gate" section). A straight-line pursuit, same as
   * everything else here: MovementSystem's push-out keeps a chasing mob from
   * clipping through a wall or another actor, it just doesn't route AROUND one —
   * a mob can stall against a concave wall.
   */
  private chaseAndEngage(e: EnemyActor, dx: number, dy: number): void {
    const range = e.engageRangeFp ?? DEFAULT_ENEMY_ENGAGE_RANGE_FP;
    const distSq = dx * dx + dy * dy;
    if (distSq <= range * range) {
      e.firing = true;
      e.vx = 0 as Fp;
      e.vy = 0 as Fp;
      return;
    }
    e.firing = false; // still out of engage range — close the distance, don't shoot yet
    const dist = isqrt(distSq);
    if (dist === 0) {
      e.vx = 0 as Fp;
      e.vy = 0 as Fp;
      return;
    }
    const speed = e.moveSpeedPerTick ?? DEFAULT_ENEMY_MOVE_SPEED_PER_TICK;
    e.vx = Math.trunc((dx * speed) / dist) as Fp;
    e.vy = Math.trunc((dy * speed) / dist) as Fp;
  }

  private isActivated(state: GameState, roomId: string | undefined): boolean {
    if (roomId === undefined) return false;
    const idx = state.dungeonRoomIndexById.get(roomId);
    if (idx === undefined) return false;
    return state.dungeonRoomRuntime[idx]?.activated ?? false;
  }
}
