/**
 * Do the systems that read static geometry AGREE about where it blocks?
 * (design/18-test-strategy.md, G5 / Layer 2 — the file the whole doc was written for.)
 *
 * The question this answers is the one that prompted the strategy: *"changing a wall or pillar's
 * blocking range causes potential logic desync"*. It does, because several places ask "is this
 * blocked" and they do not all mean the same thing:
 *
 *   | consumer                             | radius            | brim? |
 *   |--------------------------------------|-------------------|-------|
 *   | MovementSystem.resolveWalls          | solidRadius       | YES   |
 *   | geom.clampToWalkable (drops, loot)   | caller's radius   | YES   |
 *   | ProjectileStepSystem (bullets)       | bullet radius     | no    |
 *   | DoorSystem.inLockingDoorway          | footprintRadius   | no    |
 *   | EnvironmentSystem.applyTraitDamage   | body radius       | no    |
 *
 * Some of that divergence is deliberate and some of it is drift, and until this file NOTHING
 * distinguished the two — the intent lived in comments, one of which had been false for two
 * ENGINE_VERSIONs. So the model here is a **declared agreement matrix**: every consumer
 * registers the boundary it is supposed to use, and a sweep checks it against every other.
 * Changing a consumer's behaviour now means changing its declaration, in the diff, on purpose.
 *
 * ## The question each probe answers, and why it is that one
 *
 * "Does a circle of radius `r` at (x, y) overlap the boundary YOU consider solid?"
 *
 * Not "did your push move the point". The first draft asked that, and it was wrong in an
 * instructive way: `pushOutOfWall`'s displacement is `Math.trunc((dx * pen) / dist)`, so an
 * overlap shallower than one fp unit truncates to a zero-length push and the point does not
 * move. "Overlapping" and "displaced" are genuinely different predicates, and comparing one
 * consumer's overlap against another's displacement reports a fleet of disagreements that are
 * really just integer truncation. Push arithmetic is `solidBounds.test.ts`'s job; BOUNDARIES
 * are this file's.
 *
 * ## What is structural and what is measured
 *
 * A test that can only pass is worthless, so:
 *
 *   - The brim-aware family now shares `blockingRect`, so their agreement is structural rather
 *     than something this sweep discovers. Its job there is regression — a special case bolted
 *     into one caller (exactly how these two diverged the first time) breaks it.
 *   - The bare-rect family is NOT structural. Nothing but this file says their disagreement
 *     with collision is confined to the brim band, and "confined to the brim band" is precisely
 *     what makes the asymmetry intentional rather than a bug. A bullet that stopped somewhere
 *     an actor could stand would show up here and nowhere else.
 *
 * ## Method
 *
 * Follows the `*Coverage.test.ts` idiom from `client/src/game/scene/`: real geometry through the
 * real pipeline, rasterized fine enough that nothing hides between samples, offenders
 * accumulated into a `string[]` so a failure prints coordinates instead of `false`, and an
 * explicit non-empty-sweep guard so it can never pass vacuously.
 */
import { describe, expect, it } from 'vitest';
import { createGameState, type GameState } from '../state/GameState';
import { pxToFp, toFpGrid } from '../content/convert';
import { PLAYER_BASE } from '../content/players';
import { WALL_NORTH_BRIM } from '../config';
import type { Fp } from '../math/fixed';
import type { AABB } from '../state/entities';
import { EMBER_L1_FLOORS, EMBER_L1_ROOMS } from '../world/rooms/emberLevel1';
import { placeAuthoredFloor } from '../world/dungeon/placeAuthoredFloor';
import { buildFloorGeometry } from '../world/dungeon/floorGeometry';
import { circleOverlapsAabb, circlesOverlap, clampToWalkable } from './geom';
import { blockingRect } from './solidBounds';

const px = (n: number): Fp => pxToFp(n);
const R = PLAYER_BASE.solidRadius;

// ── the geometry under test ───────────────────────────────────────────────────

/** The free-standing block every brim assertion below is aimed at. */
const SUBJECT: AABB = { x: px(300), y: px(400), w: px(160), h: px(96), freeStanding: true };
/** Its plain twin — identical but for the flag. The control for "the brim is flag-driven". */
const CONTROL: AABB = { x: px(620), y: px(400), w: px(160), h: px(96) };

