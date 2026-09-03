/**
 * Standing spacing (ENGINE_VERSION 55) — the two-volume rule, driven through the REAL
 * AIDecideSystem + MovementSystem pair rather than either in isolation, because the whole
 * feature is a composition: AIDecide decides a mob has ARRIVED (`holding`), Movement is what
 * spreads the arrived ones apart, and the interesting failures are all in the seam.
 *
 * Live report, 2026-09-03 (screenshot: three mobs fused into a single silhouette, two health
 * bars drawn across a third body): *"怪物寻路时要加一个停留体积，最好是两倍于怪物的体型，这样
 * 怪物才会分散。这里是两个概念，一个是寻路体积，一个是终点停留时的体积。比如一个窄缝，只有1.5
 * 个怪物体积大，怪物寻路时，1倍的寻路体积，正常通过。然后停留时，2倍的停留体积，其他的怪就离他
 * 很远了"*.
 *
 * That report is two assertions, not one, and they pull in opposite directions — so both
 * halves are pinned here:
 *
 *   - STANDING mobs claim two body radii each and end up four apart;
 *   - TRAVELLING mobs claim nothing beyond their body, so a 1.5-body gap stays passable and
 *     a mob walking past a standing one is not deflected by it.
 *
 * A test that only measured the first half would pass just as well against the naive fix
 * (a bigger radius in `resolveActorPairs`), which is exactly the fix the report rules out.
 */
import { describe, it, expect } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { GameState } from '@dd/engine/state/GameState';
import { buildEnemyActor, DEFAULT_ENEMY_ENGAGE_RANGE_FP } from '@dd/engine/content/enemies';
import { standoffRadius } from '@dd/engine/state/actorRadius';
import type { EnemyActor } from '@dd/engine/state/entities';
import { AIDecideSystem, MovementSystem } from '@dd/engine/systems';
import { pxToFp } from '@dd/engine/content/convert';
import { HOLD_RELEASE_PERMILLE } from '@dd/engine/balance/encounter';
import type { Fp } from '@dd/engine/math/fixed';

const CFG = { seed: 7, worldW: 3200, worldH: 2400, waves: [] as const };

function run(s: GameState, ticks: number): void {
  const ai = new AIDecideSystem();
  const mv = new MovementSystem();
  for (let i = 0; i < ticks; i++) {
    ai.tick(s);
    mv.tick(s);
  }
}

function dist(a: { gx: number; gy: number }, b: { gx: number; gy: number }): number {
  return Math.hypot(a.gx - b.gx, a.gy - b.gy);
}

/** A mob that has already noticed the player — same convention as enemyChase.test.ts, so
 *  these tests are about arrival and spacing rather than about the perception radius. */
function spawnAware(s: GameState, xpx: number, ypx: number, type = 'basic'): EnemyActor {
  const e = buildEnemyActor(s, pxToFp(xpx), pxToFp(ypx), type);
  e.aggroed = true;
  s.enemies.push(e);
  return e;
}

