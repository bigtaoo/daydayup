/**
 * The per-tick twin-stick input snapshot (design/08 "PlayerCommand") and the
 * InputSource seam (design/08 "InputSource, replay, headless").
 *
 * Stage B defines the frozen command shape — it is step()'s input contract — plus
 * a minimal non-stalling LocalInputSource so createGameEngine(config, input?) has
 * an honest default. Stage E adds aim quantization at the input edge, the net /
 * replay InputSource impls, stall handling, and golden-replay tests around it.
 */
import type { Brad } from '../math/trig';

/** Button bitfield, edge-detected inside the engine (design/08). */
export const Button = {
  FIRE: 1 << 0,
  BLOCK: 1 << 1,
  JUMP: 1 << 2,
  SWAP_WEAPON: 1 << 3,
  INTERACT: 1 << 4,
} as const;

export interface PlayerCommand {
  type: 'input';
  owner: number; // == index into state.players
  tick: number; // frame this input applies to (matches step's tick)
  moveBrad: Brad; // desired move direction
  moveMag: number; // 0..255 left-stick deflection, 0 = idle
  aimBrad: Brad; // right-stick / mouse aim
  buttons: number; // Button bitfield
}

/** design/08: submit / take(frame). take returns null only when a frame isn't confirmed (net). */
export interface InputSource {
  submit(cmd: PlayerCommand): void;
  take(frame: number): PlayerCommand[] | null;
}

/**
 * Single-player / test input source. Never stalls: an unconfirmed frame returns
 * an empty array (idle-hold), not null (design/08 "LocalInputSource never stalls").
 */
export class LocalInputSource implements InputSource {
  private readonly byFrame = new Map<number, PlayerCommand[]>();

  submit(cmd: PlayerCommand): void {
    const list = this.byFrame.get(cmd.tick);
    if (list) list.push(cmd);
    else this.byFrame.set(cmd.tick, [cmd]);
  }

  take(frame: number): PlayerCommand[] {
    return this.byFrame.get(frame) ?? [];
  }
}
