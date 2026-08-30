/**
 * MovementSystem's OWN rules — the parts that are not delegated to `solidBounds`
 * (design/18-test-strategy.md, Layer 1).
 *
 * `MovementSystem.ts` had no dedicated test file at all: it was covered incidentally by
 * `rooms.test.ts` (wall push-out), `systems.test.ts` (a knockback smoke pass) and
 * `enemyChase.test.ts` (enemies move at all). Everything those files reach, they reach through
 * the push-out math — which since design/18's G3 pass lives in `solidBounds.ts` and is
 * exhaustively pinned by `solidBounds.test.ts`. This file deliberately stays off that turf and
 * covers what is left over once the geometry is someone else's problem:
 *
 *   - `integrate`'s chill scaling, and the four ways it can be a no-op;
 *   - knockback as an independent force channel — added on top, never chill-scaled, decayed and
 *     then SNAPPED;
 *   - `clampToWorld`, which is applied to players only and measures with a *player* constant;
 *   - the ORDER of the four resolve steps, which is a determinism contract, not a detail;
 *   - `resolveActorPairs`' radius choice, its half-split, and its id sort.
 *
 * ## Fixed-point composition
 *
 * `pxToFp` rounds, so `px(a) + px(b) !== px(a + b)` in general. Every expectation below is
 * composed the way the CODE composes it (see `solidBounds.test.ts`'s `edgePlus` helper for the
 * full account) — an expectation written the other way passes on whether two independent
 * roundings happened to agree for the numbers picked, which is luck rather than coverage.
 *
 * ## Mutation battery
 *
 * Recorded 2026-08-30 at ENGINE_VERSION 48, by editing `MovementSystem.ts` and re-running this
 * file. Every edit was reverted (`git diff --stat engine/systems/MovementSystem.ts` clean of
 * them). A no-op CONTROL edit was run through the same harness first and came back SURVIVED —
 * without it, a mistyped runner flag reports every mutant as inconclusive (or, worse, as killed).
 *
 *   SURVIVED CONTROL: a no-op comment edit ........................ (harness sanity check)
 *   KILLED   integrate: drop the chill scale entirely ................. 5 failing tests
 *   KILLED   integrate: Math.trunc -> Math.floor on the chill scale ... 1
 *   KILLED   integrate: chill-scale knockVx/knockVy too ............... 1
 *   KILLED   integrate: `st.chillTicks > 0 &&` -> `true` .............. 1
 *   KILLED   decayKnockback: drop the snap-to-0 ...................... 2
 *   KILLED   decayKnockback: `< SNAP` -> `<= SNAP` .................... 2
 *   KILLED   clampToWorld: PLAYER_BASE.margin -> PLAYER_BASE.solidRadius 1
 *   KILLED   clampToWorld: applied to enemies too .................... 1
 *   KILLED   tick: swap resolveObstacles <-> resolveWalls ............. 1
 *   KILLED   tick: resolveActorPairs moved BEFORE the actor loops ..... 2
 *   KILLED   resolveActorPairs: footprintRadius -> solidRadius ........ 4
 *   KILLED   resolveActorPairs: drop the `.sort((x, y) => x.id - y.id)`  1
 *   KILLED   resolveActorPairs: `if (alive)` filters dropped .......... 1
 *
 * No survivors, so there is no recorded gap here — but note what the battery does NOT reach:
 * every mutant above is inside `MovementSystem.ts`. The push geometry it delegates to is
 * `solidBounds.test.ts`'s battery, deliberately, and this file asserts nothing about it.
 *
 * One finding worth recording rather than asserting: `decayKnockback`'s doc comment justifies
 * the snap with *"integer arithmetic never reaches 0 on its own from a multiply-by-fraction"*.
 * That is not true as written — the decay uses `Math.trunc`, which rounds TOWARD zero, so
 * `trunc(1 * 800 / 1000) === 0` and the residual would die on its own after four more ticks
 * (27 instead of 23 from a full-strength impulse). The snap is a shortcut, not a necessity. It
 * is still a replay-visible constant, so it is pinned by exact tick count below.
 */
