/**
 * Online co-op input source (design/06 "NetInputSource", ROADMAP 3.1) — the networked
 * sibling of LocalInputSource / ReplayInputSource, all implementing InputSource
 * (state/commands.ts). It bridges the server's frame-broadcast metronome (design/06)
 * to the deterministic engine:
 *
 *   • OUTBOUND — `submit(cmd)` relays the local seat's command to the server (via the
 *     injected sink). It does NOT choose a frame: the server schedules it onto the
 *     current batch window and broadcasts it back. The command becomes CONFIRMED only
 *     when it returns inside a `frame_batch`.
 *
 *   • INBOUND — `frame_batch{toFrame, frames}` raises the confirmed watermark and
 *     caches each non-empty frame's commands. `take(frame)` then releases the
 *     confirmed set — or `null` when the frame is not yet confirmed, which stalls the
 *     engine (design/06: "clients advance strictly by the confirmed frame stream").
 *
 * Pacing / jitter cushion (design/06 catch-up model): playback is held `bufferFrames`
 * behind the newest watermark, so jitter smaller than the cushion never starves the
 * sim. When the watermark jumps ahead (a burst, or a `conn_resync` after reconnect),
 * `confirmedLead()` reports the backlog and the render loop's accumulator fast-forwards
 * to resync — "a lagging client falls behind the broadcast and catches up alone."
 *
 * This is the confirmed-stream half. LOCAL PREDICTION of the local seat (running ahead
 * of the watermark with self-forwarded input, then reconciling) is a separate layer on
 * top — see the prediction driver (ROADMAP 3.1 part D). Co-op PvE is latency-tolerant
 * (design/06), so it is playable on this source alone; prediction is the twin-stick
 * feel fix that matters most for PvP.
 */
import type { InputSource, PlayerCommand } from '../state/commands';
import type { ConnResync, FrameBatch, FrameCmds, MatchStart, ServerMsg } from './protocol';

const EMPTY: readonly PlayerCommand[] = [];

/** Where outbound commands go — satisfied by the client's transport (WebSocket). */
export interface CmdSink {
  submit(cmd: PlayerCommand): void;
}

export interface NetInputSourceOptions {
  /**
   * Frames kept buffered behind the newest confirmed watermark — the jitter cushion.
   * Default 3 (≈100 ms at 30 Hz, one funny-style 10 Hz batch). 0 = play to the edge of
   * the watermark (no cushion, lowest latency, most vulnerable to jitter).
   */
  bufferFrames?: number;
  /** Fired once when `match_start` arrives, so the app can build + start the engine. */
  onMatchStart?: (info: MatchStart) => void;
  /** Fired when `match_over` arrives (server's authoritative outcome). */
  onMatchOver?: (winner: import('./protocol').MatchOver) => void;
}

const DEFAULT_BUFFER_FRAMES = 3;

export class NetInputSource implements InputSource {
  /** Highest `toFrame` confirmed by the server; -1 before `match_start`. */
  private confirmedTo = -1;
  private startFrame = 0;
  /** Non-empty frames only: frame → commands (an absent frame is an implicit idle-hold). */
  private readonly cmdsByFrame = new Map<number, PlayerCommand[]>();
  /** Highest frame `take()` has released — reported as `resume{lastFrame}` on reconnect. */
  private lastTaken = -1;
  private matchInfo: MatchStart | null = null;
  private readonly bufferFrames: number;

  constructor(
    private readonly sink: CmdSink,
    private readonly opts: NetInputSourceOptions = {},
  ) {
    this.bufferFrames = opts.bufferFrames ?? DEFAULT_BUFFER_FRAMES;
  }

  // ─── InputSource ─────────────────────────────────────────────────────────────

  /**
   * Relay a locally-produced command to the server. It is confirmed only when it
   * returns inside a future `frame_batch`; the server assigns the real frame, so the
   * `tick` on `cmd` is advisory (the prediction layer uses it locally).
   */
  submit(cmd: PlayerCommand): void {
    this.sink.submit(cmd);
  }

