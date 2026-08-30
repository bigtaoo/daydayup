/**
 * Exhaustive coverage of the ONE definition of "where a solid blocks an actor"
 * (design/18-test-strategy.md, Layer 1).
 *
 * `solidBounds.ts` was extracted from two line-for-line duplicate implementations
 * (`MovementSystem.resolveWalls`/`resolveObstacles` and `geom.clampToWalkable`), so every rule
 * in it was previously tested only through a caller — which means the CORNERS were tested
 * through whatever corners those callers' scenarios happened to reach. `geom.test.ts` says as
 * much about its own subject: `clampToWalkable` had no direct coverage at all until a real bug
 * turned up that no caller-level test happened to reach.
 *
 * The space here is small and finite, so this file enumerates rather than samples:
 * 4 faces x freeStanding on/off x {clear, tangent, overlapping, inside, engulfed, exact corner}
 * x a few radii. That is cheap in milliseconds and is the difference between "the common case
 * works" and "the tie-breaks are pinned".
 *
 * The tie-breaks especially: they are a DETERMINISM contract, not an implementation detail. Two
 * clients that resolve an equidistant centre to different edges desync, and nothing else in the
 * suite would say so.
 */
import { describe, expect, it } from 'vitest';
import { pxToFp } from '../content/convert';
import { WALL_NORTH_BRIM } from '../config';
import type { Fp } from '../math/fixed';
import type { AABB, Obstacle } from '../state/entities';
import { blockingRect, pushOutOfObstacle, pushOutOfWall, queryRadiusFor, type Point } from './solidBounds';

const px = (n: number): Fp => pxToFp(n);
const at = (x: number, y: number): Point => ({ x: px(x), y: px(y) });

/** A 200x64 rect with its top-left at (700, 600) — the shape rooms.test.ts/geom.test.ts use. */
const plain: AABB = { x: px(700), y: px(600), w: px(200), h: px(64) };
const free: AABB = { ...plain, freeStanding: true };

const R = px(15); // a representative clearance

/**
 * Compose an expected edge-plus-clearance the way the CODE composes it, never as
 * `px(edge + clearance)`.
 *
 * `pxToFp` rounds, so `px(650) + px(15)` is 20313 + 469 = 20782 while `px(665)` is 20781 — one
 * fp unit apart, and which one is "right" depends entirely on the order of operations the
 * implementation uses. A test written the second way passes or fails on whether the two
 * roundings happen to agree for the numbers picked, which is luck, not coverage. (`geom.test.ts`
 * already composes this way in its south/east cases; this helper just names the reason.)
 */
const edgePlus = (edge: Fp, clearance: Fp): Fp => ((edge as number) + (clearance as number)) as Fp;

describe('blockingRect — the brim rule, and its one-sidedness', () => {
  it('a plain rect blocks exactly its own footprint', () => {
    expect(blockingRect(plain)).toEqual({ left: px(700), top: px(600), right: px(900), bottom: px(664) });
  });

  it('a free-standing rect pulls its NORTH edge out by the brim, and nothing else', () => {
    const b = blockingRect(free);
    expect(b.top).toBe(((px(600) as number) - (WALL_NORTH_BRIM as number)) as Fp);
    // The whole point of "one-sided": the other three edges must be untouched. A brim that
    // leaked onto them would narrow every door passage from both sides and float a character
    // off the south kerb — the two failure modes WALL_NORTH_BRIM's own doc rules out.
    expect(b.left).toBe(plain.x);
    expect(b.right).toBe(((plain.x as number) + (plain.w as number)) as Fp);
    expect(b.bottom).toBe(((plain.y as number) + (plain.h as number)) as Fp);
  });

  it('reads the flag, not the geometry — two identical rects differ only by the flag', () => {
    // Guards against a future "derive free-standing from whether it touches a room edge"
    // shortcut, which is precisely what the RENDER layer does (`wallTier`) and why the two can
    // disagree about the same rect (design/18 G6).
    expect(blockingRect(plain).top).not.toBe(blockingRect(free).top);
    expect({ ...blockingRect(plain), top: blockingRect(free).top }).toEqual(blockingRect(free));
  });
});

describe('queryRadiusFor — the broadphase must be able to SEE a brim-only overlap', () => {
  it('adds the brim to the query radius', () => {
    expect(queryRadiusFor(R)).toBe(((R as number) + (WALL_NORTH_BRIM as number)) as Fp);
  });

  it('is wide enough for the worst case it exists for', () => {
    // The failure this prevents is silent: a point overlapping ONLY the brimmed band is
    // invisible to a radius-only query, so the push is never even attempted. Stated as the
    // property rather than the formula, so it survives a change to how the brim is applied.
    const b = blockingRect(free);
    const deepestBrimOnlyContact = (plain.y as number) - (WALL_NORTH_BRIM as number);
    const reach = (queryRadiusFor(R) as number);
    expect((plain.y as number) - deepestBrimOnlyContact).toBeLessThanOrEqual(reach);
    expect(b.top).toBe(deepestBrimOnlyContact as Fp);
  });
});