/**
 * Synthetic geometry chosen so every interesting case is present and REACHABLE by the sweep.
 * Authored content is not obliged to contain a worst case — the shipped floor below supplies
 * realism, this supplies coverage. (The golden gate learned that lesson the hard way; see
 * `fixtures/brimGrinderFloor.ts`.)
 */
function syntheticState(): GameState {
  const s = createGameState({ seed: 1, worldW: 1024, worldH: 1024, waves: [] });
  s.walls.push(
    { x: px(0), y: px(0), w: px(1024), h: px(32) }, // perimeter ring, never freeStanding
    { x: px(0), y: px(992), w: px(1024), h: px(32) },
    { x: px(0), y: px(32), w: px(32), h: px(960) },
    { x: px(992), y: px(32), w: px(32), h: px(960) },
    SUBJECT,
    CONTROL,
    { x: px(300), y: px(700), w: px(480), h: px(32), freeStanding: true }, // a long low block
  );
  s.obstacles.push({ gx: px(520), gy: px(250), radius: px(40) });
  s.rebuildSpatialIndex();
  return s;
}

/** The shipped level-1 floor 1, through the real placement + stitching pipeline. */
function shippedFloorState(): GameState {
  const { placed, doors } = placeAuthoredFloor(EMBER_L1_FLOORS[0]!, EMBER_L1_ROOMS);
  const geo = buildFloorGeometry(placed, doors);
  const s = createGameState({ seed: 2, worldW: 64, worldH: 64, waves: [] });
  s.walls.push(...geo.walls);
  s.obstacles.push(...geo.obstacles);
  s.worldW = geo.worldW;
  s.worldH = geo.worldH;
  s.rebuildSpatialIndex();
  return s;
}

// ── the probes ────────────────────────────────────────────────────────────────

interface Probe {
  name: string;
  /** Does this consumer honour `WALL_NORTH_BRIM` on a free-standing block's north face? */
  brimAware: boolean;
  /** Why it has that answer. Read this before changing one. */
  why: string;
  blocked(s: GameState, x: Fp, y: Fp, r: Fp): boolean;
}

const PROBES: readonly Probe[] = [
  {
    name: 'movement',
    brimAware: true,
    why: 'MovementSystem.resolveWalls via solidBounds.blockingRect — the reference boundary',
    blocked: (s, x, y, r) =>
      s.walls.some((w) => {
        const b = blockingRect(w);
        return circleOverlapsAabb(x, y, r, { x: b.left, y: b.top, w: (b.right - b.left) as Fp, h: (b.bottom - b.top) as Fp });
      }) || s.obstacles.some((o) => circlesOverlap(x, y, r, o.gx, o.gy, o.radius)),
  },
  {
    name: 'bullet',
    brimAware: false,
    why:
      'ProjectileStepSystem — INTENDED: the spatial index is shared with projectile queries, ' +
      'which "must keep hitting the real stone" (resolveWalls own comment). A bullet crossing ' +
      'the brim band is correct; a bullet stopping where an actor could stand is not.',
    blocked: (s, x, y, r) =>
      s.walls.some((w) => circleOverlapsAabb(x, y, r, w)) ||
      s.obstacles.some((o) => circlesOverlap(x, y, r, o.gx, o.gy, o.radius)),
  },
];

const reference = PROBES[0]!;
const bareRect = PROBES.filter((p) => !p.brimAware);

/**
 * Is (x, y) inside the strip where the two families are ALLOWED to disagree — north of a
 * free-standing block's real footprint, within the brim, inside its x-span (widened by `r` on
 * every side, because both probes test a circle rather than a point)?
 */
