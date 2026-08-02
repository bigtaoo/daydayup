import { describe, it, expect } from 'vitest';
import { acceptsFireConfirm, shouldConfirmOnFireEdge, type Phase } from './confirmEdge';

// Declared as a Record over the full `Phase` union rather than a plain array, so adding
// a new phase to confirmEdge.ts fails TYPE-CHECK here until someone explicitly decides
// whether a raw fire edge may navigate away from it. That decision is the whole point of
// this module — leaving it to a default is how the original bug shipped.
const EXPECTED: Record<Phase, boolean> = {
  menu: false,
  forge: false,
  squad: false,
  account: false,
  settings: false,
  paused: false,
  playing: false,
  victory: true,
  defeat: true,
};

const ALL_PHASES = Object.keys(EXPECTED) as Phase[];

describe('acceptsFireConfirm', () => {
  it('accepts the two result screens', () => {
    expect(acceptsFireConfirm('victory')).toBe(true);
    expect(acceptsFireConfirm('defeat')).toBe(true);
  });

  // The regression this module exists for: a raw left-mouse-down used to confirm on
  // EVERY non-playing screen, which beat each Button's own pointertap to the punch and
  // collapsed the whole main menu into "any click → forge" and the whole forge into
  // "any click → start the run".
  it('rejects every screen that has real buttons', () => {
    for (const phase of ALL_PHASES) {
      if (phase === 'victory' || phase === 'defeat') continue;
      expect(acceptsFireConfirm(phase), phase).toBe(false);
    }
  });

  it('matches the decision table for every declared phase', () => {
    for (const phase of ALL_PHASES) {
      expect(acceptsFireConfirm(phase), phase).toBe(EXPECTED[phase]);
    }
  });
});

describe('shouldConfirmOnFireEdge', () => {
  it('fires once on the rising edge of a result-screen press', () => {
    expect(shouldConfirmOnFireEdge('defeat', true, false)).toBe(true);
  });

  it('does not re-fire while the press is held', () => {
    expect(shouldConfirmOnFireEdge('defeat', true, true)).toBe(false);
  });

  it('does not fire on release', () => {
    expect(shouldConfirmOnFireEdge('defeat', false, true)).toBe(false);
  });

  it('never fires on a button-driven screen, at any point in a press', () => {
    for (const phase of ['menu', 'forge', 'squad', 'account', 'settings'] as Phase[]) {
      for (const [firing, prev] of [[true, false], [true, true], [false, true], [false, false]] as const) {
        expect(shouldConfirmOnFireEdge(phase, firing, prev), `${phase} ${firing}/${prev}`).toBe(false);
      }
    }
  });

  // A human click spans several frames; the old code polled once per frame, so the
  // down-state was still true on the frames after the press landed. Holding the mouse
  // across a whole menu → forge → run sequence must produce no confirms at all.
  it('a multi-frame hold on the menu confirms nothing', () => {
    const frames = [true, true, true, true, true, false];
    let prev = false;
    let confirms = 0;
    for (const firing of frames) {
      if (shouldConfirmOnFireEdge('menu', firing, prev)) confirms++;
      prev = firing;
    }
    expect(confirms).toBe(0);
  });

  it('a multi-frame hold on a result screen confirms exactly once', () => {
    const frames = [true, true, true, true, true, false];
    let prev = false;
    let confirms = 0;
    for (const firing of frames) {
      if (shouldConfirmOnFireEdge('victory', firing, prev)) confirms++;
      prev = firing;
    }
    expect(confirms).toBe(1);
  });
});
