/**
 * Step 5 — projectile flight, and the wall/pillar STOP path (design/18-test-strategy.md,
 * Layer 1 / G6). `ballistics.test.ts` is the closest existing file and it covers the ballistic
 * SHAPES (homing turn, boomerang reversal, lob landing, beam window, orbit tracking); nothing
 * covered what this system does with a solid in front of a bullet, which is the half design/07
 * makes a determinism claim about.
 *
 * ## The claim this file exists to contradict
 *
 * design/07's determinism checklist used to read *"Swept tests (no float endpoint check) so
 * behavior is speed-independent and can't tunnel"*. That is FALSE in shipped code and the doc
 * has since been corrected. `ProjectileStepSystem` moves the bullet first and then runs
 * `circleOverlapsAabb(b.gx, b.gy, b.radius, w)` at the POST-MOVE point — its own comment
 * concedes "(swept test is 07)". A bullet whose per-tick displacement clears the whole overlap
 * band in one step is never tested against the wall at all.
 *
 * So the tunneling test below is a recorded LIMITATION, not desired behaviour. It is written to
 * be impossible to mistake for a feature, and the moment the swept test lands it must INVERT
 * (the fast bullet must then stop) — which is a behaviour change on every replay that contains
 * a fast shot near a thin wall, so it bumps `ENGINE_VERSION` (48 at the time of writing).
 *
 * ## The brim asymmetry is asserted as INTENDED, not tolerated
 *
 * design/18 G5: `circleOverlapsAabb` reads the BARE rect and never looks at `freeStanding`, so a
 * bullet flies through the `WALL_NORTH_BRIM` band north of a free-standing block that an actor
 * may never stand in. That is deliberate — `MovementSystem.resolveWalls` says the spatial index
 * is shared with the projectile queries, "which must keep hitting the real stone", and
 * `AABB.freeStanding`'s own doc lists the bullet path as pointedly excluded. G5's complaint is
 * that the intent lives only in comments. It is asserted here, so a future "consistency fix"
 * has to argue with a test.
 *
 * ## Mutation battery — what these tests are measured to catch
 *
 * Recorded 2026-08-30 at ENGINE_VERSION 48, against `ProjectileStepSystem.ts` only. Each
 * mutation was applied, this file run, then fully reverted.
 *
 *   KILLED   wall narrowphase: `circleOverlapsAabb(...)` never overlaps ....... 7 failing tests
 *   KILLED   lifespan: `if (b.lifeTicks <= 0)` -> `< 0` ...................... 5
 *   KILLED   pillar narrowphase: `circlesOverlap(...)` never overlaps ........ 2
 *   KILLED   pillar/wall order: run the wall loop BEFORE the pillar loop ..... 2
 *   KILLED   brim: wall test widened to the `blockingRect` rect .............. 1
 *   KILLED   oob margin: `b.gx > state.worldW + m` -> `>=` ................... 1
 *   KILLED   integrate/decrement order: move AFTER the lifespan check ........ 1
 *
 * No survivors. Two rows are worth staying honest about:
 *
 *   - The brim row is G5's whole point: it is the "let's make this consistent" mutant, and it
 *     now argues with a test rather than with a comment.
 *   - The integrate/decrement row kills ONE test, and only that one — the difference is
 *     invisible unless you look at where a bullet came to rest on its final tick. A single
 *     narrow kill is a thin margin, so don't delete that test as redundant.
 *
 * The honest coverage gap is elsewhere: this file pins the stop path and the expiry ordering,
 * not the ballistic shapes (`ballistics.test.ts`) and not bullet-vs-actor hits, which are step 7
 * and belong to `HitResolveSystem`.
 */
import { describe, expect, it } from 'vitest';
import { ProjectileStepSystem } from './ProjectileStepSystem';
import { circleOverlapsAabb, retainAlive } from './geom';
import { blockingRect } from './solidBounds';
import { UniformGrid } from './spatialGrid';
import { createGameState, type EngineConfig, type GameState } from '../state/GameState';
import { pxToFp } from '../content/convert';
import { BLASTER_SIM, WEAPON_SIM_BY_ID } from '../content/weapons';
import { SIM } from '../sim.config';
import { WALL_NORTH_BRIM } from '../config';
import type { Fp } from '../math/fixed';
import type { AABB, Projectile } from '../state/entities';

const step = new ProjectileStepSystem();

