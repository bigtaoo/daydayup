/**
 * Direct, focused coverage of the pure per-tick ballistic-shape helpers (design/03/
 * 09 Frame axis, ROADMAP 1.1). `systems/ballistics.test.ts` already covers these
 * transitively through ProjectileStepSystem/HitResolveSystem per-tick trajectory
 * assertions; this file table-drives the functions themselves — angle wraparound
 * for `orbitStep`, edge cases for `inBeamLine`.
 */
import { describe, it, expect } from 'vitest';
import { toFp, mulFp, type Fp } from '@dd/engine/math/fixed';
import { cosFp, sinFp, atan2Brad, bradDiff, normBrad, type Brad } from '@dd/engine/math/trig';
import { radialDir, orbitStep, turnToward, inBlastRadius, inBeamLine } from '@dd/engine/content/ballistics';

describe('radialDir — even ring placement, deterministic (no PRNG)', () => {
  it('pellet 0 always fires straight along facing', () => {
    expect(radialDir(0 as Brad, 0, 4)).toBe(0);
    expect(radialDir(12345 as Brad, 0, 6)).toBe(12345);
  });

  it.each([
    [4, 0, 0],
    [4, 1, 16384],
    [4, 2, 32768],
    [4, 3, 49152],
    [3, 1, 21845], // floor(65536/3) = 21845
    [3, 2, 43690],
  ] as const)('count=%i, i=%i → facing(0) + step = %i', (count, i, expected) => {
    expect(radialDir(0 as Brad, i, count)).toBe(expected);
  });

  it('wraps around the full circle when facing + step exceeds 65536', () => {
    // facing=60000, count=4, i=3 → step = floor(65536*3/4) = 49152; 60000+49152 = 109152,
    // which wraps to 109152 - 65536 = 43616.
    expect(radialDir(60000 as Brad, 3, 4)).toBe(43616);
  });

  it('is a pure function of (facing, i, count) — same inputs, same output', () => {
    expect(radialDir(5000 as Brad, 2, 5)).toBe(radialDir(5000 as Brad, 2, 5));
  });
});

describe('orbitStep — angle advance + position on the orbit circle', () => {
  it('advances the angle by angularVelBrad and places the position at (owner + radius·(cos,sin))', () => {
    const ownerX = toFp(10);
    const ownerY = toFp(20);
    const radius = toFp(5);
    const result = orbitStep(ownerX, ownerY, 0 as Brad, 1000, radius);
    expect(result.angle).toBe(1000);
    expect(result.x).toBe((ownerX + mulFp(cosFp(1000), radius)) as Fp);
    expect(result.y).toBe((ownerY + mulFp(sinFp(1000), radius)) as Fp);
  });

  it('wraps forward past the top of the circle (65536 → 0)', () => {
    const result = orbitStep(toFp(0), toFp(0), 65530 as Brad, 10, toFp(1));
    expect(result.angle).toBe(4); // (65530 + 10) mod 65536
  });

  it('wraps backward past zero on a negative angular velocity', () => {
    const result = orbitStep(toFp(0), toFp(0), 0 as Brad, -100, toFp(1));
    expect(result.angle).toBe(65436); // normBrad(-100)
  });

  it('re-centres absolutely on a moved owner rather than accumulating a relative offset', () => {
    const a = orbitStep(toFp(0), toFp(0), 0 as Brad, 0, toFp(3));
    const b = orbitStep(toFp(50), toFp(0), 0 as Brad, 0, toFp(3));
    expect((b.x - a.x) as number).toBe(toFp(50) as number); // shifted by exactly the owner's move
  });

  it('a full-circle advance (65536) returns to the same angle', () => {
    const result = orbitStep(toFp(0), toFp(0), 1000 as Brad, 65536, toFp(1));
    expect(result.angle).toBe(1000);
  });
});

