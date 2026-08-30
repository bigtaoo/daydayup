/**
 * Step 4 — Movement. Integrate vx/vy (fp displacement already baked per tick) on
 * the 2D ground plane; push actors out of static round solids (pillars) AND static
 * rectangular solids (AABB tile/wall geometry, design/07/09 ROADMAP 1.2); push
 * overlapping actors apart from EACH OTHER (design/07's actor–actor half); clamp
 * players inside the world bounds. Movement is strictly 2D — there is no z axis /
 * gravity (jump was removed; a future dodge is a planar blink, not a hop). Enemies
 * are integrated + resolved through the exact same path as players — AIDecideSystem
 * (step 2, before this one) is the only system that ever writes an enemy's vx/vy
 * (ENGINE_VERSION 37: chase-into-range, was always 0 before that), so this system
 * itself needed no changes to pick up enemy movement.
 *
 * Ports Game.ts updatePlayer() move+clamp, float px → fp. Push-out uses isqrt
 * (design/06 banned Math.sqrt).
 */
import { addFp, isqrt } from '../math/fixed';
import type { Fp } from '../math/fixed';
import { PLAYER_BASE } from '../content/players';
import { KNOCKBACK_FRICTION_PERMILLE, KNOCKBACK_SNAP_FP, WALL_NORTH_BRIM } from '../config';
import type { GameState } from '../state/GameState';
import type { Actor } from '../state/entities';

export class MovementSystem {
  // Reused every tick instead of allocating fresh in resolveActorPairs below —
  // cleared and refilled each call, never read across ticks, so this is a pure
  // perf win with no effect on the fixed ascending-id sort order it holds.
  private readonly actorPairScratch: Actor[] = [];

  tick(state: GameState): void {
    for (const p of state.players) {
      if (!p.alive) continue;
      this.integrate(p);
      this.resolveObstacles(state, p);
      this.resolveWalls(state, p);
      this.clampToWorld(state, p);
    }
    for (const e of state.enemies) {
      if (!e.alive) continue;
      this.integrate(e);
      this.resolveObstacles(state, e);
      this.resolveWalls(state, e);
    }
    this.resolveActorPairs(state);
  }

  private integrate(a: Actor): void {
    // Chill (ice status) scales this tick's displacement down; the stored vx/vy are
    // untouched (players re-derive them each tick from input, enemies are 0), so the
    // slow is purely a movement-time factor. Integer per-mille scale (design/06).
    let vx = a.vx;
    let vy = a.vy;
    const st = a.status;
    if (st.chillTicks > 0 && st.chillSlow > 0) {
      const keep = 1000 - st.chillSlow; // fraction of speed retained, per-mille
      vx = Math.trunc((vx * keep) / 1000) as Fp;
      vy = Math.trunc((vy * keep) / 1000) as Fp;
    }
    // Knockback (design/07, v25) is an independent external-force channel, added on
    // top of movement — NOT chill-scaled (a shove isn't the actor's own movement
    // speed) and NOT re-derived from input/AI each tick like vx/vy is, so it's the
    // only way an impulse actually survives long enough for Movement to apply it.
    a.gx = addFp(addFp(a.gx, vx), a.knockVx);
    a.gy = addFp(addFp(a.gy, vy), a.knockVy);
    this.decayKnockback(a);
  }

  /** Friction: knockVx/knockVy shrink by a fixed per-mille factor every tick, snapping
   * to exactly 0 below a small threshold so a shove fades out instead of leaving a
   * sub-pixel residual drifting forever (integer arithmetic never reaches 0 on its
   * own from a multiply-by-fraction alone once it's below the per-tick truncation). */
  private decayKnockback(a: Actor): void {
    a.knockVx = Math.trunc((a.knockVx * KNOCKBACK_FRICTION_PERMILLE) / 1000) as Fp;
    a.knockVy = Math.trunc((a.knockVy * KNOCKBACK_FRICTION_PERMILLE) / 1000) as Fp;
    if (Math.abs(a.knockVx) < KNOCKBACK_SNAP_FP) a.knockVx = 0 as Fp;
    if (Math.abs(a.knockVy) < KNOCKBACK_SNAP_FP) a.knockVy = 0 as Fp;
  }