/**
 * Add two fp quantities the way the CODE composes them — never as `pxToFp(a + b)`.
 *
 * `pxToFp` rounds, so `pxToFp(400) + pxToFp(5)` and `pxToFp(405)` can land one fp unit apart,
 * and which one is "right" depends entirely on the implementation's order of operations. Every
 * boundary in this file is one fp unit wide on purpose, so the distinction is not academic —
 * see the same helper and the same reasoning in `solidBounds.test.ts` (`edgePlus`).
 */
const fpPlus = (a: Fp, b: number): Fp => ((a as number) + b) as Fp;

/** One grid cell of wall — the thinnest thing the shipped content actually builds with. */
const WALL_PX = { x: 320, y: 400, w: 320, h: 32 } as const;

const world = (over: Partial<EngineConfig> = {}): GameState =>
  createGameState({ seed: 7, worldW: 1600, worldH: 1200, waves: [], ...over });

/** A state with one horizontal 320x32 px wall, ready for a bullet travelling south into it. */
const worldWithWall = (): GameState => world({ walls: [[WALL_PX.x, WALL_PX.y, WALL_PX.w, WALL_PX.h]] });

/**
 * A real blaster round (`WEAPON_SPECS.blaster` → `BLASTER_SIM`), placed and aimed by hand.
 *
 * Built from the shipped spec rather than a literal so radius/lifespan/z can never drift away
 * from what `WeaponFireSystem` actually spawns — `bulletRadius` in particular is load-bearing
 * for every boundary computed below.
 */
function fire(s: GameState, gx: Fp, gy: Fp, vx: Fp, vy: Fp, over: Partial<Projectile> = {}): Projectile {
  const b: Projectile = {
    id: s.nextId(),
    faction: 'player',
    teamId: 0,
    gx,
    gy,
    z: BLASTER_SIM.bulletZ,
    vx,
    vy,
    radius: BLASTER_SIM.bulletRadius,
    damage: BLASTER_SIM.damage,
    damageType: BLASTER_SIM.damageType,
    lifeTicks: BLASTER_SIM.bulletLifeTicks,
    alive: true,
    ballistic: BLASTER_SIM.ballistic,
    ...over,
  };
  s.projectiles.push(b);
  return b;
}

const R = BLASTER_SIM.bulletRadius; // 150 fp — 0.15 grid, the starter round

/** Wall edges along the axis of travel, read off the built state (never re-derived from px). */
function wallSpan(s: GameState): { rect: AABB; top: Fp; bottom: Fp; midX: Fp } {
  const rect = s.walls[0]!;
  return {
    rect,
    top: rect.y,
    bottom: fpPlus(rect.y, rect.h as number),
    midX: fpPlus(rect.x, (rect.w as number) / 2),
  };
}

describe('the endpoint test — a bullet stops on the stone it lands in', () => {
  it('a blaster round travelling into a wall is absorbed', () => {
    const s = worldWithWall();
    const { top, midX } = wallSpan(s);
    // Start one fp clear of the overlap band's north edge, so the very next endpoint is inside
    // it: this is the ordinary case the whole system exists for.
    const b = fire(s, midX, fpPlus(top, -(R as number) - 1), 0 as Fp, BLASTER_SIM.bulletSpeed);
    expect(b.alive).toBe(true);

    step.tick(s);

    expect(b.alive).toBe(false);
    // It died on the WALL, not on the lifespan or the world margin — both of those still had
    // plenty left, so a mutation that broke the wall test cannot hide behind them.
    expect(b.lifeTicks).toBeGreaterThan(0);
    expect(b.gy).toBeLessThan(s.worldH);
  });

  it('a bullet that lands exactly tangent to the wall is stopped (the band is CLOSED)', () => {
    const s = worldWithWall();
    const { top, midX } = wallSpan(s);
    // circleOverlapsAabb compares `distSq <= r*r`, so touching counts. One fp either side of
    // this line is the difference between "stopped" and "through", and it is the line every
    // speed computation below is measured from.
    const tangent = fpPlus(top, -(R as number));
    const b = fire(s, midX, fpPlus(tangent, -1), 0 as Fp, 1 as Fp);

    step.tick(s);

    expect(b.gy).toBe(tangent);
    expect(b.alive).toBe(false);
  });

  it('a bullet one fp north of tangency survives', () => {
    const s = worldWithWall();
    const { top, midX } = wallSpan(s);
    const clear = fpPlus(top, -(R as number) - 1);
    const b = fire(s, midX, fpPlus(clear, -1), 0 as Fp, 1 as Fp);

    step.tick(s);

    expect(b.gy).toBe(clear);
    expect(b.alive).toBe(true);
  });

  it('a bullet is absorbed by a pillar', () => {
    const s = world({ obstacles: [[480, 700, 32]] });
    const o = s.obstacles[0]!;
    // Endpoint dead-centre in the pillar — concentric, the least ambiguous overlap there is.
    const b = fire(s, fpPlus(o.gx, -(BLASTER_SIM.bulletSpeed as number)), o.gy, BLASTER_SIM.bulletSpeed, 0 as Fp);

    step.tick(s);

    expect(b.gx).toBe(o.gx);
    expect(b.alive).toBe(false);
  });
});

