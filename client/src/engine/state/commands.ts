/**
 * The per-tick twin-stick input snapshot (design/08 "PlayerCommand") and the
 * InputSource seam (design/08 "InputSource, replay, headless").
 *
 * Stage B defined the frozen command shape — it is step()'s input contract — plus
 * a minimal non-stalling LocalInputSource so createGameEngine(config, input?) has
 * an honest default. Stage E formalized the seam: the input-edge quantization
 * lives in input.ts, LocalInputSource can serialize the frames it saw into a
 * Replay (replay.ts / ReplayInputSource), and golden-replay tests pin the
 * seed+config+input → identical终局 guarantee.
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

/**
 * design/08: submit / take(frame). `take` returns null only when a frame isn't
 * confirmed yet (net stall); a local/replay source never returns null. The
 * optional confirmedLead(frame) reports how many frames ahead of `frame` are
 * already confirmed (net pacing; unbounded for local/replay sources).
 */
export interface InputSource {
  submit(cmd: PlayerCommand): void;
  take(frame: number): PlayerCommand[] | null;
  confirmedLead?(frame: number): number;
}

/**
 * Single-player / test input source. Never stalls: an unconfirmed frame returns
 * an empty array (idle-hold), not null (design/08 "LocalInputSource never stalls").
 * It also records every frame it saw, so a finished single-player match can be
 * serialized into a Replay for headless re-judge (see replay.ts).
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

  /**
   * Every submitted command, flattened in deterministic (tick, then submit) order.
   * Feeds toReplay() — the recorded stream a ReplayInputSource re-runs verbatim.
   */
  recorded(): PlayerCommand[] {
    const frames = [...this.byFrame.keys()].sort((a, b) => a - b);
    const out: PlayerCommand[] = [];
    for (const f of frames) out.push(...this.byFrame.get(f)!);
    return out;
  }
}
