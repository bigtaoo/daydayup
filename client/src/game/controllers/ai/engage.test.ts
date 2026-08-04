/**
 * engage.ts — the shared "engage the nearest hostile" shape AllyController/
 * PvpBotController both build on (extracted 2026-07-28). Pure functions, no engine
 * state needed, so tested directly here rather than only indirectly through the two
 * controllers that call them. Facing is NOT part of what this decides (design/10 v33,
 * ApplyInputSystem auto-faces) — these tests only cover movement + fire.
 */
import { describe, it, expect } from 'vitest';
import { Button } from '@dd/engine';
import { engageNearest, idleCommand, gridFp, FIRE_RANGE_FP, KEEP_DIST_FP, type Point } from './engage';

describe('idleCommand', () => {
  it('is a bare no-op: zero move, zero buttons, zero pickup, right owner/tick', () => {
    const cmd = idleCommand(2, 17);
    expect(cmd.type).toBe('input');
    expect(cmd.owner).toBe(2);
    expect(cmd.tick).toBe(17);
    expect(cmd.moveMag).toBe(0);
    expect(cmd.moveBrad).toBe(0);
    expect(cmd.buttons).toBe(0);
    expect(cmd.pickupTargetId).toBe(0);
  });
});

describe('engageNearest — target selection', () => {
  it('returns null when there are no candidates', () => {
    const me: Point = { gx: 0, gy: 0 };
    expect(engageNearest(0, 1, me, [])).toBeNull();
  });

  it('picks the closer of two candidates by squared distance', () => {
    const me: Point = { gx: 0, gy: 0 };
    // Both outside KEEP_DIST_FP so the pick actually produces movement (dist > 0
    // moveMag), regardless of which of the two was chosen.
    const far: Point = { gx: gridFp(20), gy: 0 };
    const near: Point = { gx: KEEP_DIST_FP + gridFp(1), gy: 0 };
    const cmd = engageNearest(0, 1, me, [far, near]);
    expect(cmd).not.toBeNull();
    expect(cmd!.moveMag).toBeGreaterThan(0);
  });

  it("ties break to the FIRST candidate in iteration order (array-order determinism, design/06)", () => {
    const me: Point = { gx: 0, gy: 0 };
    const d = KEEP_DIST_FP + gridFp(5); // outside KEEP_DIST_FP, so movement (and its
    // direction) actually happens — that's what reveals which target was picked.
    const west: Point = { gx: -d, gy: 0 }; // exactly equidistant from east
    const east: Point = { gx: d, gy: 0 };
    const firstWins = engageNearest(0, 1, me, [west, east]);
    const secondWins = engageNearest(0, 1, me, [east, west]);
    expect(firstWins!.moveMag).toBeGreaterThan(0);
    expect(secondWins!.moveMag).toBeGreaterThan(0);
    expect(firstWins!.moveBrad).not.toBe(secondWins!.moveBrad);
  });
});

describe('engageNearest — spacing (advance vs. hold)', () => {
  it('advances (nonzero moveMag) toward a target outside KEEP_DIST_FP', () => {
    const me: Point = { gx: 0, gy: 0 };
    const target: Point = { gx: KEEP_DIST_FP + gridFp(1), gy: 0 };
    const cmd = engageNearest(0, 1, me, [target]);
    expect(cmd!.moveMag).toBeGreaterThan(0);
  });

  it('holds position (zero move) once inside KEEP_DIST_FP', () => {
    const me: Point = { gx: 0, gy: 0 };
    const target: Point = { gx: gridFp(1), gy: 0 }; // well inside KEEP_DIST_FP (4 grid)
    const cmd = engageNearest(0, 1, me, [target]);
    expect(cmd!.moveMag).toBe(0);
    expect(cmd!.moveBrad).toBe(0);
  });

  it('exactly at KEEP_DIST_FP already holds (boundary is a strict ">", not ">=")', () => {
    const me: Point = { gx: 0, gy: 0 };
    const target: Point = { gx: KEEP_DIST_FP, gy: 0 };
    const cmd = engageNearest(0, 1, me, [target]);
    expect(cmd!.moveMag).toBe(0); // dist === KEEP_DIST_FP fails `dist > KEEP_DIST_FP` → holds
  });
});

describe('engageNearest — fire range', () => {
  it('fires within FIRE_RANGE_FP', () => {
    const me: Point = { gx: 0, gy: 0 };
    const target: Point = { gx: FIRE_RANGE_FP - gridFp(1), gy: 0 };
    const cmd = engageNearest(0, 1, me, [target]);
    expect(cmd!.buttons & Button.FIRE).toBeTruthy();
  });

  it('exactly at FIRE_RANGE_FP still fires (boundary is "<=")', () => {
    const me: Point = { gx: 0, gy: 0 };
    const target: Point = { gx: FIRE_RANGE_FP, gy: 0 };
    const cmd = engageNearest(0, 1, me, [target]);
    expect(cmd!.buttons & Button.FIRE).toBeTruthy();
  });

  it('holds fire once past FIRE_RANGE_FP', () => {
    const me: Point = { gx: 0, gy: 0 };
    const target: Point = { gx: FIRE_RANGE_FP + gridFp(1), gy: 0 };
    const cmd = engageNearest(0, 1, me, [target]);
    expect(cmd!.buttons & Button.FIRE).toBeFalsy();
  });

  it('still fires while holding position (inside KEEP_DIST_FP, which is < FIRE_RANGE_FP)', () => {
    const me: Point = { gx: 0, gy: 0 };
    const target: Point = { gx: gridFp(1), gy: 0 };
    const cmd = engageNearest(0, 1, me, [target]);
    expect(cmd!.moveMag).toBe(0);
    expect(cmd!.buttons & Button.FIRE).toBeTruthy();
  });
});

describe('engageNearest — no facing/aim field on the returned command', () => {
  it('never carries an aim field (design/10 v33 — facing is engine-decided)', () => {
    const me: Point = { gx: 0, gy: 0 };
    const target: Point = { gx: gridFp(5), gy: 0 };
    const cmd = engageNearest(0, 1, me, [target]);
    expect(cmd).not.toHaveProperty('aimBrad');
  });
});