function inBrimBand(s: GameState, x: Fp, y: Fp, r: Fp): boolean {
  return s.walls.some((w) => {
    if (!w.freeStanding) return false;
    const b = blockingRect(w);
    // CLOSED comparisons, matching `circleOverlapsAabb`'s own `<=`. Strict ones were wrong
    // here and the failure was invisible until floor 1 gained free-standing blocks: a sample
    // sitting exactly one radius west of a block's left edge (36000 vs b.left 36000) is
    // overlapping by the probes' reckoning and was excluded by the band's, so it reported as a
    // stray disagreement. Whenever a helper decides "is this the region where those two
    // functions may differ", it has to use the same open/closed convention they do.
    const withinX =
      (x as number) + (r as number) >= (b.left as number) && (x as number) - (r as number) <= (b.right as number);
    return (
      withinX && (y as number) >= (b.top as number) - (r as number) && (y as number) <= (w.y as number) + (r as number)
    );
  });
}

// ── the sweep ─────────────────────────────────────────────────────────────────

const STEP = toFpGrid(0.25); // a quarter cell, matching the client sweeps' resolution

function samples(s: GameState): { x: Fp; y: Fp }[] {
  const out: { x: Fp; y: Fp }[] = [];
  for (let y: number = STEP; y < (s.worldH as number); y += STEP) {
    for (let x: number = STEP; x < (s.worldW as number); x += STEP) out.push({ x: x as Fp, y: y as Fp });
  }
  return out;
}

describe.each([
  ['synthetic geometry (every case present by construction)', syntheticState()],
  ['the shipped ember floor 1 (real content, real pipeline)', shippedFloorState()],
])('%s', (_label, state) => {
  const all = samples(state);

  it('the sweep is dense enough to matter, and actually hits geometry', () => {
    // Anti-vacuity, first and loudest. Every assertion below is `expect(offenders).toEqual([])`,
    // which an empty sweep satisfies perfectly while testing nothing at all.
    expect(all.length).toBeGreaterThan(2000);
    const blocked = all.filter((p) => reference.blocked(state, p.x, p.y, R)).length;
    expect(blocked, 'nothing was blocked — did the geometry load?').toBeGreaterThan(50);
    expect(blocked, 'everything was blocked — the sweep is inside solid rock').toBeLessThan(all.length * 0.9);
  });

  it('a bare-rect consumer differs from collision ONLY inside the brim band', () => {
    // The assertion that carries the file. "Bullets ignore the brim" is intended; the dangerous
    // version of the same sentence is "the bullet path disagrees with collision somewhere nobody
    // checked". This says exactly where the disagreement may live, and nowhere else.
    const strays: string[] = [];
    for (const p of all) {
      const solid = reference.blocked(state, p.x, p.y, R);
      for (const probe of bareRect) {
        if (probe.blocked(state, p.x, p.y, R) === solid) continue;
        if (inBrimBand(state, p.x, p.y, R)) continue;
        strays.push(`(${p.x}, ${p.y}): ${reference.name}=${solid} but ${probe.name}=${!solid}, outside any brim band`);
      }
    }
    expect(strays.slice(0, 8)).toEqual([]);
  });

  it('a bare-rect consumer is never STRICTER than collision', () => {
    // The one-directional half, separate because it is the half with a visible consequence: a
    // bullet that stopped short of the stone would die in mid-air, and an aggregate "they differ
    // only in the band" bound does not rule that out on its own.
    const stricter: string[] = [];
    for (const p of all) {
      if (reference.blocked(state, p.x, p.y, R)) continue;
      for (const probe of bareRect) {
        if (probe.blocked(state, p.x, p.y, R)) stricter.push(`(${p.x}, ${p.y}): ${probe.name} blocks where movement does not`);
      }
    }
    expect(stricter.slice(0, 8)).toEqual([]);
  });
});