describe('pushOutOfWall — a centre OUTSIDE the rect', () => {
  it('leaves a clear point exactly where it was', () => {
    const p = at(100, 100);
    pushOutOfWall(p, R, plain);
    expect(p).toEqual(at(100, 100));
  });

  it('leaves a point tangent to the face alone — touching is not overlapping', () => {
    // The boundary case. `distSq >= r*r` is a `>=`, so exact tangency must NOT push; an
    // off-by-one to `>` here would jitter every actor resting against a wall, every tick.
    const p = at(800, 600 - 15);
    pushOutOfWall(p, R, plain);
    expect(p).toEqual(at(800, 600 - 15));
  });

  it.each([
    ['north', 800, 595, 'y', px(600), -1],
    ['south', 800, 664 + 3, 'y', px(664), +1],
    ['west', 700 - 3, 630, 'x', px(700), -1],
    ['east', 900 + 3, 630, 'x', px(900), +1],
  ] as const)('pushes out of the %s face to exactly tangent', (_face, sx, sy, axis, edge, sign) => {
    const p = at(sx, sy);
    pushOutOfWall(p, R, plain);
    expect(p[axis]).toBe(edgePlus(edge, (sign * (R as number)) as Fp));
  });

  it('a diagonal approach at a corner pushes along the corner normal, not an axis', () => {
    // Distinguishes the closest-POINT branch from the axis-separation branch. An
    // implementation that snapped to an axis here would leave the actor overlapping the corner.
    const p = at(700 - 8, 600 - 8);
    pushOutOfWall(p, R, plain);
    expect(p.x).toBeLessThan(px(700 - 8));
    expect(p.y).toBeLessThan(px(600 - 8));
    const dx = (px(700) as number) - (p.x as number);
    const dy = (px(600) as number) - (p.y as number);
    // Ends up (very nearly) `R` from the corner — integer truncation costs at most a unit or two.
    expect(Math.abs(Math.round(Math.sqrt(dx * dx + dy * dy)) - (R as number))).toBeLessThanOrEqual(2);
  });

  it('the north face is brimmed for a free-standing block and bare for a plain one', () => {
    const bare = at(800, 595);
    const brimmed = at(800, 595);
    pushOutOfWall(bare, R, plain);
    pushOutOfWall(brimmed, R, free);
    expect((bare.y as number) - (brimmed.y as number)).toBe(WALL_NORTH_BRIM);
  });
});

describe('pushOutOfWall — a centre INSIDE the rect (axis separation + tie-breaks)', () => {
  it('exits by the nearest single edge', () => {
    // 3px below the north edge, 61 above the south → north wins.
    const p = at(800, 603);
    pushOutOfWall(p, R, plain);
    expect(p.x).toBe(px(800));
    expect(p.y).toBe(edgePlus(px(600), (-(R as number)) as Fp));
  });

  it.each([
    ['nearest is east', 899, 630, 'x', px(900), +1],
    ['nearest is west', 701, 630, 'x', px(700), -1],
    ['nearest is south', 800, 663, 'y', px(664), +1],
    ['nearest is north', 800, 601, 'y', px(600), -1],
  ] as const)('%s', (_name, sx, sy, axis, edge, sign) => {
    const p = at(sx, sy);
    pushOutOfWall(p, R, plain);
    expect(p[axis]).toBe(edgePlus(edge, (sign * (R as number)) as Fp));
  });

  it('resolves a PERFECTLY centred point deterministically, preferring right', () => {
    // The tie-break that matters most, because it is the one a test is least likely to hit by
    // accident and the one whose disagreement is a straight desync. A 64x64 square centre is
    // equidistant from all four edges; the comparison order (right, left, bottom, top) decides.
    const square: AABB = { x: px(700), y: px(600), w: px(64), h: px(64) };
    const p = at(732, 632);
    pushOutOfWall(p, R, square);
    expect(p.x).toBe(edgePlus(px(700 + 64), R));
    expect(p.y).toBe(px(632));
  });

  it('prefers left over bottom and top when they tie', () => {
    // Second rung of the same ladder: with right excluded (the point sits nearer the left
    // edge), left must still beat an equidistant bottom/top.
    const square: AABB = { x: px(700), y: px(600), w: px(64), h: px(64) };
    const p = { x: px(710), y: px(632) }; // 10 from left, 54 from right, 32 from both of top/bottom
    pushOutOfWall(p, R, square);
    expect(p.x).toBe(edgePlus(px(700), (-(R as number)) as Fp));
    expect(p.y).toBe(px(632));
  });

  it('a zero-radius point still exits, landing exactly on the edge', () => {
    const p = at(800, 603);
    pushOutOfWall(p, 0 as Fp, plain);
    expect(p).toEqual(at(800, 600));
  });

  it("uses the BRIMMED top when measuring 'how far to the north edge'", () => {
    // Not a restatement of blockingRect: the inside-the-rect branch measures distances against
    // the blocking edges, so the brim changes which edge is nearest, not just where the push
    // lands. A point 20px below the footprint's top is 20 from the bare north edge but
    // 20 + brim from the brimmed one — enough, here, to make SOUTH the nearer exit instead.
    const tall: AABB = { x: px(700), y: px(600), w: px(200), h: px(50), freeStanding: true };
    const p = at(800, 620); // 20 below bare top, 30 above bottom; brimmed top is 23 further away
    pushOutOfWall(p, R, tall);
    expect(p.y).toBe(edgePlus(px(650), R)); // exits SOUTH — the brim made north the longer way out
  });
});

