/**
 * CommandBuilder — the render-side input → PlayerCommand producer. Pins the
 * behavior a real player feels: manual aim only (mouse point / stick direction,
 * with an idle-hold), no target lock-on. There used to be an auto-aim-to-nearest
 * override here (design/10, shipped then reversed) — this suite exists mostly to
 * nail down that reversal so it can't silently regress: `build()` no longer takes
 * a `GameState`/auto-aim option at all, so there is nothing left to lock onto.
 */
import { describe, it, expect } from 'vitest';
import { Button } from '@dd/engine';
import { CommandBuilder } from './CommandBuilder';
import { bradToRad } from '../coords';
import type { InputSource } from '../../platform/types';
import type { InputState } from '../../platform/types';

const IDLE_STATE: InputState = {
  moveX: 0,
  moveY: 0,
  aim: { mode: 'dir', dx: 0, dy: 0 },
  firing: false,
  interacting: false,
};

function fakeInput(initial: InputState): InputSource & { state: InputState } {
  return {
    state: initial,
    onSwitchWeapon: null,
    attach() {},
    read() {
      return this.state;
    },
    getTouchVisual() {
      return { active: false, stickRadius: 0, move: null, aim: null, weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 } };
    },
  };
}

const PLAYER_PX = { x: 0, y: 0 };
const CAM = { x: 0, y: 0, zoom: 1 };

describe('CommandBuilder — manual aim only, no lock-on', () => {
  it('point mode: aims at the world-space direction to the mouse cursor, independent of movement', () => {
    const input = fakeInput({ ...IDLE_STATE, aim: { mode: 'point', x: 100, y: 0 } });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0, PLAYER_PX, CAM);
    expect(cmd.aimBrad).toBe(0); // due east of the player
  });

  it('point mode accounts for camera offset + zoom (world = (screen - cam) / zoom - playerPx)', () => {
    const input = fakeInput({ ...IDLE_STATE, aim: { mode: 'point', x: 260, y: 60 } });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0, { x: 10, y: 10 }, { x: 10, y: 10, zoom: 2 });
    // world = ((260-10)/2, (60-10)/2) = (125, 25); relative to player (10,10) => (115, 15)
    expect(bradToRad(cmd.aimBrad)).toBeCloseTo(Math.atan2(15, 115), 3);
  });

  it('dir mode: aims straight along the stick direction', () => {
    const input = fakeInput({ ...IDLE_STATE, aim: { mode: 'dir', dx: 0, dy: -1 } });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0, PLAYER_PX, CAM);
    // brad is unsigned [0, BRAD_FULL) — atan2(-1,0)'s -π/2 normalizes to its
    // positive-turn equivalent, 3π/2.
    expect(bradToRad(cmd.aimBrad)).toBeCloseTo((3 * Math.PI) / 2, 3);
  });

  it('an idle stick holds the last aim instead of snapping to zero', () => {
    const input = fakeInput({ ...IDLE_STATE, aim: { mode: 'dir', dx: 1, dy: 1 } });
    const builder = new CommandBuilder(input);
    const first = builder.build(1, 0, PLAYER_PX, CAM);
    input.state = { ...IDLE_STATE, aim: { mode: 'dir', dx: 0, dy: 0 } }; // stick released
    const second = builder.build(2, 0, PLAYER_PX, CAM);
    expect(second.aimBrad).toBe(first.aimBrad);
  });

  it('never overrides aim toward a nearby enemy — build() has no state/target input at all', () => {
    // `build` only ever takes (tick, owner, playerPx, cam) — there is nothing here an
    // engine GameState (or an enemy position) could steer. Aim is a pure function of
    // this tick's InputState, so a "closest enemy" positioned exactly opposite the
    // stick direction cannot pull the aim toward it.
    const input = fakeInput({ ...IDLE_STATE, aim: { mode: 'dir', dx: 1, dy: 0 } });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0, PLAYER_PX, CAM);
    expect(cmd.aimBrad).toBe(0); // due east, exactly the stick's own direction
    expect(builder.build.length).toBe(4); // (tick, owner, playerPx, cam) — no 5th/6th param
  });
});

describe('CommandBuilder — move/buttons', () => {
  it('quantizes the move vector independently of aim', () => {
    const input = fakeInput({ ...IDLE_STATE, moveX: 1, moveY: 0, aim: { mode: 'dir', dx: -1, dy: 0 } });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0, PLAYER_PX, CAM);
    expect(bradToRad(cmd.moveBrad)).toBeCloseTo(0, 3); // east
    expect(bradToRad(cmd.aimBrad)).toBeCloseTo(Math.PI, 3); // west — opposite of move, unaffected
    expect(cmd.moveMag).toBeGreaterThan(0);
  });

  it('maps firing/interacting to the FIRE/INTERACT bits', () => {
    const input = fakeInput({ ...IDLE_STATE, firing: true, interacting: true });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0, PLAYER_PX, CAM);
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.buttons & Button.INTERACT).toBeTruthy();
    expect(cmd.buttons & Button.SWAP_WEAPON).toBeFalsy();
  });

  it('requestSwap() latches SWAP_WEAPON for exactly one build() call', () => {
    const input = fakeInput(IDLE_STATE);
    const builder = new CommandBuilder(input);
    builder.requestSwap();
    const first = builder.build(1, 0, PLAYER_PX, CAM);
    const second = builder.build(2, 0, PLAYER_PX, CAM);
    expect(first.buttons & Button.SWAP_WEAPON).toBeTruthy();
    expect(second.buttons & Button.SWAP_WEAPON).toBeFalsy();
  });

  it('requestConfirmExtract()/requestConfirmDescend() each latch for exactly one build() call', () => {
    const input = fakeInput(IDLE_STATE);
    const builder = new CommandBuilder(input);
    builder.requestConfirmExtract();
    const extractCmd = builder.build(1, 0, PLAYER_PX, CAM);
    const afterExtract = builder.build(2, 0, PLAYER_PX, CAM);
    expect(extractCmd.buttons & Button.CONFIRM_EXTRACT).toBeTruthy();
    expect(afterExtract.buttons & Button.CONFIRM_EXTRACT).toBeFalsy();

    builder.requestConfirmDescend();
    const descendCmd = builder.build(3, 0, PLAYER_PX, CAM);
    const afterDescend = builder.build(4, 0, PLAYER_PX, CAM);
    expect(descendCmd.buttons & Button.CONFIRM_DESCEND).toBeTruthy();
    expect(afterDescend.buttons & Button.CONFIRM_DESCEND).toBeFalsy();
  });

  it('suppressFire(true) zeroes the FIRE bit even while the input source reports firing', () => {
    const input = fakeInput({ ...IDLE_STATE, firing: true });
    const builder = new CommandBuilder(input);
    builder.suppressFire(true);
    const suppressed = builder.build(1, 0, PLAYER_PX, CAM);
    expect(suppressed.buttons & Button.FIRE).toBeFalsy();

    builder.suppressFire(false);
    const restored = builder.build(2, 0, PLAYER_PX, CAM);
    expect(restored.buttons & Button.FIRE).toBeTruthy();
  });
});