  /**
   * Push the actor out of any static round solid it overlaps. Circle-vs-circle:
   * if centre distance < r_actor + r_obstacle, shift the actor out along the
   * centre line by the penetration depth. Obstacles are static, so the actor
   * absorbs the full push (design/07's half-each split is for actor–actor).
   * Iterated in fixed array order — deterministic when solids overlap.
   */
  private resolveObstacles(state: GameState, a: Actor): void {
    for (const idx of state.spatialIndex.queryObstacles(a.gx, a.gy, a.solidRadius)) {
      const o = state.obstacles[idx]!;
      const dx = a.gx - o.gx;
      const dy = a.gy - o.gy;
      // `solidRadius`, not the feet circle — see Actor.solidRadius (v43): overlapping
      // a solid reads as sinking into it, where overlapping another body reads as a crowd.
      const minDist = a.solidRadius + o.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minDist * minDist) continue; // no overlap
      const dist = isqrt(distSq);
      if (dist === 0) {
        // Exactly concentric — no defined push direction; nudge along +x by the
        // full clearance so the choice is deterministic across clients.
        a.gx = addFp(a.gx, minDist as Fp);
        continue;
      }
      const pen = minDist - dist; // fp penetration depth
      // (dx,dy)/dist is the unit outward normal; × pen gives the fp displacement.
      a.gx = (a.gx + Math.trunc((dx * pen) / dist)) as Fp;
      a.gy = (a.gy + Math.trunc((dy * pen) / dist)) as Fp;
    }
  }

  /**
   * Push the actor's `solidRadius` circle out of any overlapping AABB wall (design/07/09,
   * ROADMAP 1.2 — the "axis-separation push" deferred alongside RoomState). Two
   * cases, matching standard circle-vs-rect resolution:
   *   - centre outside the rect: push along the normal to the nearest edge point,
   *     same style as the round-pillar resolver above (isqrt, no Math.sqrt).
   *   - centre inside the rect (fully engulfed footprint): axis-separation — push
   *     out along whichever single axis reaches open air soonest. Ties (equal
   *     distance to two edges) resolve in a fixed +x/+y-preferring order so every
   *     client picks the same edge (mirrors the round-pillar concentric-overlap rule).
   */
  private resolveWalls(state: GameState, a: Actor): void {
    // Broadphase with the brim ADDED to the query radius, never to the stored rects: the index
    // is built over the authored footprints (and is shared with the projectile/LOS queries,
    // which must keep hitting the real stone), so the only safe way to see a wall an actor
    // overlaps only through its brim is to ask a little wider here. Over-querying costs a
    // rejected narrowphase test; under-querying would silently drop the push.
    for (const idx of state.spatialIndex.queryWalls(a.gx, a.gy, (a.solidRadius + WALL_NORTH_BRIM) as Fp)) {
      const w = state.walls[idx]!;
      const r = a.solidRadius;
      // The wall's collision rect, which is its authored rect with its NORTH edge pulled out by
      // `WALL_NORTH_BRIM` on a free-standing block (v47, see that constant): such a block's art
      // rises a full wall height north of `w.y`, and without the brim an actor standing there is
      // drawn entirely inside stone. Inflating the EDGE (rather than special-casing a
      // north-approach) keeps this one rect-vs-circle test, so the corner cases — sliding along
      // the block's east face past its north end, being pushed out of an overlap — stay the same
      // code and the same tie-breaks they already were.
      const top = (w.freeStanding ? w.y - WALL_NORTH_BRIM : w.y) as Fp;
      const right = (w.x + w.w) as Fp;
      const bottom = (w.y + w.h) as Fp;
      const closestX = Math.max(w.x, Math.min(a.gx, right)) as Fp;
      const closestY = Math.max(top, Math.min(a.gy, bottom)) as Fp;
      const dx = a.gx - closestX;
      const dy = a.gy - closestY;
      const distSq = dx * dx + dy * dy;
      if (distSq > 0) {
        if (distSq >= r * r) continue; // no overlap
        const dist = isqrt(distSq);
        const pen = r - dist;
        a.gx = (a.gx + Math.trunc((dx * pen) / dist)) as Fp;
        a.gy = (a.gy + Math.trunc((dy * pen) / dist)) as Fp;
        continue;
      }
      // Centre is inside the rect: push out along the nearest single edge.
      const pushLeft = (a.gx - w.x) as number;
      const pushRight = (right - a.gx) as number;
      const pushTop = (a.gy - top) as number;
      const pushBottom = (bottom - a.gy) as number;
      const min = Math.min(pushLeft, pushRight, pushTop, pushBottom);
      if (min === pushRight) a.gx = (right + r) as Fp;
      else if (min === pushLeft) a.gx = (w.x - r) as Fp;
      else if (min === pushBottom) a.gy = (bottom + r) as Fp;
      else a.gy = (top - r) as Fp;
    }
  }

  /**
   * Push overlapping actors apart from EACH OTHER (design/07 step 4.3, the
   * "still deferred" half — every actor↔solid case above shipped earlier). Circle
   * (`footprintRadius`, the feet — deliberately NOT the `solidRadius` the two
   * resolvers above use, and not the body `radius`; see Actor.solidRadius for why
   * the two overlaps are judged differently) vs circle, half the penetration to
   * each side (funny's `subFp(subFp(
   * other − rOther), (self + rSelf))` mapped onto two movers instead of one mover
   * + a static solid). EVERY alive pair pushes apart, with no faction exception.
   *
   * Enemy-vs-enemy used to be skipped, on design/07's own "Open questions"
   * recommendation that packed rooms read better with mobs leaning overlap rather than
   * jostling each other. Reverted 2026-08-17 (ENGINE_VERSION 42, live play report:
   * "怪物之间要有碰撞"): what that actually produced was a garrison converging into one
   * spot and stacking into a single blob of overlapping sprites — several mobs sharing
   * one silhouette, so the player could neither count the threat nor tell what they
   * were shooting at. The same-plane push that already keeps players and enemies from
   * interpenetrating is what makes a crowd read as a crowd. It also composes with the
   * v42 perception radius above: mobs now arrive in waves rather than as one column, so
   * there is much less sustained mutual pushing to pay for.
   *
   * All-pairs over every alive actor: a room/arena today holds a handful of
   * players + enemies (the existing obstacle/wall resolvers' own "costs nothing at
   * this scale" precedent), so no spatial-grid broadphase is needed — unlike
   * UniformGrid over state.walls/obstacles, actors move every tick and rebuilding
   * a grid for a few dozen entities isn't worth the complexity yet. Revisit if a
   * PvP arena's live actor count ever gets large.
   *
   * Resolved in a FIXED ascending-id-ordered sequence (never state.players/
   * enemies array-concatenation order, which co-op seat count for example could
   * reshuffle) so the result is deterministic across clients (design/06).
   */
  private resolveActorPairs(state: GameState): void {
    const actors = this.actorPairScratch;
    actors.length = 0;
    for (const p of state.players) if (p.alive) actors.push(p);
    for (const e of state.enemies) if (e.alive) actors.push(e);
    actors.sort((x, y) => x.id - y.id);

    for (let i = 0; i < actors.length; i++) {
      const a = actors[i]!;
      for (let j = i + 1; j < actors.length; j++) {
        const b = actors[j]!;
        const dx = a.gx - b.gx;
        const dy = a.gy - b.gy;
        const minDist = a.footprintRadius + b.footprintRadius;
        const distSq = dx * dx + dy * dy;
        if (distSq >= minDist * minDist) continue; // no overlap

        const dist = isqrt(distSq);
        if (dist === 0) {
          // Exactly concentric — no defined push direction; split the full
          // clearance along +x (a gets the floor half, b the remainder) so every
          // client resolves the same deterministic tie, mirroring the
          // obstacle-resolver's own concentric-overlap convention.
          const half = Math.trunc((minDist as number) / 2);
          const other = (minDist as number) - half;
          a.gx = addFp(a.gx, half as Fp);
          b.gx = addFp(b.gx, -other as Fp);
          continue;
        }

        const pen = minDist - dist; // fp penetration depth
        // Full outward-normal displacement (same shape as resolveObstacles), then
        // split in half between the two movers — a gets the floor half, b the
        // exact remainder, so the two halves always sum back to the full push
        // (no residual overlap left standing from a rounding remainder).
        const nx = Math.trunc((dx * pen) / dist);
        const ny = Math.trunc((dy * pen) / dist);
        const nxHalf = Math.trunc(nx / 2);
        const nyHalf = Math.trunc(ny / 2);
        a.gx = (a.gx + nxHalf) as Fp;
        a.gy = (a.gy + nyHalf) as Fp;
        b.gx = (b.gx - (nx - nxHalf)) as Fp;
        b.gy = (b.gy - (ny - nyHalf)) as Fp;
      }
    }
  }

  private clampToWorld(state: GameState, a: Actor): void {
    const m = PLAYER_BASE.margin;
    a.gx = Math.max(m, Math.min(state.worldW - m, a.gx)) as Fp;
    a.gy = Math.max(m, Math.min(state.worldH - m, a.gy)) as Fp;
  }
}