describe('pillars are tested BEFORE walls — the `stopped` short-circuit', () => {
  /**
   * The order is not observable from state (both paths just set `alive = false`), so it is
   * observed at the broadphase instead: a bullet the pillar loop consumed never reaches
   * `queryWalls` at all. That is exactly what the `stopped` flag buys, and it is the thing a
   * refactor that "tidies" the two loops into one pass would silently drop.
   */
  class RecordingIndex extends UniformGrid {
    readonly calls: string[] = [];
    override queryObstacles(gx: Fp, gy: Fp, radius: Fp): number[] {
      this.calls.push('obstacles');
      return super.queryObstacles(gx, gy, radius);
    }
    override queryWalls(gx: Fp, gy: Fp, radius: Fp): number[] {
      this.calls.push('walls');
      return super.queryWalls(gx, gy, radius);
    }
  }

  /** A 128x128 px wall with a pillar standing inside it, so one endpoint overlaps both. */
  const overlapping = (): { s: GameState; idx: RecordingIndex } => {
    const s = world({ walls: [[900, 700, 128, 128]], obstacles: [[964, 764, 32]] });
    const idx = new RecordingIndex(s.walls, s.obstacles);
    s.spatialIndex = idx;
    return { s, idx };
  };

  it('a bullet overlapping both a pillar and a wall never runs the wall query', () => {
    const { s, idx } = overlapping();
    const o = s.obstacles[0]!;
    expect(circleOverlapsAabb(o.gx, o.gy, R, s.walls[0]!)).toBe(true); // the endpoint really is in both

    const b = fire(s, fpPlus(o.gx, -313), o.gy, 313 as Fp, 0 as Fp);
    step.tick(s);

    expect(b.alive).toBe(false);
    expect(idx.calls).toEqual(['obstacles']);
  });

  it('a bullet that misses every pillar does fall through to the wall query', () => {
    // The control for the assertion above: without it, `['obstacles']` could just as well mean
    // "the wall query is never called at all", which no mutation would then catch.
    const { s, idx } = overlapping();
    const w = s.walls[0]!;
    const b = fire(s, fpPlus(w.x, 500), fpPlus(w.y, 500), 1 as Fp, 0 as Fp);

    step.tick(s);

    expect(b.alive).toBe(false);
    expect(idx.calls).toEqual(['obstacles', 'walls']);
  });
});

