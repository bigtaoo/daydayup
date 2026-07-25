/**
 * Client co-op session (design/06, ROADMAP 3.1) — the client counterpart to the
 * server's MatchRoom. It owns a NetInputSource + a GameEngine and turns the server's
 * confirmed frame stream into sim steps:
 *
 *   1. `submit(cmd)` relays the local seat's command to the server (via the transport).
 *      It does NOT step the engine — the command is confirmed only when it returns in a
 *      frame_batch (no local prediction here; see the note below).
 *   2. `drive()` advances the engine through every frame the server has confirmed so far,
 *      then stalls (design/06 "clients advance strictly by the confirmed frame stream").
 *      When the client has fallen behind the broadcast (a burst, a resumed tab), it
 *      catches up by stepping multiple frames in one drive() — the render loop calls
 *      drive() once per rendered frame and it consumes the backlog.
 *
 * The engine is built on `match_start`: the server tells this client its `localOwner`,
 * the shared `seed`, and the `playerCount`, and `buildConfig` turns those into the run's
 * EngineConfig (with a `players` list of length playerCount — the real co-op seats,
 * ROADMAP 3.1 part A). Because the engine is fed by the NetInputSource, every client
 * simulates the identical confirmed stream and stays in lock-step (design/06).
 *
 * NOT here: local prediction. That is a RENDER-layer concern that sits on top of this
 * session WITHOUT changing the confirmed path — `client/src/game/LocalPredictor.ts` draws
 * the local seat's movement/aim ahead of the confirmed frame and eases back (snap-vs-lerp)
 * on each confirmed frame, wired in `Game.advanceOnline`. This session stays purely the
 * confirmed-stream driver; the sim it runs is never touched by prediction (design/06).
 */
import { NetInputSource, createGameEngine, type EngineConfig, type GameEngine, type GameEvent, type MatchOver, type MatchStart, type PlayerCommand } from '@dd/engine';
import type { Transport } from './transport';

/** Spiral-of-death guard: never step more than this many sim frames in one drive(). */
const MAX_CATCHUP_STEPS = 300;

export interface CoopSessionOptions {
  transport: Transport;
  roomId: string;
  owner: number; // the seat this client claims
  seed: number;
  playerCount: number;
  /** Build the run config once the match starts (seed/localOwner/playerCount known). */
  buildConfig: (info: MatchStart) => EngineConfig;
  bufferFrames?: number; // NetInputSource jitter cushion (default 3)
  onMatchStart?: (info: MatchStart) => void;
  onMatchOver?: (over: MatchOver) => void;
}

export class CoopSession {
  readonly net: NetInputSource;
  private engine: GameEngine | null = null;
  private nextFrame = 1;

  constructor(private readonly opts: CoopSessionOptions) {
    this.net = new NetInputSource(
      { submit: (cmd) => opts.transport.send({ type: 'cmd', cmd }) },
      {
        bufferFrames: opts.bufferFrames,
        onMatchStart: (info) => this.onStart(info),
        onMatchOver: (over) => opts.onMatchOver?.(over),
      },
    );
    opts.transport.onMessage((msg) => this.net.handleServerMsg(msg));
    // Claim the seat; the server starts the match once every seat is joined.
    opts.transport.send({ type: 'join', roomId: opts.roomId, owner: opts.owner, seed: opts.seed, playerCount: opts.playerCount });
  }

  private onStart(info: MatchStart): void {
    this.engine = createGameEngine(this.opts.buildConfig(info), this.net);
    this.nextFrame = info.startFrame + 1; // first sim frame after the initial state
    this.opts.onMatchStart?.(info);
  }

  /** The live sim state, or null before match_start. */
  get state() {
    return this.engine?.state ?? null;
  }
  get started(): boolean {
    return this.engine !== null;
  }
  /** The next frame drive() will attempt (for the render loop / HUD). */
  get frame(): number {
    return this.nextFrame;
  }

  /**
   * Relay the local seat's command for this render tick to the server. The `owner`/`tick`
   * are advisory — the server stamps the authoritative seat and assigns the frame.
   */
  submit(cmd: PlayerCommand): void {
    this.net.submit(cmd);
  }

  /**
   * Advance the engine through every currently-confirmed frame (catch-up), stopping at
   * the first unconfirmed frame (a net stall), on gameover, or at the spiral guard.
   * Returns the events from the LAST stepped frame (for the render layer to consume);
   * empty if nothing advanced this call.
   */
  drive(maxSteps = MAX_CATCHUP_STEPS): readonly GameEvent[] {
    const engine = this.engine;
    if (!engine) return [];
    let last: readonly GameEvent[] = [];
    let stepped = 0;
    while (stepped < maxSteps) {
      const events = engine.advance(this.nextFrame);
      if (events === null) break; // not yet confirmed → stall until the next batch
      this.nextFrame++;
      stepped++;
      last = events;
      if (engine.state.phase === 'gameover') break;
    }
    return last;
  }

  /** How many confirmed frames are queued ahead of the sim (render pacing / catch-up UI). */
  backlog(): number {
    return this.net.confirmedLead?.(this.nextFrame) ?? 0;
  }

  /** Report the local end-of-match hash for the server's re-judge backstop (design/06). */
  reportResult(stateHash: number): void {
    const s = this.engine?.state;
    if (!s) return;
    this.opts.transport.send({ type: 'result', stateHash, winner: s.winner });
  }

  close(): void {
    this.opts.transport.close();
  }
}