import { describe, expect, it } from 'vitest';
import { toFp, type Fp } from '../math/fixed';
import { pxToFp } from '../content/convert';
import { KNOCKBACK_FRICTION_PERMILLE, KNOCKBACK_SNAP_FP } from '../config';
import { PLAYER_BASE } from '../content/players';
import { buildEnemyActor } from '../content/enemies';
import { createGameState, type GameState } from '../state/GameState';
import type { EnemyActor } from '../state/entities';
import { MovementSystem } from './MovementSystem';

const px = (n: number): Fp => pxToFp(n);
/** Add two already-fp quantities. Never `px(a + b)` — see the header. */
const plus = (a: Fp, b: number): Fp => ((a as number) + b) as Fp;

const CFG = { seed: 1, worldW: 1600, worldH: 1200, waves: [] as const };

/** Default single-seat world: one player at the centre (800, 600 px), no solids. */
function world(extra: Partial<Parameters<typeof createGameState>[0]> = {}): GameState {
  return createGameState({ ...CFG, ...extra });
}

/** An enemy at exact fp coordinates, through the real factory so its radii never drift from
 *  `buildEnemyActor` (systems.test.ts hand-rolls its own and has a comment apologising for it). */
function enemyAt(s: GameState, gx: Fp, gy: Fp, id?: number): EnemyActor {
  const e = buildEnemyActor(s, gx, gy);
  if (id !== undefined) e.id = id;
  s.enemies.push(e);
  return e;
}

function chill(a: { status: { chillTicks: number; chillSlow: number } }, ticks: number, slow: number): void {
  a.status.chillTicks = ticks;
  a.status.chillSlow = slow;
}

describe('integrate — chill scales the DISPLACEMENT, never the stored velocity', () => {
  it('scales this tick\'s step by the retained per-mille fraction', () => {
    const s = world();
    const p = s.players[0]!;
    const x0 = p.gx;
    p.vx = toFp(1); // 1000 fp/tick
    chill(p, 10, 400); // keep 600 permille
    new MovementSystem().tick(s);
    expect((p.gx as number) - (x0 as number)).toBe(600);
  });

  it('leaves vx/vy untouched — a chilled player re-derives them from input next tick anyway', () => {
    // The reason this matters is that nothing ever un-applies the slow. If `integrate` wrote the
    // scaled value back, an ENEMY (whose vx/vy is only ever written by AIDecideSystem when it has
    // a chase target) would compound the slow every tick and effectively freeze solid.
    const s = world();
    const e = enemyAt(s, px(100), px(100));
    e.vx = toFp(1);
    e.vy = toFp(-1);
    chill(e, 10, 400);
    const mv = new MovementSystem();
    mv.tick(s);
    expect(e.vx).toBe(toFp(1));
    expect(e.vy).toBe(toFp(-1));
    // Second tick moves by exactly the same amount as the first — proof the slow did not compound.
    const x1 = e.gx;
    mv.tick(s);
    expect((e.gx as number) - (x1 as number)).toBe(600);
  });

  it('is a no-op once chillTicks has run out, even with chillSlow still set', () => {
    // StatusEffectSystem zeroes `chillSlow` on the tick the duration expires, so in a live sim
    // both conditions fall together. Testing them apart is the point: the `chillTicks > 0` half
    // of the guard is what makes the ORDER of those two systems not matter.
    const s = world();
    const p = s.players[0]!;
    const x0 = p.gx;
    p.vx = toFp(1);
    chill(p, 0, 400);
    new MovementSystem().tick(s);
    expect((p.gx as number) - (x0 as number)).toBe(1000); // full speed
  });

  it('is a no-op for a zero slow, even while nominally chilled', () => {
    const s = world();
    const p = s.players[0]!;
    const x0 = p.gx;
    p.vx = toFp(1);
    chill(p, 10, 0);
    new MovementSystem().tick(s);
    expect((p.gx as number) - (x0 as number)).toBe(1000);
  });

  it('a 1000-permille slow stops the actor dead, without moving it backwards', () => {
    const s = world();
    const p = s.players[0]!;
    const before = { x: p.gx, y: p.gy };
    p.vx = toFp(1);
    p.vy = toFp(1);
    chill(p, 10, 1000); // keep 0
    new MovementSystem().tick(s);
    expect(p.gx).toBe(before.x);
    expect(p.gy).toBe(before.y);
  });

  it('truncates TOWARD ZERO, so the slow is symmetric between +x and -x', () => {
    // `Math.trunc`, not `Math.floor` (design/06 bans anything whose sign behaviour differs
    // between platforms, but the two disagree here in a way that is purely a design choice):
    // 7 x 600 permille = 4.2. trunc gives +4 / -4; floor would give +4 / -5, which makes a
    // chilled actor measurably FASTER heading west than east — a directional bias that would
    // show up as drift in any replay that chills a mob into a wall.
    const s = world();
    const east = s.players[0]!;
    const west = enemyAt(s, px(400), px(400));
    east.vx = 7 as Fp;
    west.vx = -7 as Fp;
    chill(east, 10, 400);
    chill(west, 10, 400);
    const ex0 = east.gx;
    const wx0 = west.gx;
    new MovementSystem().tick(s);
    expect((east.gx as number) - (ex0 as number)).toBe(4);
    expect((west.gx as number) - (wx0 as number)).toBe(-4); // NOT -5
  });
});

