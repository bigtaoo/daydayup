/**
 * Input-edge quantization (design/06 "quantize aim & move on input", design/08
 * "everything is already quantized for determinism"). This is the ONE place a
 * float controller sample is allowed to touch the input path: mouse/joystick
 * vectors become integer brad + a 0..255 magnitude here, and that integer is what
 * gets recorded / broadcast / stepped. Every client and every replay reads the
 * same integer, so upstream float divergence in atan2/hypot is harmless.
 *
 * Stage E formalizes this as an engine seam: the render-side CommandBuilder and
 * the golden-replay tests both go through these functions, so there is a single
 * quantization grid instead of an ad-hoc one duplicated on the render side.
 * Systems must NEVER call these — they use the deterministic integer atan2Brad.
 */
import { radToBrad, type Brad } from '../math/trig';
import type { PlayerCommand } from './commands';

/** Left-stick deflection is quantized to a byte (design/08 PlayerCommand.moveMag). */
export const MOVE_MAG_MAX = 255;

/**
 * Quantize a raw move vector → direction brad + 0..255 magnitude. The vector may
 * be un-normalized (keyboard 8-way or an analog stick); magnitude is clamped to
 * one stick-length. A zero/near-zero vector is idle: mag 0, brad 0.
 */
export function quantizeMove(dx: number, dy: number): { moveBrad: Brad; moveMag: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { moveBrad: 0 as Brad, moveMag: 0 };
  const mag = Math.round(Math.min(1, len) * MOVE_MAG_MAX);
  if (mag === 0) return { moveBrad: 0 as Brad, moveMag: 0 };
  return { moveBrad: radToBrad(Math.atan2(dy, dx)), moveMag: mag };
}

/**
 * Quantize a raw aim vector (world-space delta toward the cursor, or a stick
 * direction) → integer brad. Caller decides the vector (screen→world for a mouse
 * point, stick dx/dy for a joystick) and what to do when it is zero (typically
 * hold the last aim); this only does the float→brad quantization.
 */
export function quantizeAim(dx: number, dy: number): Brad {
  return radToBrad(Math.atan2(dy, dx));
}

/** Assemble a PlayerCommand from already-quantized fields (shape guard, design/08). */
export function makeCommand(fields: {
  owner: number;
  tick: number;
  moveBrad: Brad;
  moveMag: number;
  aimBrad: Brad;
  buttons: number;
}): PlayerCommand {
  return {
    type: 'input',
    owner: fields.owner,
    tick: fields.tick,
    moveBrad: fields.moveBrad,
    moveMag: fields.moveMag,
    aimBrad: fields.aimBrad,
    buttons: fields.buttons,
  };
}
