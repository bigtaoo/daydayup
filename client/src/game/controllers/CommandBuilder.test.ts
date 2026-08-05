/**
 * CommandBuilder — the render-side input → PlayerCommand producer. Pins the behavior a
 * real player feels: NO aim input at all (design/10 v33) — only movement + buttons.
 * There used to be manual aim (mouse point / stick direction), and before that a briefly-
 * shipped auto-aim-to-nearest override — both are gone now; this suite exists mostly to
 * nail that down so it can't silently regress. Facing is entirely engine-decided
 * (ApplyInputSystem: nearest hostile, else movement direction, else held).
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
      return {
        active: false, stickRadius: 0, move: null,
        fire: { cx: 0, cy: 0, r: 0, pressed: false },
        weapon1: { cx: 0, cy: 0, r: 0 }, weapon2: { cx: 0, cy: 0, r: 0 },
        interact: { cx: 0, cy: 0, r: 0, pressed: false },
      };
    },
  };
}

describe('CommandBuilder — no aim input at all', () => {
  it('build() takes no world-position/camera context — there is nothing left to map a screen point through', () => {
    // (tick, owner) only. If this ever grows a 3rd/4th param, aim mapping is creeping back.
    expect(new CommandBuilder(fakeInput(IDLE_STATE)).build.length).toBe(2);
  });

  it('a command never carries an aim field, regardless of movement', () => {
    const input = fakeInput({ ...IDLE_STATE, moveX: 1, moveY: 0 });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0);
    expect(cmd).not.toHaveProperty('aimBrad');
  });
});

describe('CommandBuilder — move/buttons', () => {
  it('quantizes the move vector', () => {
    const input = fakeInput({ ...IDLE_STATE, moveX: 1, moveY: 0 });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0);
    expect(bradToRad(cmd.moveBrad)).toBeCloseTo(0, 3); // east
    expect(cmd.moveMag).toBeGreaterThan(0);
  });

  it('maps firing/interacting to the FIRE/INTERACT bits', () => {
    const input = fakeInput({ ...IDLE_STATE, firing: true, interacting: true });
    const builder = new CommandBuilder(input);
    const cmd = builder.build(1, 0);
    expect(cmd.buttons & Button.FIRE).toBeTruthy();
    expect(cmd.buttons & Button.INTERACT).toBeTruthy();
    expect(cmd.buttons & Button.SWAP_WEAPON).toBeFalsy();
  });

  it('requestSwap() latches SWAP_WEAPON for exactly one build() call', () => {
    const input = fakeInput(IDLE_STATE);
    const builder = new CommandBuilder(input);
    builder.requestSwap();
    const first = builder.build(1, 0);
    const second = builder.build(2, 0);
    expect(first.buttons & Button.SWAP_WEAPON).toBeTruthy();
    expect(second.buttons & Button.SWAP_WEAPON).toBeFalsy();
  });

  it('requestConfirmExtract()/requestConfirmDescend() each latch for exactly one build() call', () => {
    const input = fakeInput(IDLE_STATE);
    const builder = new CommandBuilder(input);
    builder.requestConfirmExtract();
    const extractCmd = builder.build(1, 0);
    const afterExtract = builder.build(2, 0);
    expect(extractCmd.buttons & Button.CONFIRM_EXTRACT).toBeTruthy();
    expect(afterExtract.buttons & Button.CONFIRM_EXTRACT).toBeFalsy();

    builder.requestConfirmDescend();
    const descendCmd = builder.build(3, 0);
    const afterDescend = builder.build(4, 0);
    expect(descendCmd.buttons & Button.CONFIRM_DESCEND).toBeTruthy();
    expect(afterDescend.buttons & Button.CONFIRM_DESCEND).toBeFalsy();
  });

  it('requestPickup(id) latches pickupTargetId for exactly one build() call', () => {
    const input = fakeInput(IDLE_STATE);
    const builder = new CommandBuilder(input);
    expect(builder.build(1, 0).pickupTargetId).toBe(0); // default: no click
    builder.requestPickup(42);
    const first = builder.build(2, 0);
    const second = builder.build(3, 0);
    expect(first.pickupTargetId).toBe(42);
    expect(second.pickupTargetId).toBe(0);
  });

  it('suppressFire(true) zeroes the FIRE bit even while the input source reports firing', () => {
    const input = fakeInput({ ...IDLE_STATE, firing: true });
    const builder = new CommandBuilder(input);
    builder.suppressFire(true);
    const suppressed = builder.build(1, 0);
    expect(suppressed.buttons & Button.FIRE).toBeFalsy();

    builder.suppressFire(false);
    const restored = builder.build(2, 0);
    expect(restored.buttons & Button.FIRE).toBeTruthy();
  });
});