describe('integrate — knockback is an independent force channel', () => {
  it('adds on top of movement and is NOT chill-scaled', () => {
    // A shove is something done TO the actor, not the actor\'s own locomotion, so the ice slow
    // must not damp it (entities.ts's knockVx doc states this as the contract). With vx=1000 and
    // knockVx=1000 under a 400-permille chill, the step is 600 + 1000, not 600 + 600 and not 1600
    // scaled as a whole.
    const s = world();
    const p = s.players[0]!;
    const x0 = p.gx;
    p.vx = toFp(1);
    p.knockVx = toFp(1);
    chill(p, 10, 400);
    new MovementSystem().tick(s);
    expect((p.gx as number) - (x0 as number)).toBe(600 + 1000);
  });

  it('displaces by the PRE-decay value — the impulse is spent this tick, then shrunk', () => {
    // Order inside `integrate`: add knockVx to the position, THEN decay. Decaying first would
    // silently discard 20% of every impulse's first tick.
    const s = world();
    const e = enemyAt(s, px(100), px(100));
    const x0 = e.gx;
    e.knockVx = toFp(1);
    new MovementSystem().tick(s);
    expect((e.gx as number) - (x0 as number)).toBe(1000);
    expect(e.knockVx).toBe(Math.trunc((1000 * KNOCKBACK_FRICTION_PERMILLE) / 1000) as Fp);
  });

  it('decays by KNOCKBACK_FRICTION_PERMILLE every tick, on both axes independently', () => {
    const s = world();
    const e = enemyAt(s, px(100), px(100));
    e.knockVx = toFp(1);
    e.knockVy = -toFp(1) as Fp;
    const mv = new MovementSystem();
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      mv.tick(s);
      seen.push(e.knockVx as number);
      expect(e.knockVy).toBe(-(e.knockVx as number) as Fp); // magnitudes stay mirrored
    }
    expect(seen).toEqual([800, 640, 512]); // 1000 x 0.8, truncated, three times
  });

  it('SNAPS a sub-threshold residual to exactly 0 instead of decaying it', () => {
    // The snap is what makes `KNOCKBACK_SNAP_FP` replay-visible: friction alone would take this
    // residual several more ticks to reach 0. Starting one notch above the threshold so the
    // friction step lands just under it, the very next tick must be exactly 0, not 4.
    const s = world();
    const e = enemyAt(s, px(100), px(100));
    e.knockVx = 6 as Fp; // trunc(6 x 0.8) = 4, which is < KNOCKBACK_SNAP_FP (5)
    expect(Math.trunc((6 * KNOCKBACK_FRICTION_PERMILLE) / 1000)).toBeLessThan(KNOCKBACK_SNAP_FP);
    new MovementSystem().tick(s);
    expect(e.knockVx).toBe(0 as Fp);
  });

  it('holds a residual exactly ON the threshold — the comparison is strict', () => {
    // `< KNOCKBACK_SNAP_FP`, not `<=`. Pinned because the boundary is exactly the kind of thing a
    // later "make it snap sooner" tweak changes without meaning to alter replays.
    const s = world();
    const e = enemyAt(s, px(100), px(100));
    e.knockVx = ((KNOCKBACK_SNAP_FP * 1000) / KNOCKBACK_FRICTION_PERMILLE) as Fp; // decays to exactly SNAP
    new MovementSystem().tick(s);
    expect(e.knockVx).toBe(KNOCKBACK_SNAP_FP as Fp);
  });

  it('reaches exactly 0 in a bounded, exact number of ticks — and stays there', () => {
    // "Eventually 0" is not enough: the tick count is observable in a replay (the actor stops
    // sliding on a specific tick), so it is pinned as a number. 23 ticks from a full 1-grid/tick
    // impulse; without the snap it would be 27.
    const s = world();
    const e = enemyAt(s, px(100), px(100));
    e.knockVx = toFp(1);
    e.knockVy = -toFp(1) as Fp;
    const mv = new MovementSystem();
    let ticks = 0;
    while ((e.knockVx as number) !== 0 || (e.knockVy as number) !== 0) {
      mv.tick(s);
      ticks++;
      expect(ticks).toBeLessThan(100); // guard against an infinite residual
    }
    expect(ticks).toBe(23);
    const settled = { x: e.gx, y: e.gy };
    mv.tick(s);
    expect(e.gx).toBe(settled.x); // no residual drift once snapped
    expect(e.gy).toBe(settled.y);
  });
});