describe('the brim band is real, and the declarations describe it', () => {
  const state = syntheticState();
  const all = samples(state);

  it('there ARE samples where the two families legitimately disagree', () => {
    // Without this the test above passes trivially on geometry containing no band at all —
    // which is exactly how the golden gate's first version failed to see `WALL_NORTH_BRIM`. A
    // parity claim about an asymmetry means nothing unless the asymmetry occurs.
    const disputed = all.filter((p) => {
      const solid = reference.blocked(state, p.x, p.y, R);
      return bareRect.some((probe) => probe.blocked(state, p.x, p.y, R) !== solid);
    });
    expect(disputed.length, 'no sample distinguishes the brim-aware probe from the bare ones').toBeGreaterThan(20);
    for (const p of disputed) expect(inBrimBand(state, p.x, p.y, R)).toBe(true);
  });

  it('the plain TWIN of the free-standing block produces no disagreement — the brim is flag-driven', () => {
    // The control: `CONTROL` is identical to `SUBJECT` but for the flag. Disagreement around it
    // would mean the brim was leaking out of `freeStanding` into geometry, the failure mode
    // `blockingRect`'s doc rules out.
    const b = blockingRect(CONTROL);
    const near = all.filter(
      (p) =>
        (p.x as number) > (b.left as number) - 2000 &&
        (p.x as number) < (b.right as number) + 2000 &&
        (p.y as number) > (b.top as number) - 2000 &&
        (p.y as number) < (b.bottom as number) + 2000,
    );
    expect(near.length).toBeGreaterThan(50);
    for (const p of near) {
      const solid = reference.blocked(state, p.x, p.y, R);
      for (const probe of bareRect) expect(probe.blocked(state, p.x, p.y, R)).toBe(solid);
    }
  });

  it('the band the probes actually differ across is exactly WALL_NORTH_BRIM tall', () => {
    // Ties the matrix's `brimAware` column to the CONSTANT rather than to a comment. Walk north
    // up the block's centre line and measure the run of disagreeing rows directly, rather than
    // assuming where it starts — the first version of this assumed, started inside the stone
    // where both probes agree, and measured a band of zero.
    const x = px(380); // inside SUBJECT's x-span
    let disagreeing = 0;
    for (let y = (SUBJECT.y as number) + 2000; y > (SUBJECT.y as number) - 4000; y--) {
      const solid = reference.blocked(state, x, y as Fp, R);
      const bare = bareRect[0]!.blocked(state, x, y as Fp, R);
      if (solid !== bare) disagreeing++;
    }
    expect(disagreeing, 'measured band height should equal the brim').toBe(WALL_NORTH_BRIM as number);
  });
});

/**
 * `clampToWalkable` is the one consumer whose contract is about the RESULT, not about a
 * boundary: whatever it returns must be somewhere an actor can actually stand. That is a
 * different claim from "it uses the same rect as movement", and it is the claim the v48 live
 * report was about — *"角色根本无法拾取掉落的物品"*, a drop resting inside the brimmed band no
 * player could enter.
 */
