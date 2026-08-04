// Render-side input → PlayerCommand. Reads the platform InputSource each sim tick
// and assembles the engine's frozen twin-stick command. The float→brad/mag
// quantization is the engine's input-edge seam (quantizeMove, design/06/08) — this
// file only handles the render-specific bits: latching the discrete weapon-swap /
// portal-choice presses into one-tick button pulses so the engine's rising-edge
// detection sees a clean press.
//
// Because the quantization lives in @dd/engine, the golden-replay tests build
// commands through the exact same grid this producer uses.
import { Button, makeCommand, quantizeMove, type PlayerCommand } from '@dd/engine';
import type { InputSource } from '../../platform/types';

export class CommandBuilder {
  private swapLatch = false;
  private confirmExtractLatch = false;
  private confirmDescendLatch = false;
  // Ground-weapon click target (design/03, ENGINE_VERSION 32) — 0 = no click this
  // tick. Same one-shot-latch shape as the confirm latches above, set from
  // WeaponPickupPrompt's onPick via Game.ts.
  private pickupLatchId = 0;
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

  /** One-shot ground-weapon collect, set from WeaponPickupPrompt's onPick (a row
   *  click) — same one-shot-latch shape as requestSwap()/requestConfirmExtract(). */
  requestPickup(itemId: number): void {
    this.pickupLatchId = itemId;
  }

  suppressFire(active: boolean): void {
    this.fireSuppressed = active;
  }

  /**
   * Build this tick's command. There is no manual aim input at all (design/10 v33): the
   * engine auto-faces the nearest hostile, else the movement direction, else holds last
   * facing (ApplyInputSystem) — exactly like an enemy's own facing is computed for it
   * (AIDecideSystem, design/07). This builder only ever reports movement + buttons, so
   * (unlike before) it needs no world-position/camera context to map a screen aim point.
   */
  build(tick: number, owner: number): PlayerCommand {
    const inp = this.input.read();

    // Move: raw vector → direction brad + 0..255 magnitude (engine input edge).
    const { moveBrad, moveMag } = quantizeMove(inp.moveX, inp.moveY);

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
    const pickupTargetId = this.pickupLatchId;
    this.pickupLatchId = 0;

    return makeCommand({ owner, tick, moveBrad, moveMag, buttons, pickupTargetId });
  }
}
