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
 * Room fire budget (ENGINE_VERSION 41, design/05 "Room encounter budget"): the
 * v40 fix above turned out to buy only about half a second. `client/sim/
 * pveLevelSim.sim.ts` — a bot-driven level simulator written specifically to put
 * a number on the same recurring report — measured 14 of a 15-enemy room's mobs
 * firing on the same tick, a first hit 0.6s after activation, and death in ~2s
 * in 100% of runs at both bot skill profiles: enemies simply CLOSED to engage
 * range as one blob and opened up together, which the range gate does nothing
 * about. Two additions, both per-ROOM rather than per-mob, since the room is
 * already this game's aggro unit (design/05):
 *   - `grantFireSlots` — at most `ROOM_FIRE_BUDGET` (balance/encounter.ts) mobs
 *     per room may have `firing` set on a tick, awarded to the NEAREST
 *     contenders. The rest hold position in range with `firing` false, taking a
 *     slot as soon as a shooter dies or the player moves and reorders the queue.
 *   - `hasNoticed` — a freshly-activated room's mobs may move immediately but
 *     hold fire for a per-enemy staggered delay (`noticeDelayTicks`, derived
 *     from the enemy id, no PRNG draw), so entering a room is never an instant
 *     volley from whichever mobs were authored nearest the door.
 * `chaseAndEngage` no longer sets `firing` at all — it reports "in range" and
 * `grantFireSlots` is the single writer of `firing = true`.
 *
 * Perception radius (ENGINE_VERSION 42, live play report 2026-08-17 — "怪物的感知
 * 范围弄小一些"): room activation is the OUTER aggro gate and stays exactly as it was,
 * but a woken room's mobs now only react once the player is within their own
 * `aggroRangeFp` (`hasAggro`). Before this, activating a room set its entire garrison
 * — up to 14 mobs on level 1 — walking at the player from wherever they were authored,
 * so a room read as one converging blob rather than as a space with pockets of threat
 * in it. An un-noticed mob is fully inert: it does not move, fire, OR turn to face the
 * player. The flag is a one-way latch, so this is a wake-up trigger and never a leash.
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
import {
  DEFAULT_ENEMY_MOVE_SPEED_PER_TICK,
  DEFAULT_ENEMY_ENGAGE_RANGE_FP,
  DEFAULT_ENEMY_AGGRO_RANGE_FP,
} from '../content/enemies';
import { ROOM_FIRE_BUDGET, noticeDelayTicks } from '../balance/encounter';
import type { GameState } from '../state/GameState';
import type { EnemyActor } from '../state/entities';

/** A mob that is in range, has noticed the player, and is therefore competing for
 *  one of its room's fire slots. `distSq` is what the slots are awarded by. */
interface FireContender {
  e: EnemyActor;
  distSq: number;
}

/** Bucket key for a mob with no `roomId` (a flat `waves`/tutorial config, or the
 *  one tick before EnvironmentSystem assigns one) — such mobs share a single
 *  budget, since "the room" is the whole arena for them. */
const NO_ROOM = '#unroomed';

export class AIDecideSystem {
  tick(state: GameState): void {
    // Enemies ignore downed players (design/07, 3.2) — no camping a body that can't fight back.
    const target = state.players.find((p) => p.alive && !p.downed) ?? null;
    // Insertion-ordered (spawn order) — see grantFireSlots' determinism note.
    const contenders = new Map<string, FireContender[]>();

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
      if (!this.hasAggro(e, dx, dy)) {
        // Hasn't noticed the player yet: fully inert, and deliberately NOT turned to
        // face them either — a mob that tracks you with its gun barrel from across the
        // room while standing still reads as "aware but passive", which is the opposite
        // of what the perception radius is for.
        e.firing = false;
        e.vx = 0 as Fp;
        e.vy = 0 as Fp;
        continue;
      }
      e.facing = atan2Brad(dy, dx);
      const distSq = this.chaseAndEngage(e, dx, dy);
      // In range (chaseAndEngage stopped it and left `firing` false) and past its
      // notice delay → it wants to shoot, pending a slot.
      if (distSq !== null && this.hasNoticed(state, e)) {
        const key = e.roomId ?? NO_ROOM;
        const list = contenders.get(key);
        if (list) list.push({ e, distSq });
        else contenders.set(key, [{ e, distSq }]);
      }
    }

    this.grantFireSlots(contenders);
  }

  /**
   * Has this mob noticed the player (ENGINE_VERSION 42)? The INNER aggro gate, inside
   * design/05's room-as-the-aggro-unit outer one: a woken room's far side stays idle
   * until the player is within `aggroRangeFp`, instead of the entire garrison marching
   * across the room the tick the door opens (live play report, 2026-08-17).
   *
   * One-way latch (`e.aggroed`): a mob at the exact boundary would otherwise flip
   * between chasing and idling every tick, since chasing carries it back inside the
   * radius and idling leaves it outside. Latched means the radius is a wake-up trigger,
   * not a leash — nothing here ever puts a mob back to sleep.
   */
  private hasAggro(e: EnemyActor, dx: number, dy: number): boolean {
    if (e.aggroed) return true;
    const range = e.aggroRangeFp ?? DEFAULT_ENEMY_AGGRO_RANGE_FP;
    if (dx * dx + dy * dy > range * range) return false;
    e.aggroed = true;
    return true;
  }

  /**
   * Close the distance to the target until within the mob's engage range, then stop
   * (v37 first pass for the movement half — no hysteresis/kiting/steering yet, see
   * the module's matching content/enemies.ts default constants for the tuning
   * rationale; v40 added the firing gate, v41 the room budget — see the module doc
   * comment). A straight-line pursuit, same as everything else here: MovementSystem's
   * push-out keeps a chasing mob from clipping through a wall or another actor, it
   * just doesn't route AROUND one — a mob can stall against a concave wall.
   *
   * Returns the squared distance to the target when the mob is in range and holding
   * still (i.e. eligible to fire, if it gets a slot), else null. `firing` is left
   * false here in every case; only `grantFireSlots` ever sets it true.
   */
  private chaseAndEngage(e: EnemyActor, dx: number, dy: number): number | null {
    const range = e.engageRangeFp ?? DEFAULT_ENEMY_ENGAGE_RANGE_FP;
    const distSq = dx * dx + dy * dy;
    e.firing = false;
    if (distSq <= range * range) {
      e.vx = 0 as Fp;
      e.vy = 0 as Fp;
      return distSq;
    }
    const dist = isqrt(distSq); // still out of engage range — close the distance
    if (dist === 0) {
      e.vx = 0 as Fp;
      e.vy = 0 as Fp;
      return null;
    }
    const speed = e.moveSpeedPerTick ?? DEFAULT_ENEMY_MOVE_SPEED_PER_TICK;
    e.vx = Math.trunc((dx * speed) / dist) as Fp;
    e.vy = Math.trunc((dy * speed) / dist) as Fp;
    return null;
  }

  /**
   * Hand each room's `ROOM_FIRE_BUDGET` fire slots to its NEAREST contenders
   * (balance/encounter.ts — the anti-alpha-strike rule). Everyone else stays in
   * range with `firing` false: present, closing off nothing, waiting for a slot to
   * free up when a shooter dies or the player moves and reorders the queue.
   *
   * Determinism (design/06): the bucket Map is keyed by roomId in first-seen =
   * spawn order, and `Array.prototype.sort` is specified stable, so equal-distance
   * mobs keep `state.enemies` order — the same array-order tie-break convention the
   * rest of the engine uses. Distances are exact integer products of Fp, never
   * floats.
   */
  private grantFireSlots(contenders: Map<string, FireContender[]>): void {
    for (const list of contenders.values()) {
      if (list.length > ROOM_FIRE_BUDGET) list.sort((a, b) => a.distSq - b.distSq);
      const slots = Math.min(ROOM_FIRE_BUDGET, list.length);
      for (let i = 0; i < slots; i++) list[i]!.e.firing = true;
    }
  }

  /**
   * Has this mob finished noticing the player? A freshly-activated room's garrison
   * moves at once but holds fire for a per-enemy stagger (balance/encounter.ts), so
   * the player gets a reaction window on entry instead of an instant volley from
   * whichever mobs happened to be authored close to the door.
   *
   * Dungeon mode only: `roomTick` (ticks since activation) is the clock this measures
   * against, and a flat `waves`/tutorial config has no room runtime at all. Those
   * configs keep v40 behaviour for the delay (they still get the fire budget) —
   * their enemies stream in mid-fight rather than sitting pre-placed in a room the
   * player walks into, so there is no "walked into an ambush" moment to soften.
   */
  private hasNoticed(state: GameState, e: EnemyActor): boolean {
    if (!state.dungeonEnabled || e.roomId === undefined) return true;
    const idx = state.dungeonRoomIndexById.get(e.roomId);
    const rt = idx === undefined ? undefined : state.dungeonRoomRuntime[idx];
    return rt === undefined || rt.roomTick >= noticeDelayTicks(e.id);
  }

  private isActivated(state: GameState, roomId: string | undefined): boolean {
    if (roomId === undefined) return false;
    const idx = state.dungeonRoomIndexById.get(roomId);
    if (idx === undefined) return false;
    return state.dungeonRoomRuntime[idx]?.activated ?? false;
  }
}