describe('clampToWorld — a player-only rule, measured with a player constant', () => {
  it('clamps a player to PLAYER_BASE.margin on all four sides', () => {
    // The inset is `PLAYER_BASE.margin` (20px) and NOT the actor's own solid clearance (16px) —
    // the two are different numbers, so this assertion can tell them apart.
    expect(PLAYER_BASE.margin).not.toBe(PLAYER_BASE.solidRadius);
    const m = PLAYER_BASE.margin as number;
    for (const [vx, vy, ex, ey] of [
      [toFp(10000), toFp(0), (s: GameState) => plus(s.worldW, -m), () => px(600)],
      [-toFp(10000) as Fp, toFp(0), () => PLAYER_BASE.margin, () => px(600)],
      [toFp(0), toFp(10000), () => px(800), (s: GameState) => plus(s.worldH, -m)],
      [toFp(0), -toFp(10000) as Fp, () => px(800), () => PLAYER_BASE.margin],
    ] as const) {
      const s = world();
      const p = s.players[0]!;
      p.vx = vx as Fp;
      p.vy = vy as Fp;
      new MovementSystem().tick(s);
      expect(p.gx).toBe((ex as (st: GameState) => Fp)(s));
      expect(p.gy).toBe((ey as (st: GameState) => Fp)(s));
    }
  });

  it('does NOT clamp an enemy — a real, currently-deliberate asymmetry', () => {
    // `clampToWorld` is called from the player loop only; the enemy loop stops after
    // resolveWalls. Nothing in the shipped content notices (spawners place mobs well inside the
    // room and the perimeter ring walls stop them), but a knockback or an off-map spawn CAN park
    // an enemy outside the world with nothing to bring it back. Pinned so the exemption is a
    // decision on record rather than an oversight nobody measured.
    const s = world();
    const e = enemyAt(s, px(100), px(100));
    const kick = toFp(10000); // far more than the 1600px world is wide
    e.vx = kick;
    new MovementSystem().tick(s);
    expect(e.gx).toBe(plus(px(100), kick as number)); // the whole step, unclamped
    expect(e.gx as number).toBeGreaterThan(s.worldW as number); // genuinely outside the world
  });

  it('survives a pair shove — v49 re-clamps after the pair pass', () => {
    // Through v48 the clamp was only part of the per-actor pass, so the pair pass afterwards
    // could undo it and a shoved player ended the tick outside the margin. `reseparateFromSolids`
    // (v49) re-runs the clamp after pairs, so the margin is now a real invariant at end of tick
    // rather than a mid-tick one. Same fix, same reason, as the wall case below.
    const s = world({ players: [{ start: [20, 600] }] });
    const p = s.players[0]!;
    expect(p.gx).toBe(PLAYER_BASE.margin); // 20px == margin, so the clamp itself starts a no-op
    enemyAt(s, px(24), px(600)); // shoves the player further west
    new MovementSystem().tick(s);
    expect(p.gx as number).toBeGreaterThanOrEqual(PLAYER_BASE.margin as number);
  });
});