describe('the tunneling limitation — RECORDED, not desired (design/18 G6)', () => {
  /**
   * Derived, never hardcoded: the wall's own thickness and the bullet's own radius decide this.
   *
   * A circle of radius `r` centred at `y` overlaps a rect spanning `[top, bottom]` exactly while
   * `top - r <= y <= bottom + r` — a CLOSED band of length `h + 2r`. To skip it in one step the
   * bullet must go from one fp north of the band to one fp south of it, so the smallest per-tick
   * displacement that can tunnel is `h + 2r + 2`. At `h + 2r + 1` no starting phase exists that
   * clears both ends, which the paired test below pins.
   */
  const tunnelStep = (thickness: Fp, radius: Fp): Fp => ((thickness as number) + 2 * (radius as number) + 2) as Fp;

  it('a bullet faster than the wall is thick tunnels straight through (endpoint test, not swept — design/18 G6)', () => {
    // ── THIS TEST IS A BUG REPORT, NOT A SPEC ────────────────────────────────────────────
    // When the swept test design/07 step 5 describes actually lands, this assertion must
    // INVERT: the fast bullet must then be absorbed, exactly like the slow one below. That is
    // a visible behaviour change on any replay containing a fast shot near thin cover, so it
    // is an ENGINE_VERSION bump (48 when this was written), not an additive fix.
    const s = worldWithWall();
    const { rect, top, bottom, midX } = wallSpan(s);
    const speed = tunnelStep(rect.h, R);

    const start = fpPlus(top, -(R as number) - 1); // one fp north of the band
    const b = fire(s, midX, start, 0 as Fp, speed);

    step.tick(s);

    expect(b.gy).toBe(fpPlus(bottom, (R as number) + 1)); // one fp south of it — never sampled inside
    expect(b.alive).toBe(true);

    // Anti-vacuity, and the whole point of the finding: the broadphase DID hand this wall to
    // the narrowphase at the post-move point. The bullet survives because the endpoint test
    // says "no overlap here", not because the spatial index lost the wall.
    expect(s.spatialIndex.queryWalls(b.gx, b.gy, b.radius)).toContain(0);
    expect(circleOverlapsAabb(b.gx, b.gy, b.radius, rect)).toBe(false);
  });

  it('one fp per tick slower, from the same start, and the same wall stops it', () => {
    // The boundary is exact, so the limitation is a threshold rather than a vague "fast bullets
    // sometimes get through" — and this is what proves the test above is not passing for some
    // unrelated reason (wrong lane, dead bullet, missing wall).
    const s = worldWithWall();
    const { rect, top, bottom, midX } = wallSpan(s);
    const speed = fpPlus(tunnelStep(rect.h, R), -1);

    const b = fire(s, midX, fpPlus(top, -(R as number) - 1), 0 as Fp, speed);

    step.tick(s);

    expect(b.gy).toBe(fpPlus(bottom, R as number)); // lands exactly tangent — the closed band bites
    expect(b.alive).toBe(false);
  });

  it('no shipped ranged weapon is fast enough to reach that threshold', () => {
    // Which is why this has never been a live bug report, and why it is a recorded limitation
    // rather than an outage. It is also a live guard: authoring a weapon past the threshold
    // fails HERE, pointing at the endpoint test, instead of shipping a bullet that ignores thin
    // cover. `deflectSpeed` (SABER_SIM, 14.4 grid/s) is well under it too.
    const thickness = pxToFp(WALL_PX.h);
    let fastest = { id: '', speed: 0, threshold: 0 };
    let checked = 0;
    for (const [id, spec] of Object.entries(WEAPON_SIM_BY_ID)) {
      if (spec.kind !== 'ranged') continue;
      checked++;
      const threshold = tunnelStep(thickness, spec.bulletRadius) as number;
      // Compared as a labelled string so a failure names the offending weapon rather than
      // reporting a bare `false`.
      expect(`${id}:${spec.bulletSpeed < threshold}`).toBe(`${id}:true`);
      if ((spec.bulletSpeed as number) > fastest.speed) {
        fastest = { id, speed: spec.bulletSpeed as number, threshold };
      }
    }
    expect(checked).toBeGreaterThan(8); // anti-vacuity: the catalog really was walked
    // Headroom, not a hard rule: the fastest shipped round (teslagun, 13 grid/s = 429 fp/tick)
    // sits at about a third of its own 1302 fp/tick threshold. Asserted at HALF rather than at
    // the true ratio so that merely tuning a weapon upward doesn't cry wolf — the per-weapon
    // assertion above is the one that actually guards the limit.
    expect(fastest.speed * 2).toBeLessThan(fastest.threshold);
  });
});