  /**
   * Confirmed command set for `frame`, or `null` to stall the engine. A frame is
   * releasable once it sits at or below the playback head (`confirmedTo - bufferFrames`,
   * floored at `startFrame`); holding the head a cushion behind the watermark absorbs
   * sub-cushion jitter.
   */
  take(frame: number): readonly PlayerCommand[] | null {
    if (this.confirmedTo < 0) return null; // no match yet
    const playTo = this.playHead();
    if (frame > playTo) return null; // not yet confirmed → engine pauses
    if (frame > this.lastTaken) this.lastTaken = frame;
    return this.cmdsByFrame.get(frame) ?? EMPTY;
  }

  /**
   * Confirmed playback backlog ahead of `frame` (design/06 catch-up). Mirrors take()'s
   * head exactly, so the two never disagree about what's releasable: this is how many
   * frames take() would return non-null for, starting at `frame`. A large lead means the
   * watermark raced ahead while this client was paused/backgrounded — the loop speeds up.
   */
  confirmedLead(frame: number): number {
    if (this.confirmedTo < 0) return 0;
    return Math.max(0, this.playHead() - frame);
  }

  private playHead(): number {
    return Math.max(this.startFrame, this.confirmedTo - this.bufferFrames);
  }

  // ─── Server message intake (transport wires its onMessage here) ────────────────

  /** Route a decoded server message; ignores everything but the lockstep-relevant ones. */
  handleServerMsg(msg: ServerMsg): void {
    switch (msg.type) {
      case 'match_start': return this.onMatchStart(msg);
      case 'frame_batch': return this.onFrameBatch(msg);
      case 'conn_resync': return this.onConnResync(msg);
      case 'match_over': this.opts.onMatchOver?.(msg); return;
      default: return; // 'error' etc. handled by the transport, not the input path
    }
  }

  /** `match_start` info (seed / localOwner / playerCount), or null before it arrives. */
  get matchStartInfo(): MatchStart | null {
    return this.matchInfo;
  }

  /** Frame to put in `resume{lastFrame}` on reconnect — the highest watermark held. */
  resumeFrame(): number {
    return Math.max(this.startFrame, this.confirmedTo, 0);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────────

  private onMatchStart(m: MatchStart): void {
    // Fresh match: clear any frame state from a prior match so stale commands can't
    // bleed into the new engine and break determinism. (Reconnect uses conn_resync.)
    this.cmdsByFrame.clear();
    this.lastTaken = -1;
    this.matchInfo = m;
    this.startFrame = m.startFrame;
    // The start frame is playable immediately — its command set is empty (the metronome
    // can only schedule commands onto later frames).
    this.confirmedTo = m.startFrame;
    this.opts.onMatchStart?.(m);
  }

  private onFrameBatch(b: FrameBatch): void {
    for (const fc of b.frames) this.ingestFrame(fc);
    if (b.toFrame > this.confirmedTo) this.confirmedTo = b.toFrame; // watermark is monotonic
  }

  private onConnResync(r: ConnResync): void {
    // Reconnect: merge the replayed frames (> lastFrame) and jump the watermark to
    // curFrame. Frames already held (≤ old watermark) are deterministic duplicates —
    // re-ingesting overwrites with identical content, a no-op in effect.
    this.startFrame = r.startFrame;
    for (const fc of r.log) this.ingestFrame(fc);
    if (r.curFrame > this.confirmedTo) this.confirmedTo = r.curFrame;
  }

  private ingestFrame(fc: FrameCmds): void {
    // The server already ordered `cmds` (owner asc, then arrival) — the sole ordering
    // authority, so every client applies an identical sequence. Preserve it verbatim.
    if (fc.cmds.length > 0) this.cmdsByFrame.set(fc.frame, [...fc.cmds]);
  }
}