describe('turnToward — clamped rotation toward a target, speed preserved', () => {
  it('turns exactly onto the target when the required turn is within turnRateBrad', () => {
    const speed = toFp(10);
    // Currently flying along +x (vx>0, vy=0); target sits due "north" of the origin —
    // desired angle is BRAD_QUARTER (16384) — well within a generous turnRateBrad.
    const result = turnToward(speed, toFp(0), speed, toFp(0), toFp(100), toFp(0), toFp(0), 20000);
    const desired = atan2Brad(toFp(100), toFp(0));
    expect(result.vx).toBe(mulFp(cosFp(desired), speed));
    expect(result.vy).toBe(mulFp(sinFp(desired), speed));
  });

  it('clamps the turn to at most turnRateBrad when the required turn is larger', () => {
    const speed = toFp(10);
    const turnRate = 100; // very slow turning
    const result = turnToward(speed, toFp(0), speed, toFp(0), toFp(100), toFp(0), toFp(0), turnRate);
    const newAngle = atan2Brad(result.vy, result.vx);
    // Turned toward the target (away from 0) but not all the way — clamped by turnRate
    // (± fp-trig table rounding through the cos/sin → atan2Brad round-trip).
    expect(Math.abs(bradDiff(newAngle, 0 as Brad) - turnRate)).toBeLessThan(20);
    expect(bradDiff(newAngle, 0 as Brad)).toBeLessThan(16384); // nowhere close to the full 90° desired turn
  });

  it('preserves speed (magnitude) while turning', () => {
    const speed = toFp(7);
    const result = turnToward(speed, toFp(0), speed, toFp(-50), toFp(80), toFp(0), toFp(0), 5000);
    const mag = Math.round(Math.sqrt((result.vx as number) ** 2 + (result.vy as number) ** 2));
    expect(Math.abs(mag - (speed as number))).toBeLessThan(20); // fp-trig table rounding only
  });

  it('does not turn at all when already pointed exactly at the target', () => {
    const speed = toFp(10);
    // Flying along +x; target directly ahead on the same ray from (0,0).
    const result = turnToward(speed, toFp(0), speed, toFp(50), toFp(0), toFp(0), toFp(0), 5000);
    expect(result.vx).toBe(mulFp(cosFp(0 as Brad), speed));
    expect(result.vy).toBe(mulFp(sinFp(0 as Brad), speed));
  });
});

describe('inBlastRadius — landing-point AoE reach test', () => {
  it.each([
    // [actorDx, actorDy, actorRadius, blastRadius, expected]
    [0, 0, 5, 10, true], // dead centre
    [10, 0, 0, 10, true], // exactly at the boundary (inclusive)
    [11, 0, 0, 10, false], // just past the boundary
    [8, 6, 0, 10, true], // 10 away diagonally (3-4-5 triangle ×2) — on the boundary
    [8, 6, 1, 9, true], // actor's own radius extends the reach to exactly 10
  ] as const)('actor offset (%i,%i) radius %i, blast %i → %s', (dx, dy, r, blast, expected) => {
    expect(inBlastRadius(toFp(0), toFp(0), toFp(dx), toFp(dy), toFp(r), toFp(blast))).toBe(expected);
  });
});

describe('inBeamLine — hitscan reach + narrow-arc test', () => {
  const ORIGIN_X = toFp(0);
  const ORIGIN_Y = toFp(0);
  const RANGE = toFp(100);

  it('hits an actor directly ahead, within range, along the beam direction', () => {
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, 0 as Brad, RANGE, toFp(50), toFp(0), toFp(0))).toBe(true);
  });

  it('misses an actor beyond range even if perfectly aligned', () => {
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, 0 as Brad, RANGE, toFp(150), toFp(0), toFp(0))).toBe(false);
  });

  it('an actor radius extends the reach exactly like inBlastRadius', () => {
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, 0 as Brad, RANGE, toFp(105), toFp(0), toFp(6))).toBe(true);
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, 0 as Brad, RANGE, toFp(107), toFp(0), toFp(6))).toBe(false);
  });

  it('misses an actor within range but off the line (perpendicular)', () => {
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, 0 as Brad, RANGE, toFp(0), toFp(50), toFp(0))).toBe(false);
  });

  it('hits an actor slightly off-axis but within the half-angle width', () => {
    // ~1° off, well inside the ~8.2° (1500 brad) half-width.
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, 0 as Brad, RANGE, toFp(50), toFp(1), toFp(0))).toBe(true);
  });

  it('misses an actor beyond the half-angle even though within range', () => {
    // 90° off-axis (BRAD_QUARTER = 16384), far outside the narrow beam width.
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, 0 as Brad, RANGE, toFp(0), toFp(50), toFp(0))).toBe(false);
    // A shallow but still-too-wide angle: dx=50, dy=15 → atan2 ≈ 16.7°, beyond ~8.2°.
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, 0 as Brad, RANGE, toFp(50), toFp(15), toFp(0))).toBe(false);
  });

  it('handles a beam direction that wraps through 0 (dir near the top of the circle)', () => {
    const dirNearWrap = normBrad(-500); // 65036 brad, ~-2.75°
    // An actor 1° off the true (unwrapped) direction — bradDiff must see this as a
    // small signed difference, not a huge unsigned one, despite the wraparound.
    expect(inBeamLine(ORIGIN_X, ORIGIN_Y, dirNearWrap, RANGE, toFp(50), toFp(-1), toFp(0))).toBe(true);
  });
});