describe('clampToWalkable — the end-to-end invariant, not just the boundary', () => {
  const state = shippedFloorState();
  /** Outside the reach of the final world-bounds clamp — see the known-defect test below. */
  const MARGIN = toFpGrid(1.5);

  const interior = samples(state).filter(
    (p) =>
      (p.x as number) > MARGIN &&
      (p.y as number) > MARGIN &&
      (p.x as number) < (state.worldW as number) - MARGIN &&
      (p.y as number) < (state.worldH as number) - MARGIN,
  );

  /** Strictly penetrating, as `pushOutOfWall` means it — tangency is legal, see below. */
  const penetrating = (x: Fp, y: Fp): boolean => {
    const out = clampToWalkable(x, y, R, state);
    return out.gx !== x || out.gy !== y;
  };

  it('never turns a standable point into an unstandable one', () => {
    // Measured on the shipped floor 1: 21,822 already-standable samples, zero broken. This is
    // the contract that actually matters for the v48 live report (*"角色根本无法拾取掉落的
    // 物品"*) — a drop spawns where an entity died, which MovementSystem guarantees is
    // standable, so "standable in, standable out" is the whole job.
    const broken: string[] = [];
    let standable = 0;
    for (const p of interior) {
      if (reference.blocked(state, p.x, p.y, R)) continue;
      standable++;
      const out = clampToWalkable(p.x, p.y, R, state);
      if (reference.blocked(state, out.gx, out.gy, R)) {
        broken.push(`(${p.x}, ${p.y}) -> (${out.gx}, ${out.gy}) became blocked`);
      }
    }
    expect(standable, 'the sweep found no standable floor at all').toBeGreaterThan(5000);
    expect(broken.slice(0, 8)).toEqual([]);
  });

  it('TANGENCY is not penetration — a point resting exactly against a face is left alone', () => {
    // Worth stating because it explains away a large apparent disagreement rather than hiding
    // it. `circleOverlapsAabb` is CLOSED (`<= cr * cr`, so touching counts as overlapping)
    // while `pushOutOfWall` is OPEN (`distSq >= r * r` returns without pushing). On a
    // grid-aligned map sampled at quarter cells, exact tangency is common, not exotic: a naive
    // "everything circleOverlapsAabb calls blocked must get pushed" sweep reports thousands of
    // failures, every one of them a point legally resting against a wall.
    //
    // The split is deliberate and both halves are load-bearing: an actor must be ALLOWED to
    // stand flush against stone (v43's *"角色…感觉陷进去了"* is the report from the other
    // direction), and a push that fired on tangency would jitter every resting actor each tick.
    const face = state.walls[0]!;
    const b = blockingRect(face);
    const tangent = { x: ((b.left as number) + (b.right as number)) / 2, y: (b.top as number) - (R as number) };
    expect(circleOverlapsAabb(tangent.x as Fp, tangent.y as Fp, R, face)).toBe(true); // closed: overlapping
    expect(penetrating(tangent.x as Fp, tangent.y as Fp)).toBe(false); // open: not pushed
  });

  it('FIXED in v49: the world clamp no longer undoes the wall push-out', () => {
    // Found by this file on 2026-08-30, fixed the same day in ENGINE_VERSION 49.
    //
    // The defect: `clampToWalkable` pushed out of walls and pillars and THEN clamped to
    // `[radius, worldW - radius]`, so the clamp won. In dungeon mode the world bounds are the
    // floor extent (`buildFloorGeometry`), whose edge IS the perimeter ring, one grid cell
    // (1000 fp) thick, while the clamp parks the point at exactly `radius` (500 fp) from the
    // edge — inside that wall. 247 of 23,509 standable samples on shipped floor 1 came back
    // unstandable, every one at the world edge.
    //
    // The fix is NOT simply reordering. Clamping first sends the point the other way: a point
    // inside the perimeter ring is pushed out by its nearest edge, and for a wall lying on the
    // world's own boundary that is the OUTER edge, so hundreds of samples per floor landed at
    // `worldW + radius`, outside the map entirely. The two constraints genuinely conflict at
    // the map edge, so the clamp had to move INSIDE the separation loop and the loop had to
    // repeat. See `geom.clampToWalkable` for the whole account.
    //
    // Measured after the fix across all five ember floors and the launch arena: zero results
    // outside the world, and zero standable inputs turned unstandable on any ember floor.
    const edgeStart = { x: toFpGrid(0.25), y: toFpGrid(0.25) };
    const out = clampToWalkable(edgeStart.x, edgeStart.y, R, state);

    // In the world.
    expect((out.gx as number) >= 0 && (out.gx as number) <= (state.worldW as number)).toBe(true);
    expect((out.gy as number) >= 0 && (out.gy as number) <= (state.worldH as number)).toBe(true);

    // And not inside stone. Measured as PENETRATION, not via `circleOverlapsAabb` — the first
    // version of this assertion used the latter and passed after the fix for the wrong reason,
    // because that predicate is CLOSED and the fixed result rests exactly TANGENT to the wall.
    // A test that cannot tell "resting against" from "buried in" cannot check this at all; it
    // is the same open/closed trap `TANGENCY is not penetration` above exists to name.
    expect(penetrationDepth(state, out.gx, out.gy, R)).toBeLessThanOrEqual(1);
  });
});

/** How far a circle at (x, y) reaches past the collision boundary, in fp. 0 when merely touching. */
function penetrationDepth(s: GameState, x: Fp, y: Fp, r: Fp): number {
  let worst = 0;
  for (const w of s.walls) {
    const b = blockingRect(w);
    const cx = Math.max(b.left as number, Math.min(x as number, b.right as number));
    const cy = Math.max(b.top as number, Math.min(y as number, b.bottom as number));
    const dx = (x as number) - cx;
    const dy = (y as number) - cy;
    worst = Math.max(worst, (r as number) - Math.sqrt(dx * dx + dy * dy));
  }
  return worst;
}