describe('standing spacing — mobs that have ARRIVED spread out (ENGINE_VERSION 55)', () => {
  it('two mobs that stop next to each other drift apart to four body radii and settle there', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const a = spawnAware(s, 500, 300);
    const b = spawnAware(s, 515, 300);
    // Both start well inside engage range, i.e. already ARRIVED — this is the blob the
    // report screenshotted (15 px apart, half of one body's 30 px width).
    expect(dist(a, b)).toBeLessThan(pxToFp(20));

    const midBefore = (a.gx + b.gx) / 2;
    run(s, 90);

    const want = standoffRadius(a) + standoffRadius(b); // 2·15px + 2·15px = 60px between centres
    expect(a.holding).toBe(true);
    expect(b.holding).toBe(true);
    // EXACTLY the standoff, not "somewhere past it". The push is the remaining penetration
    // (capped), so the last step is the small one that closes the gap — a mutant that pushes
    // the full separation every tick instead settles ~2 px past this and is invisible to any
    // assertion written with px-scale slack, which is how it survived the first battery.
    expect(dist(a, b)).toBe(want);
    // Half the push each, so the PAIR stays where it was and neither mob is the one that
    // gets shoved: the midpoint moves only by the 1 fp floor/remainder tie-break.
    expect(Math.abs((a.gx + b.gx) / 2 - midBefore)).toBeLessThanOrEqual(1);

    // Stable: another 90 ticks neither drifts further nor oscillates back in.
    run(s, 90);
    expect(dist(a, b)).toBe(want);
  });

  it('the standoff is two body radii, so a bigger mob claims proportionally more room', () => {
    // The multiple is DATA (`STANDOFF_BODY_MULTIPLE`), and every other test here derives its
    // expectation from `standoffRadius` — which moves with the data and therefore cannot pin
    // it. This one states the number, and the brute case states that it is a multiple of the
    // mob's OWN body rather than one shared constant.
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const basic = spawnAware(s, 500, 300);
    const brute = spawnAware(s, 500, 900, 'brute');
    expect(standoffRadius(basic)).toBe(basic.radius * 2);
    expect(standoffRadius(basic)).toBe(pxToFp(30)); // 2 × the 15 px body
    expect(standoffRadius(brute)).toBe(pxToFp(40)); // 2 × the 20 px body — its own, not basic's
    expect(standoffRadius(brute)).toBeGreaterThan(standoffRadius(basic));

    // And it reads through to where two of each actually stop.
    const pair = (type: string, y: number): number => {
      const st = createGameState({ ...CFG, players: [{ start: [400, y] }] });
      const [p, q] = [spawnAware(st, 500, y, type), spawnAware(st, 515, y, type)];
      run(st, 90);
      return dist(p, q);
    };
    expect(pair('brute', 300)).toBeGreaterThan(pair('basic', 300));
  });

  it('mobs stop reserving standing room once there is no target left to stand off from', () => {
    // `holding` is not a latch. A pair that has arrived and is still mid-spread when the
    // player dies must stop where it is, not keep shuffling around an absent target.
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const a = spawnAware(s, 500, 300);
    const b = spawnAware(s, 508, 300);
    run(s, 2); // arrived and holding, but nowhere near the standoff yet
    expect(a.holding).toBe(true);
    expect(dist(a, b)).toBeLessThan(standoffRadius(a) + standoffRadius(b));

    s.players[0]!.alive = false;
    run(s, 1);
    expect(a.holding).toBe(false);
    expect(b.holding).toBe(false);

    const rest = [{ gx: a.gx, gy: a.gy }, { gx: b.gx, gy: b.gy }];
    run(s, 60);
    expect([{ gx: a.gx, gy: a.gy }, { gx: b.gx, gy: b.gy }]).toEqual(rest);
  });

  it('the spread is a shuffle, not a shove: no mob is displaced faster than it can walk', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    // Five mobs in a tight column, every one of them accumulating a push from four
    // neighbours at once — the worst case for the per-actor cap. They start 20 px apart:
    // clear of the 14 px feet-circle collision (whose push is deliberately uncapped and
    // would otherwise be what this measured) but deep inside each other's 60 px standoff,
    // so every pixel of movement below belongs to the spacing pass. Spread along the
    // column, i.e. across the line to the player, so nobody is pushed onto it.
    const mobs = [-40, -20, 0, 20, 40].map((d) => spawnAware(s, 560, 300 + d));
    const ai = new AIDecideSystem();
    const mv = new MovementSystem();
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      const before = mobs.map((m) => ({ gx: m.gx, gy: m.gy }));
      ai.tick(s);
      mv.tick(s);
      for (let k = 0; k < mobs.length; k++) worst = Math.max(worst, dist(mobs[k]!, before[k]!));
    }
    // Every mob is holding (vx/vy are 0) and none of them ever touched another's feet
    // circle, so all of the movement measured above came from the spacing pass — and the
    // per-actor cap is what keeps the mob in the middle of the press from being launched by
    // the sum of its four neighbours.
    for (let i = 0; i < mobs.length; i++) {
      for (let j = i + 1; j < mobs.length; j++) {
        expect(dist(mobs[i]!, mobs[j]!)).toBeGreaterThan(
          mobs[i]!.footprintRadius + mobs[j]!.footprintRadius,
        );
      }
    }
    for (const m of mobs) expect(m.holding).toBe(true);
    expect(worst).toBeLessThanOrEqual(mobs[0]!.moveSpeedPerTick!);
    // …and it did the job anyway: the stack became five separate, countable bodies.
    for (let i = 0; i < mobs.length; i++) {
      for (let j = i + 1; j < mobs.length; j++) {
        expect(dist(mobs[i]!, mobs[j]!)).toBeGreaterThan(pxToFp(28)); // ≥ one body apart
      }
    }
  });

  it('a mob that is still TRAVELLING is neither pushed by a standing mob nor pushes one', () => {
    // The half of the report a "just make the collision radius bigger" fix would break. The
    // chaser's route brushes past the stander at a distance the two rules disagree about —
    // inside the 60 px standoff, outside the 14 px feet-circle collision — so the ONLY thing
    // that could deflect it there is the new rule, and it must not. Measured below rather
    // than asserted from the geometry, since a route that never actually came close would
    // make the whole test vacuous.
    const withStander = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const stander = spawnAware(withStander, 400, 480); // 180 px south of the player: arrived
    const chaser = spawnAware(withStander, 520, 900); // far south, still closing, passing east of it
    const control = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const soloChaser = spawnAware(control, 520, 900);

    const standerStart = { gx: stander.gx, gy: stander.gy };
    let travelled = 0;
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 300; i++) {
      run(withStander, 1);
      run(control, 1);
      if (!chaser.holding) {
        // Tick for tick, the chaser's route is the one it would have taken through an empty
        // room — the stander's personal space is not in its way.
        expect([chaser.gx, chaser.gy]).toEqual([soloChaser.gx, soloChaser.gy]);
        // The traffic does not shove the stander off its spot either: the rule is symmetric,
        // a travelling mob neither receives nor exerts a standing push.
        expect({ gx: stander.gx, gy: stander.gy }).toEqual(standerStart);
        travelled++;
        closest = Math.min(closest, dist(chaser, stander));
      }
    }
    expect(travelled).toBeGreaterThan(100); // the comparison above ran over a real journey
    // …and that journey really did cross the standoff circle without being nudged by it.
    expect(closest).toBeLessThan(standoffRadius(chaser) + standoffRadius(stander));
    expect(closest).toBeGreaterThan(chaser.footprintRadius + stander.footprintRadius);
    expect(stander.holding).toBe(true);
    expect(chaser.holding).toBe(true); // it did arrive, so the run was not vacuous
    // And the moment it did, the same two mobs that ignored each other all the way across
    // the room started keeping their distance — the flag, not the geometry, is the switch.
    expect({ gx: stander.gx, gy: stander.gy }).not.toEqual(standerStart);
    expect(dist(chaser, stander)).toBeGreaterThan(closest);
  });

  it('a gap only 1.5 bodies wide is still walked through with a mob standing at its mouth', () => {
    const GAP_PX = 45; // 1.5 × a basic mob's 30 px body width — the report's own example
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 300] }],
      walls: [
        [600, 0, 40, 300 - GAP_PX / 2],
        [600, 300 + GAP_PX / 2, 40, 600],
      ] as const,
    });
    // Standing right at the west mouth of the gap, close enough that its standoff circle
    // covers the whole opening.
    const stander = spawnAware(s, 555, 300);
    const traveller = spawnAware(s, 900, 300);

    run(s, 400);

    expect(stander.holding).toBe(true);
    expect(traveller.gx).toBeLessThan(pxToFp(600)); // through the gap, onto the player's side
    expect(traveller.holding).toBe(true); // and all the way into engage range
    // Having arrived, it now DOES take its own standing room next to the stander.
    expect(dist(stander, traveller)).toBeGreaterThanOrEqual(
      standoffRadius(stander) + standoffRadius(traveller) - pxToFp(2),
    );
  });

  it('the player is never pushed by a mob standing near it — the bubble is between mobs only', () => {
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const p = s.players[0]!;
    const a = spawnAware(s, 470, 300);
    const b = spawnAware(s, 485, 300);
    const before = { gx: p.gx, gy: p.gy };

    run(s, 90);

    // a is spread WEST, to well inside b's standoff distance of the player, and the player
    // still has not budged: an enemy's personal space is not a force field against the one
    // actor whose movement is supposed to be entirely the player's own.
    expect(a.gx).toBeLessThan(pxToFp(470));
    expect(dist(a, p)).toBeLessThan(standoffRadius(a) + standoffRadius(b));
    expect({ gx: p.gx, gy: p.gy }).toEqual(before);
  });

  it('a mob nudged just outside engage range keeps holding (and keeps shooting) instead of re-closing', () => {
    // Hysteresis. Both mobs stop ON the engage ring, then space each other OUTWARD past it.
    // With a bare threshold each would immediately re-chase, be pushed out again, and shuffle
    // there forever with its gun stuttering on and off — so this measures the gun too.
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    const range = DEFAULT_ENEMY_ENGAGE_RANGE_FP;
    // Lined up ALONG the radius rather than across it, so the spacing they apply to each
    // other is the one direction that actually crosses the engage ring: the outer mob is
    // pushed further out, the inner one further in.
    const inner = spawnAware(s, 400 + 150, 300);
    const outer = spawnAware(s, 400 + 165, 300);

    run(s, 90);

    expect(dist(inner, s.players[0]!)).toBeLessThan(range); // the pair straddles the ring
    for (const e of [outer]) {
      expect(dist(e, s.players[0]!)).toBeGreaterThan(range); // pushed outside the ring…
      expect(e.holding).toBe(true); // …and staying put anyway
      expect(e.vx).toBe(0);
      expect(e.vy).toBe(0);
      expect(e.firing).toBe(true); // still contending for a fire slot: no stutter
    }
    // The stickiness is bounded, not a leash: a player who actually leaves puts the mob
    // back on the move.
    s.players[0]!.gx = (s.players[0]!.gx - range * 2) as Fp;
    run(s, 1);
    expect(outer.holding).toBe(false);
    expect(outer.vx).not.toBe(0);
    // The release radius is the wider one, so a player who steps just past the ring does NOT
    // restart the chase.
    expect(Math.trunc((range * HOLD_RELEASE_PERMILLE) / 1000)).toBeGreaterThan(range);
  });

  it('a solid still gets the last word: crowded mobs stop spreading rather than back into a wall', () => {
    const s = createGameState({
      ...CFG,
      players: [{ start: [400, 300] }],
      walls: [[520, 0, 40, 600]] as const, // a wall just east of where the pair will stand
    });
    const a = spawnAware(s, 500, 300);
    const b = spawnAware(s, 505, 310);

    run(s, 120);

    const wall = s.walls[0]!;
    for (const e of [a, b]) {
      expect(e.gx + e.solidRadius).toBeLessThanOrEqual(wall.x + 1); // never inside the stone
      expect(e.alive).toBe(true);
    }
    expect(dist(a, b)).toBeGreaterThan(pxToFp(20)); // it still separated them, just along the wall
  });

  it('mobs that have not noticed the player keep the spots they were authored on', () => {
    // Spacing is a property of having ARRIVED somewhere, not of standing still. An inert
    // garrison must not slowly slide away from the positions a level authored for it.
    const s = createGameState({ ...CFG, players: [{ start: [400, 300] }] });
    // 20 px apart: clear of the feet-circle collision (which would legitimately move them
    // and has nothing to do with this rule), well inside the 60 px standoff.
    const a = buildEnemyActor(s, pxToFp(2000), pxToFp(2000), 'basic'); // far outside aggro range
    const b = buildEnemyActor(s, pxToFp(2020), pxToFp(2000), 'basic');
    s.enemies.push(a, b);
    const placed = [
      { gx: a.gx, gy: a.gy },
      { gx: b.gx, gy: b.gy },
    ];

    run(s, 120);

    expect(a.holding).toBe(false);
    expect(b.holding).toBe(false);
    expect([
      { gx: a.gx, gy: a.gy },
      { gx: b.gx, gy: b.gy },
    ]).toEqual(placed);
  });
});
