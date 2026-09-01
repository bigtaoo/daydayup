/**
 * Step 11.5 — Doors (PvE dungeon only, design/05 "Room & door model", 2026-08-04).
 * Runs right after `SpawnSystem` (step 11) and right before `ExtractionSystem`
 * (step 12) — both a real ordering requirement: a room's enemies for THIS tick
 * (including anything `SpawnSystem` just dispatched, with `roomId` set directly,
 * not left to next tick's `EnvironmentSystem` inference) must be counted before
 * this system decides locks, and `ExtractionSystem`'s capstone check must see
 * this tick's fresh `hasLiveEnemy`, not yesterday's.
 *
 * A room is "in combat" purely because it has a live enemy — never an authored
 * flag, and never re-locked once cleared, since nothing ever respawns an enemy
 * into an already-cleared room. Every tick:
 *   1. Recompute every room's `hasLiveEnemy` from a fresh scan of `state.enemies`
 *      grouped by `roomId` (this engine's own stated tolerance: a handful of
 *      actors costs nothing at this scale — no incremental counter is worth the
 *      bookkeeping).
 *   2. On a room's RISING edge (no live enemy → has one): force-regroup every
 *      OTHER online, non-downed player instantly onto its entrance — not a walk,
 *      an immediate placement, and not optional. A downed player is left exactly
 *      where they are (design/05: the teammate stays down, revive resumes once
 *      someone reaches them again) — no bespoke revive-interrupt code is needed
 *      for this: moving the REVIVER away is enough for `ReviveSystem.findReviver`'s
 *      own unmodified per-tick distance re-check to fail and reset the channel.
 *   3. Recompute every door's lock — `locked = hasLiveEnemy[roomA] || hasLiveEnemy[roomB]`
 *      (a door shared by two rooms locks if EITHER side is in combat) — and, only
 *      when any door's lock actually changed, rebuild `state.walls` from the
 *      floor's fully-open `dungeonBaseWalls` plus every currently-locked door's
 *      own passage rect, then `state.rebuildSpatialIndex()` (same "clear-and-
 *      repush in place, then rebuild" convention every other room-geometry
 *      change in this engine already follows).
 *
 * Locking is gated on `activated` (via `hasLiveEnemy`, which can only ever be
 * true for a room whose `WaveScript` has started — and that only happens on
 * activation, `SpawnSystem`) — so a room's doors can never be found already
 * locked the very first tick a player reaches it; only entered, then locked.
 *
 * Strict no-op unless `state.dungeonEnabled` (and until a floor has actually been
 * placed) — this engine's standing "an added step that doesn't bump
 * ENGINE_VERSION for every config that predates it" precedent (GameEngine.ts,
 * ExtractionSystem's own doc comment).
 */
import { toFpGrid } from '../content/convert';
import { toFp } from '../math/fixed';
import type { GameState } from '../state/GameState';
import type { PlayerActor } from '../state/entities';
import type { PlacedRoom } from '../world/dungeon';
import { circleOverlapsAabb, clampToWalkable } from './geom';
import { blockingRadius, dropClearance } from '../state/actorRadius';

export class DoorSystem {
  tick(state: GameState): void {
    if (!state.dungeonEnabled || state.dungeonRooms.length === 0) return;

    const hasLiveEnemy = new Array<boolean>(state.dungeonRooms.length).fill(false);
    for (const e of state.enemies) {
      if (!e.alive || e.roomId === undefined) continue;
      const idx = state.dungeonRoomIndexById.get(e.roomId);
      if (idx !== undefined) hasLiveEnemy[idx] = true;
    }

    for (let i = 0; i < state.dungeonRooms.length; i++) {
      const room = state.dungeonRooms[i]!;
      const rt = state.dungeonRoomRuntime[i]!;
      const was = rt.hasLiveEnemy;
      const now = hasLiveEnemy[i]!;
      rt.hasLiveEnemy = now;
      if (!was && now) {
        this.forceRegroup(state, room);
        state.events.push({ type: 'door_locked', roomId: room.id });
      } else if (was && !now) {
        state.events.push({ type: 'door_unlocked', roomId: room.id });
      }
    }

    let anyLockChanged = false;
    for (const dr of state.dungeonDoors) {
      const aIdx = state.dungeonRoomIndexById.get(dr.door.roomA);
      const bIdx = state.dungeonRoomIndexById.get(dr.door.roomB);
      const locked = (aIdx !== undefined && hasLiveEnemy[aIdx]!) || (bIdx !== undefined && hasLiveEnemy[bIdx]!);
      if (locked === dr.locked) continue;
      dr.locked = locked;
      anyLockChanged = true;
    }
    if (anyLockChanged) this.rebuildWalls(state);
  }

  /** Instantly move every OTHER online, non-downed player onto `room`'s entrance —
   * not a walk, a direct position/velocity/roomId set. The room's own trigger
   * (whoever's already inside — player or freshly-spawned enemy) is excluded via
   * the `roomId` check, not re-teleported onto themselves — unless they are
   * standing in a doorway (`inLockingDoorway`), in which case they are pulled in
   * with everyone else. */
  private forceRegroup(state: GameState, room: PlacedRoom): void {
    const regrouped: number[] = [];
    const entranceX = toFpGrid(room.entranceGrid.x);
    const entranceY = toFpGrid(room.entranceGrid.y);
    for (const p of state.players) {
      if (!p.alive || p.downed) continue;
      if (p.roomId === room.id && !this.inLockingDoorway(state, room.id, p)) continue;
      p.gx = entranceX;
      p.gy = entranceY;
      p.vx = toFp(0);
      p.vy = toFp(0);
      p.knockVx = toFp(0);
      p.knockVy = toFp(0);
      p.roomId = room.id;
      regrouped.push(p.id);
    }
    if (regrouped.length > 0) {
      state.events.push({ type: 'force_regroup', roomId: room.id, playerIds: regrouped });
    }
  }

