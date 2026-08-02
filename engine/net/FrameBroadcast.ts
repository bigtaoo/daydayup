/**
 * The server-side frame-broadcast core (design/06 "server as frame broadcaster", the
 * 王者荣耀 / funny `Room` pattern, ROADMAP 3.1). PURE and headless — no sockets, no
 * timers: the transport owns the metronome (a setInterval) and the sockets, and calls
 * `tick()` each pulse to get the `FrameBatch` to broadcast. Keeping the relay logic
 * here (not buried in the I/O layer) means its correctness — command ordering, the
 * monotonic watermark, the reconnect log — is unit-tested under the engine's own
 * vitest, and the client and server share ONE protocol definition (design/06's anti-
 * drift lesson). It mirrors funny's `server/gameserver/src/Room.ts`, minus the PvP
 * concerns DayDayUp co-op doesn't have (sides/ELO/decks/ticket handshake).
 *
 * Model (design/06):
 *   • The server owns a fixed-rate clock and broadcasts one batch per pulse.
 *   • It NEVER waits for a client — every pulse advances the watermark, whether or not
 *     input arrived. A batch with no commands is a pure metronome pulse (frames: []).
 *   • It never interprets a command; it only buckets by frame and orders deterministically.
 *
 * Frame numbering matches the engine and NetInputSource: startFrame (0) is the initial
 * state, sim frames advance by `framesPerBatch` per pulse. With the funny-default 3
 * (sim 30 Hz ÷ net 10 Hz) a pulse jumps 3 sim frames and any commands buffered during
 * that window land on the window's `toFrame`; the intervening frames are idle-hold on
 * every client (NetInputSource returns EMPTY for a confirmed frame with no entry).
 */
import type { PlayerCommand } from '../state/commands';
import type { FrameBatch, FrameCmds } from './protocol';

export interface FrameBroadcastOptions {
  /** Sim frames advanced per broadcast pulse. Default 3 (30 Hz sim ÷ 10 Hz net, funny). */
  framesPerBatch?: number;
  /** First frame's predecessor — the initial-state frame. Default 0. */
  startFrame?: number;
}

const DEFAULT_FRAMES_PER_BATCH = 3;

export class FrameBroadcast {
  private curFrame: number;
  private readonly framesPerBatch: number;
  /** Commands buffered since the last pulse, in arrival order. */
  private pending: PlayerCommand[] = [];
  /** Non-empty frames only — the reconnect/replay log (design/06 "frame log = replay"). */
  private readonly frameLog: FrameCmds[] = [];

  constructor(opts: FrameBroadcastOptions = {}) {
    this.framesPerBatch = opts.framesPerBatch ?? DEFAULT_FRAMES_PER_BATCH;
    this.curFrame = opts.startFrame ?? 0;
  }

  /**
   * Buffer a command received from a client this window. `owner` rides on the command
   * (the transport stamps it from the connection's claimed seat, not from client-sent
   * data). Multiple commands from one owner in a window are all kept in arrival order;
   * the engine's ApplyInputSystem already resolves duplicates as "last per owner wins",
   * and the ordering here is arrival-stable, so the last-arriving one wins identically
   * on every client.
   */
  submit(cmd: PlayerCommand): void {
    this.pending.push(cmd);
  }

  /**
   * One broadcast pulse. Advances the watermark by `framesPerBatch`, flushes the
   * buffered commands (ordered by owner ascending, arrival-stable within an owner — the
   * sole ordering authority, so every client applies an identical sequence) onto the new
   * `toFrame`, appends them to the log, and returns the batch to broadcast. When nothing
   * was buffered the batch carries no frames — a pure metronome pulse that still advances
   * every client's clock (the server never waits, design/06).
   */
  tick(): FrameBatch {
    this.curFrame += this.framesPerBatch;
    if (this.pending.length === 0) {
      return { toFrame: this.curFrame, frames: [] };
    }
    // Array.prototype.sort is stable (ES2019+), so equal owners keep arrival order.
    const cmds = [...this.pending].sort((a, b) => a.owner - b.owner);
    const fc: FrameCmds = { frame: this.curFrame, cmds };
    this.frameLog.push(fc);
    this.pending = [];
    return { toFrame: this.curFrame, frames: [fc] };
  }

  /** The non-empty frames after `frame` — the reconnect payload (conn_resync.log). */
  logSince(frame: number): FrameCmds[] {
    return this.frameLog.filter((f) => f.frame > frame);
  }

  /** Current confirmed watermark. */
  get frame(): number {
    return this.curFrame;
  }

  /** The full frame log — the embedded replay (design/06 re-judge backstop). */
  get log(): readonly FrameCmds[] {
    return this.frameLog;
  }
}