describe('the brim asymmetry is INTENDED (design/18 G5)', () => {
  /**
   * `EngineConfig.walls` cannot author `freeStanding` (it is a `RoomPiece`/`roomGeometry`
   * property), so the flag is set on the built rect. The spatial index is deliberately left
   * alone: it indexes authored FOOTPRINTS, and `queryRadiusFor` adds the brim on the query side
   * only — which is precisely the mechanism this test is about.
   */
  const freeStandingWorld = (): GameState => {
    const s = worldWithWall();
    s.walls[0]!.freeStanding = true;
    return s;
  };

  it('a bullet flies through the band north of a free-standing block that an actor may never stand in', () => {
    // NOT a bug, and not to be "made consistent". `MovementSystem.resolveWalls`: the index is
    // shared with the projectile queries, "which must keep hitting the real stone". The brim
    // exists so a character is not drawn buried in art that rises a full wall height north of
    // `w.y` (ENGINE_VERSION 47); a bullet has no such sprite and must collide with the stone the
    // wall actually is. `AABB.freeStanding`'s doc names the bullet path as excluded on purpose —
    // this test is that sentence, made falsifiable.
    const s = freeStandingWorld();
    const { rect, top, midX } = wallSpan(s);

    // Fly west-to-east along the band, so travel never approaches the stone at all.
    const lane = fpPlus(top, -300); // inside the 719 fp brim, clear of the 150 fp bare boundary
    const b = fire(s, fpPlus(midX, -(BLASTER_SIM.bulletSpeed as number)), lane, BLASTER_SIM.bulletSpeed, 0 as Fp);

    step.tick(s);

    expect(b.alive).toBe(true);

    // State the ACTOR boundary through `blockingRect`, never by restating the brim arithmetic —
    // one definition, one place (design/18 G3 / `solidBounds.ts`). The bullet's centre is south
    // of where an actor is stopped and north of the stone: that gap IS the asymmetry.
    expect(b.gy).toBeGreaterThan(blockingRect(rect).top);
    expect(b.gy).toBeLessThan(rect.y);

    // And the mutant this is aimed at: had the wall test been widened to the blocking rect,
    // this same point would overlap. It does — against the brimmed rect, not the bare one.
    const brimmed: AABB = { ...rect, y: blockingRect(rect).top, h: fpPlus(rect.h, WALL_NORTH_BRIM as number) };
    expect(circleOverlapsAabb(b.gx, b.gy, b.radius, brimmed)).toBe(true);
    expect(circleOverlapsAabb(b.gx, b.gy, b.radius, rect)).toBe(false);
  });

  it('the same free-standing block still absorbs a bullet that reaches the real stone', () => {
    // The control: `freeStanding` must not read as "bullets ignore me". Without it, the test
    // above would pass just as well against a wall that had stopped colliding altogether.
    const s = freeStandingWorld();
    const { top, midX } = wallSpan(s);
    const b = fire(s, midX, fpPlus(top, -(R as number) - 2), 0 as Fp, 2 as Fp);

    step.tick(s);

    expect(b.alive).toBe(false);
  });
});

describe('expiry — lifespan, then the world margin, then solids', () => {
  it('lifeTicks counts down one per tick and the bullet dies on the tick it reaches zero', () => {
    const s = world();
    const b = fire(s, pxToFp(100), pxToFp(100), 313 as Fp, 0 as Fp, { lifeTicks: 3 });

    step.tick(s);
    expect([b.lifeTicks, b.alive]).toEqual([2, true]);
    step.tick(s);
    expect([b.lifeTicks, b.alive]).toEqual([1, true]);
    step.tick(s);
    expect([b.lifeTicks, b.alive]).toEqual([0, false]);
  });

  it('the final tick still MOVES the bullet before it expires', () => {
    // Integrate-then-decrement, not the other way round: the last tick of flight is a real tick
    // of travel, which is what makes a lob land where its arc ends rather than one step short.
    const s = world();
    const start = pxToFp(100);
    const b = fire(s, start, pxToFp(100), 313 as Fp, 0 as Fp, { lifeTicks: 1 });

    step.tick(s);

    expect(b.alive).toBe(false);
    expect(b.gx).toBe(fpPlus(start, 313));
  });

  it('a dead bullet is skipped entirely on later ticks', () => {
    const s = world();
    const b = fire(s, pxToFp(100), pxToFp(100), 313 as Fp, 0 as Fp, { lifeTicks: 1 });
    step.tick(s);
    const restingAt = b.gx;

    step.tick(s);
    step.tick(s);

    expect(b.gx).toBe(restingAt);
    expect(b.lifeTicks).toBe(0);
  });

  it('a lob whose lifespan ends inside a wall LANDS there instead of being absorbed', () => {
    // The observable consequence of the expiry check running before the solid checks: the
    // `continue` on lifespan end means a lob never consults the wall at all, so its blast still
    // resolves in step 7 (design/08's movement-vs-hit-resolution split). Reordering those two
    // blocks would silently delete the blast.
    const s = worldWithWall();
    const { top, midX } = wallSpan(s);
    const b = fire(s, midX, fpPlus(top, -1), 0 as Fp, 100 as Fp, {
      ballistic: 'lob',
      blastRadius: pxToFp(64),
      lifeTicks: 1,
    });

    step.tick(s);

    expect(circleOverlapsAabb(b.gx, b.gy, b.radius, s.walls[0]!)).toBe(true);
    expect(b.landed).toBe(true);
    expect(b.alive).toBe(true);
  });

  it('a beam frozen inside a wall is not absorbed either', () => {
    // Beams `continue` before the integrate, so they never reach the lifespan/oob/solid checks —
    // a hitscan channel that expired the moment its origin overlapped stone could never be fired
    // from cover.
    const s = worldWithWall();
    const { top, midX } = wallSpan(s);
    const b = fire(s, midX, fpPlus(top, 100), 0 as Fp, 0 as Fp, {
      ballistic: 'beam',
      beamTicksLeft: 5,
      lifeTicks: 90,
    });

    step.tick(s);

    expect(b.alive).toBe(true);
    expect(b.beamTicksLeft).toBe(4);
    expect(b.lifeTicks).toBe(90); // untouched — the beam's own window is the only clock it has
  });

  it('the off-map margin is exclusive: exactly on it survives, one fp past it expires', () => {
    // `b.gx > state.worldW + m`, so the margin line itself is still in play. A `>=` here would
    // shave one fp off every bullet's reach in all four directions.
    const m = SIM.bullet.oobMargin as number;

    const alive = world();
    const onTheLine = fpPlus(alive.worldW, m);
    const a = fire(alive, fpPlus(onTheLine, -313), pxToFp(600), 313 as Fp, 0 as Fp);
    step.tick(alive);
    expect(a.gx).toBe(onTheLine);
    expect(a.alive).toBe(true);

    const dead = world();
    const d = fire(dead, fpPlus(onTheLine, -312), pxToFp(600), 313 as Fp, 0 as Fp);
    step.tick(dead);
    expect(d.gx).toBe(fpPlus(onTheLine, 1));
    expect(d.alive).toBe(false);
  });

  it('the margin applies to the north and west edges too', () => {
    const m = SIM.bullet.oobMargin as number;
    const s = world();
    const west = fire(s, (-m + 1) as Fp, pxToFp(600), -2 as Fp, 0 as Fp);
    const north = fire(s, pxToFp(600), (-m + 1) as Fp, 0 as Fp, -2 as Fp);

    step.tick(s);

    expect(west.alive).toBe(false);
    expect(north.alive).toBe(false);
  });
});