  /**
   * Is this player physically standing in one of `roomId`'s door passages — the
   * rects this tick's lock is about to turn back into walls (ENGINE_VERSION 41)?
   *
   * A softlock bug, found by `client/sim/pveLevelSim.sim.ts` on the shipped level 1
   * and reproducible for a human just as easily: a player whose body is still in the
   * doorway when their own step across the threshold activates the room passed the
   * `p.roomId === room.id` test above (their centre had just entered the room rect,
   * so `EnvironmentSystem` had already re-tagged them), was therefore NOT regrouped,
   * and then got shoved out of the restored wall by `MovementSystem`'s push-out —
   * which resolves to whichever side is nearer, i.e. quite often back the way they
   * came. That leaves a room permanently in combat behind a permanently locked door,
   * with the player outside it: the floor can never be cleared, the capstone never
   * reached, and the run can only end by dying. Pulling such a player onto the
   * room's entrance instead is the same treatment every other player already gets,
   * and it is what "the door locks you IN the fight" (design/05) was always meant to
   * mean.
   *
   * Uses `blockingRadius` — the radius by which `MovementSystem` would actually displace them,
   * which is the only radius that makes this predicate agree with the push-out described above.
   *
   * Through v48 this read `p.footprintRadius`, on the strength of a comment calling that "the
   * feet circle solids actually push out". That stopped being true in ENGINE_VERSION 43
   * (players) and 48 (enemies) — `resolveWalls` pushes `solidRadius`, more than twice as wide
   * for a player (16 px vs 7) — and nothing re-checked the comment when the rule moved. The
   * predicate therefore UNDER-reported: a player whose body was in the restored passage but
   * whose feet circle was clear was judged "not in the doorway", was not regrouped, and was then
   * shoved out by exactly the push-out this doc-comment exists to describe — reopening the
   * permanent-lock softlock from a narrower angle. Fixed in v49 (design/18 G4).
   */
  private inLockingDoorway(state: GameState, roomId: string, p: PlayerActor): boolean {
    for (const dr of state.dungeonDoors) {
      if (dr.door.roomA !== roomId && dr.door.roomB !== roomId) continue;
      if (circleOverlapsAabb(p.gx, p.gy, blockingRadius(p), dr.passageAabb)) return true;
    }
    return false;
  }

  /** Rebuild `state.walls` from the floor's fully-open base plus every currently-
   * locked door's own passage rect — content-swap in place (never reassign the
   * reference), then `rebuildSpatialIndex()`. Only called the (rare) tick some
   * door's lock actually changed. */
  private rebuildWalls(state: GameState): void {
    state.walls.length = 0;
    state.walls.push(...state.dungeonBaseWalls);
    for (const dr of state.dungeonDoors) {
      if (dr.locked) state.walls.push(dr.passageAabb);
    }
    state.rebuildSpatialIndex();
    this.reclampPickups(state);
  }

  /**
   * Re-seat any pickup the rebuild just moved a wall on top of (ENGINE_VERSION 51).
   *
   * `dropClearance()` (v50) makes every drop SITE legal at the moment it is created, which
   * is the whole of what the v50 sweep measured and the whole of what `smoke.test.ts`
   * asserts per tick. This is the case neither covers: a resting place that was legal when
   * the item landed and stopped being legal afterwards, because the wall set changed under
   * it. `rebuildWalls` is the only thing in the engine that does that mid-run, and a door
   * passage is exactly where a drop comes from — a mob dies on the threshold
   * (`DeathDropsSystem`), or a player swaps a weapon standing in it
   * (`PickupSystem.applyWeapon`), and then the room activates and the door closes over it.
   *
   * The item was then inside stone with no mitigation anywhere: nothing re-clamps a pickup
   * after its drop tick, and `PickupSystem` collects on a radius test that does not care
   * about walls — so whether it was still reachable came down to whether the player's body
   * could get within `pickupRadius + p.radius` of a point buried in a passage rect. That is
   * the shape of the report v50 closed as unexplained (*"依然有掉落的物品无法拾取"*,
   * 2026-08-31); the 903-drop sweep behind v50 could not have seen it, because it sampled
   * drop sites and this bug happens strictly after the drop.
   *
   * Unconditional over every alive pickup rather than "only the ones in a passage": the
   * predicate for "is this one affected" is a solid query, which is what `clampToWalkable`
   * already does, and it is exactly a no-op for a point that is clear — so testing first
   * would only duplicate the answer. Idempotent, so the rare repeated rebuild cannot walk
   * an item across the floor, and it runs only on a lock change.
   */
  private reclampPickups(state: GameState): void {
    for (const item of state.pickups) {
      if (!item.alive) continue;
      const at = clampToWalkable(item.gx, item.gy, dropClearance(), state);
      item.gx = at.gx;
      item.gy = at.gy;
    }
  }
}
