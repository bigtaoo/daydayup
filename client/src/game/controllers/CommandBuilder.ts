// Render-side input → PlayerCommand. Reads the platform InputSource each sim tick
// and assembles the engine's frozen twin-stick command. The float→brad/mag
// quantization is the engine's input-edge seam (quantizeMove / quantizeAim,
// design/06/08) — this file only handles the render-specific bits: screen→world
// aim, idle-stick hold, and latching the discrete weapon-swap press into a
// one-tick button pulse so the engine's rising-edge detection sees a clean press.
//
// Because the quantization lives in @dd/engine, the golden-replay tests build
// commands through the exact same grid this producer uses.
import { Button, makeCommand, quantizeAim, quantizeMove, type Brad, type PlayerCommand } from '@dd/engine';
import type { InputSource } from '../../platform/types';

export class CommandBuilder {
  private lastAim = 0 as Brad; // idle stick keeps the last facing (no snap-to-zero)
  private swapLatch = false;
  private confirmExtractLatch = false;
  private confirmDescendLatch = false;
  // Set while the portal popup is open (PortalPrompt.isOpen) so a click on one of its
  // buttons doesn't also register as a shot — WebInput's `leftDown` is set from a raw
  // `canvas.addEventListener('mousedown', ...)`, independent of Pixi's own event
  // system, so it fires regardless of what a Pixi button's hit-test consumes.
  private fireSuppressed = false;

  constructor(private readonly input: InputSource) {}

  /** Discrete-action latch, set from Game's onSwitchWeapon routing. */
  requestSwap(): void {
    this.swapLatch = true;
  }

  /** One-shot portal-popup choices (design/10, ROADMAP 1.4 follow-up), set from
   * PortalPrompt's onExtract/onDescend callbacks — same one-shot-latch shape as
   * requestSwap(). */
  requestConfirmExtract(): void {
    this.confirmExtractLatch = true;
  }

  requestConfirmDescend(): void {
    this.confirmDescendLatch = true;
  }

  suppressFire(active: boolean): void {
    this.fireSuppressed = active;
  }

  /**
   * Build this tick's command. `playerPx` is the engine player's world-px position
   * and `cam` the world-layer offset + zoom, so a screen-space mouse point maps to a
   * world aim direction (FxController.updateCamera zooms small rooms to fill the
   * viewport — `cam.zoom` undoes that before subtracting the player's own world
   * position, or a zoomed room would aim wrong).
   *
   * Aim is always the player's own manual input — 'point' (mouse) → world-space angle
   * to the cursor, 'dir' (stick) → the stick direction, with an idle stick holding the
   * last aim instead of resetting. There is no target lock-on: a fired bullet simply
   * travels along this facing, exactly like an enemy's shot travels along the facing
   * AIDecideSystem computed for it (design/07).
   */
  build(
    tick: number,
    owner: number,
    playerPx: { x: number; y: number },
    cam: { x: number; y: number; zoom?: number },
  ): PlayerCommand {
    const inp = this.input.read();

    // Move: raw vector → direction brad + 0..255 magnitude (engine input edge).
    const { moveBrad, moveMag } = quantizeMove(inp.moveX, inp.moveY);

    let aim = this.lastAim;
    if (inp.aim.mode === 'point') {
      const zoom = cam.zoom ?? 1; // callers without room-zoom (or older ones) get 1:1 mapping
      const wx = (inp.aim.x - cam.x) / zoom;
      const wy = (inp.aim.y - cam.y) / zoom;
      aim = quantizeAim(wx - playerPx.x, wy - playerPx.y);
    } else if (inp.aim.dx !== 0 || inp.aim.dy !== 0) {
      aim = quantizeAim(inp.aim.dx, inp.aim.dy);
    }
    this.lastAim = aim;

    let buttons = 0;
    if (inp.firing && !this.fireSuppressed) buttons |= Button.FIRE;
    if (inp.interacting) buttons |= Button.INTERACT; // revive channel / weapon-swap-on-pickup
    if (this.swapLatch) {
      buttons |= Button.SWAP_WEAPON;
      this.swapLatch = false;
    }
    if (this.confirmExtractLatch) {
      buttons |= Button.CONFIRM_EXTRACT;
      this.confirmExtractLatch = false;
    }
    if (this.confirmDescendLatch) {
      buttons |= Button.CONFIRM_DESCEND;
      this.confirmDescendLatch = false;
    }

    return makeCommand({ owner, tick, moveBrad, moveMag, aimBrad: aim, buttons });
  }
}
