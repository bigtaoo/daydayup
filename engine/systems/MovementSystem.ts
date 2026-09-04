/**
 * Step 4 — Movement. Integrate vx/vy (fp displacement already baked per tick) on
 * the 2D ground plane; push actors out of static round solids (pillars) AND static
 * rectangular solids (AABB tile/wall geometry, design/07/09 ROADMAP 1.2); push
 * overlapping actors apart from EACH OTHER (design/07's actor–actor half); spread
 * mobs that have STOPPED away from each other so a garrison doesn't stack into one
 * silhouette (`resolveStandingSpacing`, ENGINE_VERSION 55); clamp
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
import { DEFAULT_ENEMY_MOVE_SPEED_PER_TICK } from '../content/enemies';
import { KNOCKBACK_FRICTION_PERMILLE, KNOCKBACK_SNAP_FP } from '../config';
import type { GameState } from '../state/GameState';
import type { Actor, EnemyActor } from '../state/entities';
import { blockingRadius, standoffRadius } from '../state/actorRadius';
import { pushOutOfObstacle, pushOutOfWall, queryRadiusFor, type Point } from './solidBounds';

export class MovementSystem {
  // Reused every tick instead of allocating fresh in resolveActorPairs below —
  // cleared and refilled each call, never read across ticks, so this is a pure
  // perf win with no effect on the fixed ascending-id sort order it holds.
  private readonly actorPairScratch: Actor[] = [];
  // Same deal for the standing-spacing pass: the holders and their accumulated
  // push, refilled every tick and never read across ticks.
  private readonly holderScratch: EnemyActor[] = [];
  private readonly holderPushX: number[] = [];
  private readonly holderPushY: number[] = [];

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
    this.resolveStandingSpacing(state);
    this.reseparateFromSolids(state);
  }

  /**
   * Re-resolve every actor against the static solids AFTER the pair push (ENGINE_VERSION 49).
   *
   * The pair push used to be the last thing a tick did, which meant it could shove an actor
   * back into stone with nothing left to correct it. The tradition around that ordering held
   * that it was "corrected on the following tick", and for a glancing shove it is — but two
   * bodies pinned together against a wall re-apply the shove every tick, so the wall pass never
   * gets the last word and the pair reaches a STABLE standoff inside the wall.
   * `engine/smoke.test.ts` measured it on the launch arena before this fix: one episode of 103
   * consecutive ticks (~3.4 s at 30 Hz) at up to 189 fp — a full 6 px of body inside stone,
   * the same order as the v47/v48 reports about characters looking buried in walls.
   *
   * The trade is explicit and is the right way round per design/07: after this pass two actors
   * may overlap each other slightly more than the pair push intended, because a solid gets the
   * final say over a body. Overlapping a solid "reads as sinking into it"; overlapping another
   * actor "reads as a crowd" (see `Actor.solidRadius`). A crowd is the acceptable artifact.
   *
   * Players are re-clamped to the world here too, for the same reason — `clampToWorld` ran
   * inside the player loop and had the same problem.
   */
  private reseparateFromSolids(state: GameState): void {
    for (const p of state.players) {
      if (!p.alive) continue;
      this.resolveObstacles(state, p);
      this.resolveWalls(state, p);
      this.clampToWorld(state, p);
    }
    for (const e of state.enemies) {
      if (!e.alive) continue;
      this.resolveObstacles(state, e);
      this.resolveWalls(state, e);
    }
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
    // `solidRadius`, not the feet circle — see Actor.solidRadius (v43): overlapping a solid
    // reads as sinking into it, where overlapping another body reads as a crowd. The push
    // itself lives in `solidBounds.pushOutOfObstacle`, shared with `geom.clampToWalkable`.
    const r = blockingRadius(a);
    const p: Point = { x: a.gx, y: a.gy };
    for (const idx of state.spatialIndex.queryObstacles(a.gx, a.gy, r)) {
      pushOutOfObstacle(p, r, state.obstacles[idx]!);
    }
    a.gx = p.x;
    a.gy = p.y;
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
    // Both the widened broadphase and the brimmed collision rect live in `solidBounds` — see
    // there for why the brim goes on the QUERY and not on the stored rects, and for the
    // tie-break rules this loop depends on. Sharing them with `geom.clampToWalkable` is the
    // point: they were duplicated line for line until design/18's G3 pass.
    const r = blockingRadius(a);
    const p: Point = { x: a.gx, y: a.gy };
    for (const idx of state.spatialIndex.queryWalls(a.gx, a.gy, queryRadiusFor(r))) {
      // Each wall is resolved against the position the PREVIOUS wall pushed us to — the cursor
      // preserves that ordering exactly, which is why it is threaded rather than recomputed.
      pushOutOfWall(p, r, state.walls[idx]!);
    }
    a.gx = p.x;
    a.gy = p.y;
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

  /**
   * Spread mobs that have ARRIVED away from each other (ENGINE_VERSION 55, live play report
   * 2026-09-03: *"怪物寻路时要加一个停留体积，最好是两倍于怪物的体型，这样怪物才会分散"*, with
   * a screenshot of three mobs fused into one silhouette and two health bars drawn over a
   * third body).
   *
   * The pair push above is a COLLISION rule — it fires only once two bodies already overlap,
   * and at `footprintRadius` (7 px against a 15 px body) that is barely before their sprites
   * are on top of each other. Nothing in the sim ever expressed the other half: how far apart
   * two mobs that have stopped moving would LIKE to stand. Without it every mob in a room
   * solves the same problem — walk at the player, stop at `engageRangeFp` — and arrives at the
   * same ring, so a garrison reads as one blob with several health bars.
   *
   * The reason this is a separate pass and not just a bigger radius in `resolveActorPairs` is
   * the report's other half, and it is the whole point of the design: a mob has one size while
   * TRAVELLING (its body — it has to fit through whatever gap the level authored) and a much
   * larger one while STANDING. So this pass is gated on `holding`, on BOTH sides:
   *
   *   - two mobs that have both stopped drift apart to `standoffRadius` each (2 body radii,
   *     so 4 between their centres) and end up as separate, countable, individually
   *     shootable threats;
   *   - a mob that is still moving neither pushes nor is pushed here, so a corridor only
   *     1.5 bodies wide stays passable at full speed even with a mob standing in it. A
   *     travelling mob is judged exactly as it was before this version.
   *
   * Three properties make it a shuffle rather than a shove:
   *
   *   - it is a PREFERENCE, applied on top of (never instead of) the collision push above,
   *     so it can be overruled: the solid re-separation right after this has the last word,
   *     and a mob backed into a corner simply stops spreading;
   *   - each mob's total displacement is capped at its own walking speed per tick, so a
   *     crowd unpacks over about half a second instead of exploding apart on one tick. The
   *     cap is per ACTOR, not per pair, which is also what keeps a mob at the centre of a
   *     press from being launched by the sum of six neighbours;
   *   - the pushes are ACCUMULATED first and applied after, so the result does not depend on
   *     the order pairs are visited (design/06 wants determinism, and this gets it by
   *     construction rather than by fixing an iteration order).
   *
   * `state.enemies` order is spawn order = ascending id, so the accumulation is deterministic
   * without the explicit sort `resolveActorPairs` needs (that one merges two arrays).
   *
   * STOPPED, not merely arrived (ENGINE_VERSION 56). Since v56 an arrived mob is walking to a
   * spot that already accounts for every other mob's standing volume (`approachSlots.ts`), so
   * this pass has one job left: correcting mobs that have come to rest too close together
   * anyway — shoved by a player pushing through the crowd, by knockback, or steered onto the
   * same spot because geometry left no route to a spread one. A mob still walking is already
   * resolving its own spacing, and pushing it as well would move it two walking speeds in one
   * tick, breaking the per-actor cap that is the whole reason this is a shuffle rather than a
   * shove.
   */
  private resolveStandingSpacing(state: GameState): void {
    const holders = this.holderScratch;
    const pushX = this.holderPushX;
    const pushY = this.holderPushY;
    holders.length = 0;
    for (const e of state.enemies) if (e.alive && e.holding && e.vx === 0 && e.vy === 0) holders.push(e);
    if (holders.length < 2) return;
    pushX.length = holders.length;
    pushY.length = holders.length;
    pushX.fill(0);
    pushY.fill(0);

    for (let i = 0; i < holders.length; i++) {
      const a = holders[i]!;
      for (let j = i + 1; j < holders.length; j++) {
        const b = holders[j]!;
        const dx = a.gx - b.gx;
        const dy = a.gy - b.gy;
        const want = standoffRadius(a) + standoffRadius(b);
        const distSq = dx * dx + dy * dy;
        if (distSq >= want * want) continue; // already standing far enough apart

        const dist = isqrt(distSq);
        if (dist === 0) {
          // Exactly concentric — no defined direction, so split along +x in the same
          // fixed, every-client-agrees way the two collision resolvers do.
          const half = Math.trunc((want as number) / 2);
          pushX[i] = pushX[i]! + half;
          pushX[j] = pushX[j]! - ((want as number) - half);
          continue;
        }
        const pen = want - dist;
        const nx = Math.trunc((dx * pen) / dist);
        const ny = Math.trunc((dy * pen) / dist);
        const nxHalf = Math.trunc(nx / 2);
        const nyHalf = Math.trunc(ny / 2);
        pushX[i] = pushX[i]! + nxHalf;
        pushY[i] = pushY[i]! + nyHalf;
        pushX[j] = pushX[j]! - (nx - nxHalf);
        pushY[j] = pushY[j]! - (ny - nyHalf);
      }
    }

    for (let i = 0; i < holders.length; i++) {
      const e = holders[i]!;
      const [dx, dy] = this.cappedShuffle(pushX[i]!, pushY[i]!, e);
      e.gx = (e.gx + dx) as Fp;
      e.gy = (e.gy + dy) as Fp;
    }
  }

  /**
   * Clamp one tick of accumulated standing-spacing push to the mob's own walking speed
   * (`moveSpeedPerTick`, the same number `AIDecideSystem` closes distance with), keeping the
   * direction. A standing mob that is being crowded should look like it is stepping aside,
   * and a mob cannot step aside faster than it can walk — which also means a hand-built
   * test actor with no `moveSpeedPerTick` behaves like a shipped mob rather than teleporting.
   *
   * Integer scale-down by `cap/len`, truncated toward zero, so the capped vector is never
   * longer than the cap and a sub-pixel push still resolves to 0 rather than to a rounding
   * artifact that jitters forever.
   */
  private cappedShuffle(dx: number, dy: number, e: EnemyActor): [Fp, Fp] {
    const cap = e.moveSpeedPerTick ?? DEFAULT_ENEMY_MOVE_SPEED_PER_TICK;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= cap * cap) return [dx as Fp, dy as Fp];
    const len = isqrt(lenSq);
    if (len === 0) return [0 as Fp, 0 as Fp];
    return [Math.trunc((dx * cap) / len) as Fp, Math.trunc((dy * cap) / len) as Fp];
  }

  private clampToWorld(state: GameState, a: Actor): void {
    const m = PLAYER_BASE.margin;
    a.gx = Math.max(m, Math.min(state.worldW - m, a.gx)) as Fp;
    a.gy = Math.max(m, Math.min(state.worldH - m, a.gy)) as Fp;
  }
}
