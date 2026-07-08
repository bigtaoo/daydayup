// Render-side input → PlayerCommand. Reads the platform InputSource each sim tick
// and assembles the engine's frozen twin-stick command: move/aim quantized to brad
// via radToBrad (the deterministic input edge, design/06), buttons folded into the
// bitfield. Discrete presses (jump / weapon swap) arrive as callbacks, so they are
// latched here and flushed as a one-tick button pulse — the engine's own
// rising-edge detection (prevButtons) then sees a clean press.
//
// This is the minimal command producer that makes Stage D playable; the full
// InputSource net/replay seam + golden-replay coverage is Stage E.
import { Button, radToBrad, type Brad, type PlayerCommand } from '@dd/engine';
import type { InputSource } from '../platform/types';

export class CommandBuilder {
  private lastAim = 0 as Brad; // idle stick keeps the last facing (no snap-to-zero)
  private jumpLatch = false;
  private swapLatch = false;

  constructor(private readonly input: InputSource) {}

  /** Discrete-action latches, set from Game's onJump / onSwitchWeapon routing. */
  requestJump(): void {
    this.jumpLatch = true;
  }
  requestSwap(): void {
    this.swapLatch = true;
  }

  /**
   * Build this tick's command. `playerPx` is the engine player's world-px position
   * and `cam` the world-layer offset, so a screen-space mouse point maps to a world
   * aim direction.
   */
  build(
    tick: number,
    owner: number,
    playerPx: { x: number; y: number },
    cam: { x: number; y: number },
  ): PlayerCommand {
    const inp = this.input.read();

    // Move: normalized vector → direction brad + 0..255 magnitude.
    const mag = Math.min(1, Math.hypot(inp.moveX, inp.moveY));
    const moveBrad = mag > 0 ? radToBrad(Math.atan2(inp.moveY, inp.moveX)) : (0 as Brad);

    // Aim: 'point' (mouse) → world-space angle to the cursor; 'dir' (stick) → the
    // stick direction, but an idle stick holds the last aim instead of resetting.
    let aim = this.lastAim;
    if (inp.aim.mode === 'point') {
      const wx = inp.aim.x - cam.x;
      const wy = inp.aim.y - cam.y;
      aim = radToBrad(Math.atan2(wy - playerPx.y, wx - playerPx.x));
    } else if (inp.aim.dx !== 0 || inp.aim.dy !== 0) {
      aim = radToBrad(Math.atan2(inp.aim.dy, inp.aim.dx));
    }
    this.lastAim = aim;

    let buttons = 0;
    if (inp.firing) buttons |= Button.FIRE;
    if (inp.blocking) buttons |= Button.BLOCK;
    if (this.jumpLatch) {
      buttons |= Button.JUMP;
      this.jumpLatch = false;
    }
    if (this.swapLatch) {
      buttons |= Button.SWAP_WEAPON;
      this.swapLatch = false;
    }

    return {
      type: 'input',
      owner,
      tick,
      moveBrad,
      moveMag: Math.round(mag * 255),
      aimBrad: aim,
      buttons,
    };
  }
}
