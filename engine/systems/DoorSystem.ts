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
import { circleOverlapsAabb } from './geom';

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
   * Uses `footprintRadius` (the feet circle solids actually push out, design/07),
   * not `radius` — the test has to match the thing that would displace them.
   */
  private inLockingDoorway(state: GameState, roomId: string, p: PlayerActor): boolean {
    for (const dr of state.dungeonDoors) {
      if (dr.door.roomA !== roomId && dr.door.roomB !== roomId) continue;
      if (circleOverlapsAabb(p.gx, p.gy, p.footprintRadius, dr.passageAabb)) return true;
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
  }
}