describe('tick order — obstacles, then walls, then pairs (a determinism contract)', () => {
  it('resolves the round solid FIRST, so the actor ends the tick clear of the WALL', () => {
    // Wedge the player where the two solids disagree: a pillar whose push is +y (south, deeper
    // into the wall) and a wall whose push is -y (north, back into the pillar). Only one of them
    // can be satisfied by a single pass, and which one is decided purely by call order.
    //
    //   pillar centre (800, 560) r=30      player clearance 16  ->  legal at y >= 606
    //   wall  y in [600, 664]              player clearance 16  ->  legal at y <= 584
    //
    // Obstacles-then-walls leaves y at 584 (clear of the wall, still inside the pillar).
    // Swapping the two calls leaves y at 606 instead — inside the wall.
    const s = world({
      players: [{ start: [800, 605] }],
      obstacles: [[800, 560, 30]] as const,
      walls: [[700, 600, 200, 64]] as const,
    });
    const p = s.players[0]!;
    new MovementSystem().tick(s);
    expect(p.gy).toBe(plus(px(600), -(PLAYER_BASE.solidRadius as number))); // tangent to the wall's north edge
    // ...and still overlapping the pillar, which is the price of the wall winning.
    const dy = (p.gy as number) - (px(560) as number);
    expect(Math.abs(dy)).toBeLessThan((PLAYER_BASE.solidRadius as number) + (px(30) as number));
  });

  it('re-separates from solids AFTER the pair shove, so nobody ends the tick inside a wall (v49)', () => {
    // Through v48 the pair pass was the last thing a tick did and nothing re-ran the wall pass,
    // so a crowd against a wall ended the tick inside the stone. That was pinned here as an
    // "accepted consequence of the ordering" on the belief it was corrected the following tick.
    // `engine/smoke.test.ts` measured it and it was not: two bodies pinned against a wall
    // re-apply the shove every tick, so the pair reaches a STABLE standoff inside the wall —
    // 103 consecutive ticks at up to 6 px deep on the launch arena.
    //
    // `MovementSystem.reseparateFromSolids` gives the solids the last word. The accepted trade
    // moved rather than disappeared, and it moved the right way per design/07: the two actors
    // may now overlap EACH OTHER a little more than the pair push intended. Overlapping a solid
    // "reads as sinking into it"; overlapping another actor "reads as a crowd".
    const s = world({ players: [{ start: [800, 605] }], walls: [[700, 600, 200, 64]] as const });
    const p = s.players[0]!;
    const e = enemyAt(s, px(800), px(578)); // north of the wall, clear of it, overlapping the player
    const tangent = plus(px(600), -(PLAYER_BASE.solidRadius as number));
    new MovementSystem().tick(s);
    expect(p.gy as number).toBeLessThanOrEqual(tangent as number); // clear of the wall at END of tick
    expect(e.gy as number).toBeLessThan(px(578) as number); // the enemy still took the other half
  });

  it('skips dead actors entirely — no integrate, no push, no pair', () => {
    const s = world();
    const p = s.players[0]!;
    const corpse = enemyAt(s, p.gx, p.gy); // exactly on top of the player
    corpse.alive = false;
    corpse.vx = toFp(1);
    corpse.knockVx = toFp(1);
    const before = { x: p.gx, y: p.gy };
    new MovementSystem().tick(s);
    expect(corpse.gx).toBe(before.x); // never integrated
    expect(corpse.knockVx).toBe(toFp(1)); // never decayed
    expect(p.gx).toBe(before.x); // and never paired against
    expect(p.gy).toBe(before.y);
  });
});