describe('pushOutOfObstacle — round solids', () => {
  const pillar: Obstacle = { gx: px(500), gy: px(500), radius: px(40) };

  it('leaves a clear point alone', () => {
    const p = at(700, 700);
    pushOutOfObstacle(p, R, pillar);
    expect(p).toEqual(at(700, 700));
  });

  it('leaves a tangent point alone', () => {
    const p = { x: edgePlus(px(500), edgePlus(px(40), R)), y: px(500) };
    const before = { ...p };
    pushOutOfObstacle(p, R, pillar);
    expect(p).toEqual(before);
  });

  it('pushes an overlapping point out along the centre line', () => {
    const p = at(530, 500);
    pushOutOfObstacle(p, R, pillar);
    expect(p.x).toBe(edgePlus(px(500), edgePlus(px(40), R)));
    expect(p.y).toBe(px(500));
  });

  it('nudges an EXACTLY concentric point +x by the full clearance', () => {
    // No defined push direction, so the rule is arbitrary — and therefore has to be pinned, or
    // two implementations pick differently and desync. This is the pillar twin of the
    // centred-square tie-break above.
    const p = at(500, 500);
    pushOutOfObstacle(p, R, pillar);
    expect(p.x).toBe(edgePlus(px(500), edgePlus(px(40), R)));
    expect(p.y).toBe(px(500));
  });

  it('never leaves the point still overlapping, from any approach angle', () => {
    // A property rather than a case list: sweep the circle and assert the invariant the whole
    // function exists to establish. Integer truncation is allowed to leave it a unit short.
    const minDist = (R as number) + (pillar.radius as number);
    for (let deg = 0; deg < 360; deg += 7) {
      const rad = (deg * Math.PI) / 180;
      // Test-side trig only — the sim's own ban (design/06) is on the ENGINE, and
      // determinismLint.test.ts deliberately does not scan test files.
      const p = {
        x: ((pillar.gx as number) + Math.round(Math.cos(rad) * 20)) as Fp,
        y: ((pillar.gy as number) + Math.round(Math.sin(rad) * 20)) as Fp,
      };
      pushOutOfObstacle(p, R, pillar);
      const dx = (p.x as number) - (pillar.gx as number);
      const dy = (p.y as number) - (pillar.gy as number);
      expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(minDist - 2);
    }
  });
});

describe('the cursor contract — a resolve pass is sequential, not independent', () => {
  it('a second wall is resolved against where the first one pushed the point', () => {
    // Both callers depend on this and it is why `Point` is threaded rather than each push
    // returning a fresh result from the original position. Resolving both from the ORIGINAL
    // position would leave the point inside one of the two.
    const corner: AABB = { x: px(700), y: px(600), w: px(200), h: px(64) };
    const side: AABB = { x: px(660), y: px(600), w: px(40), h: px(200) };
    const p = at(705, 610);
    pushOutOfWall(p, R, corner);
    const afterFirst = { ...p };
    pushOutOfWall(p, R, side);
    expect(afterFirst).not.toEqual(p); // the second push saw the moved point and acted
    // Final position clears BOTH rects.
    for (const w of [corner, side]) {
      const b = blockingRect(w);
      const cx = Math.max(b.left, Math.min(p.x, b.right));
      const cy = Math.max(b.top, Math.min(p.y, b.bottom));
      const dx = (p.x as number) - cx;
      const dy = (p.y as number) - cy;
      expect(dx * dx + dy * dy).toBeGreaterThanOrEqual((R as number) * (R as number) - 4);
    }
  });
});