describe('compaction preserves fire order (design/08 determinism contract)', () => {
  it('this system only MARKS bullets dead — the array is still intact afterwards', () => {
    // Compaction is deliberately deferred to the end of HitResolve (step 7) so block/deflect and
    // hits have all had their say first. A bullet spliced out here would shift every later
    // bullet's index mid-tick, which is the classic mark-then-sweep bug design/07 bans.
    const s = worldWithWall();
    const { top, midX } = wallSpan(s);
    fire(s, midX, fpPlus(top, -(R as number) - 1), 0 as Fp, BLASTER_SIM.bulletSpeed);

    step.tick(s);

    expect(s.projectiles).toHaveLength(1);
    expect(s.projectiles[0]!.alive).toBe(false);
  });

  it('retainAlive keeps the survivors in push order, whatever killed the others', () => {
    // Push order IS fire order, and step 7 resolves bullet-vs-bullet clashes by it — so a
    // compaction that reordered survivors would change which of two colliding bullets wins on
    // one client and not another. Killing the three casualties by THREE different causes (wall,
    // world margin, lifespan) keeps the ordering from being an artifact of a single path.
    const s = worldWithWall();
    const { top, midX } = wallSpan(s);
    const m = SIM.bullet.oobMargin as number;

    const survivor1 = fire(s, pxToFp(100), pxToFp(100), 0 as Fp, 0 as Fp);
    const byWall = fire(s, midX, fpPlus(top, -(R as number) - 1), 0 as Fp, BLASTER_SIM.bulletSpeed);
    const survivor2 = fire(s, pxToFp(200), pxToFp(100), 0 as Fp, 0 as Fp);
    const byMargin = fire(s, fpPlus(s.worldW, m), pxToFp(600), 2 as Fp, 0 as Fp);
    const byLifespan = fire(s, pxToFp(300), pxToFp(100), 0 as Fp, 0 as Fp, { lifeTicks: 1 });
    const survivor3 = fire(s, pxToFp(400), pxToFp(100), 0 as Fp, 0 as Fp);

    step.tick(s);

    expect([byWall.alive, byMargin.alive, byLifespan.alive]).toEqual([false, false, false]);
    expect(s.projectiles).toHaveLength(6); // still un-compacted, per the test above

    retainAlive(s.projectiles);

    expect(s.projectiles.map((b) => b.id)).toEqual([survivor1.id, survivor2.id, survivor3.id]);
  });
});