describe('resolveActorPairs — the feet circle, split in half, over every alive actor', () => {
  it('uses footprintRadius, not the solid clearance — two bodies may share a wall\'s worth of space', () => {
    // 20px apart: outside the combined FEET circle (2 x 7px), well inside the combined SOLID
    // clearance (2 x 16px). If this resolver ever picked up `blockingRadius` (as
    // `DoorSystem`/`DeathDropsSystem` picked up the wrong one in the other direction — see
    // state/actorRadius.ts) these two would shove each other apart every tick.
    const s = world({ players: [{ start: [800, 600] }, { start: [820, 600] }] });
    const [a, b] = [s.players[0]!, s.players[1]!];
    const gap = (b.gx as number) - (a.gx as number);
    expect(gap).toBeGreaterThanOrEqual((a.footprintRadius as number) + (b.footprintRadius as number));
    expect(gap).toBeLessThan((a.solidRadius as number) + (b.solidRadius as number));
    new MovementSystem().tick(s);
    expect(a.gx).toBe(px(800));
    expect(b.gx).toBe(px(820));
  });

  it('splits the penetration half each, the ODD unit going to the second actor', () => {
    // `a` takes `trunc(n/2)` and `b` takes the exact remainder, so the two halves always sum back
    // to the full push and no residual overlap is left standing. Enemy-vs-enemy, which has had a
    // faction exemption and then had it reverted (ENGINE_VERSION 42, "怪物之间要有碰撞").
    const s = world();
    const a = enemyAt(s, px(100), px(100), 100);
    const b = enemyAt(s, plus(px(100), 1), px(100), 101); // 1 fp apart: penetration 437, an odd number
    new MovementSystem().tick(s);
    expect(a.gx).toBe(plus(px(100), -218));
    expect(b.gx).toBe(plus(px(100), 219 + 1));
    // Exactly separated afterwards, with y untouched (the overlap was purely along x).
    expect((b.gx as number) - (a.gx as number)).toBe((a.footprintRadius as number) + (b.footprintRadius as number));
    expect(a.gy).toBe(px(100));
    expect(b.gy).toBe(px(100));
  });

  it('is ordered by ascending id, not by array position', () => {
    // The half-split above is asymmetric, so WHICH actor is `a` is observable. `state.enemies`
    // order is not a stable thing to depend on (spawn order, death compaction, co-op seat count),
    // hence the sort. Two states holding the same actors in opposite array order must land in
    // byte-identical positions, or two clients desync the moment their spawn order differs.
    function build(reversed: boolean): [EnemyActor, EnemyActor] {
      const s = world();
      const lo = buildEnemyActor(s, px(100), px(100));
      const hi = buildEnemyActor(s, plus(px(100), 1), px(100));
      lo.id = 100;
      hi.id = 101;
      s.enemies.push(...(reversed ? [hi, lo] : [lo, hi]));
      new MovementSystem().tick(s);
      return [lo, hi];
    }
    const [loA, hiA] = build(false);
    const [loB, hiB] = build(true);
    expect([loB.gx, loB.gy]).toEqual([loA.gx, loA.gy]);
    expect([hiB.gx, hiB.gy]).toEqual([hiA.gx, hiA.gy]);
    expect(loA.gx).toBe(plus(px(100), -218)); // and it is the LOW id that took the floor half
  });

  it('is a single sequential pass, not a solver — three stacked actors do not all separate', () => {
    // The i<j double loop resolves against already-moved positions (a-b, then a-c, then b-c), so
    // one tick is one relaxation step, not a converged solution. Stated as the honest contract:
    // a dense pile takes several ticks to open up. A future "loop until clear" change would need
    // an ENGINE_VERSION bump, and this is the test that would say so.
    const s = world();
    const a = enemyAt(s, px(100), px(100), 100);
    const b = enemyAt(s, px(101), px(100), 101);
    const c = enemyAt(s, px(102), px(100), 102);
    const minDist = (a.footprintRadius as number) + (b.footprintRadius as number);
    new MovementSystem().tick(s);
    const pairs: Array<[EnemyActor, EnemyActor]> = [
      [a, b],
      [a, c],
      [b, c],
    ];
    const stillOverlapping = pairs.filter(([x, y]) => Math.abs((x.gx as number) - (y.gx as number)) < minDist);
    expect(stillOverlapping.length).toBeGreaterThan(0); // one pass did not clear the pile
    // ...but it made progress: the outermost two are further apart than they started.
    expect((c.gx as number) - (a.gx as number)).toBeGreaterThan((px(102) as number) - (px(100) as number));
  });
});
