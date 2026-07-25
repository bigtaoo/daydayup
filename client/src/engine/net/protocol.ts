/**
 * The wire protocol for online co-op (design/06, ROADMAP 3.1). Lives in @dd/engine so
 * the client and the server package reference ONE definition — the funny lesson
 * (design/06 "two hand-mirrored copies inevitably drift"): the transport shapes are
 * shared source, not re-declared per side.
 *
 * Unlike funny (which ships opaque `game.proto` bytes the server never decodes),
 * DayDayUp's `PlayerCommand` is already a compact plain-data record (integer
 * brad/mag/buttons — state/commands.ts), so it travels on the wire verbatim. The
 * server still never interprets a command's MEANING; it only buckets commands by
 * frame and broadcasts them (design/06 "server as frame broadcaster").
 *
 * Frame numbering matches the engine: frame 0 is the initial state (no commands ever
 * apply to it); real sim frames start at 1 (GameEngine.advance(frame), frame=tick+1).
 */
import type { PlayerCommand } from '../state/commands';
import type { Winner } from '../state/entities';

/**
 * The confirmed command set for one frame, in the server's authoritative order
 * (design/06 "the server is the sole ordering authority"). A frame with no commands
 * is NOT sent — its absence from a batch's `frames` is an implicit idle-hold, exactly
 * like a sparse Replay stream (replay.ts).
 */
export interface FrameCmds {
  frame: number;
  cmds: readonly PlayerCommand[];
}

/**
 * One broadcast tick (design/06 "broadcast one frame packet per tick"). `toFrame` is
 * the confirmed watermark — every frame ≤ toFrame is now final — and `frames` carries
 * only the non-empty ones since the last batch. A batch with an empty `frames` is a
 * pure metronome pulse: it advances the watermark (so clients keep stepping) with no
 * input. The server never waits for a client, so `toFrame` only ever grows.
 */
export interface FrameBatch {
  toFrame: number;
  frames: readonly FrameCmds[];
}

/** Sent once when the room fills and the match begins — the engine's build config. */
export interface MatchStart {
  seed: number;
  startFrame: number; // first playable frame's predecessor (0)
  localOwner: number; // which seat index this client drives (owner in its PlayerCommands)
  playerCount: number; // total seats — the client builds EngineConfig.players of this length
}

/** Reconnect catch-up (design/06 mirror of funny's conn_resync): replay the frame log past `lastFrame`. */
export interface ConnResync {
  startFrame: number;
  curFrame: number; // watermark to jump to
  log: readonly FrameCmds[]; // the non-empty frames the client is missing (> lastFrame)
}

/** End of match — the server's authoritative outcome (clients also re-judge via runHeadless). */
export interface MatchOver {
  winner: Winner;
  reason: 'extract' | 'wipe' | 'disconnect';
}

/** Server → client. Discriminated on `type` (a tagged union — no protobuf codegen). */
export type ServerMsg =
  | ({ type: 'match_start' } & MatchStart)
  | ({ type: 'frame_batch' } & FrameBatch)
  | ({ type: 'conn_resync' } & ConnResync)
  | ({ type: 'match_over' } & MatchOver)
  | { type: 'error'; code: string; message: string };

/** Client → server. */
export type ClientMsg =
  // Claim a seat in a room. The FIRST joiner's (seed, playerCount) define the match;
  // later joiners must match or are rejected (server cross-checks, mirrors funny's ticket seed).
  | { type: 'join'; roomId: string; owner: number; seed: number; playerCount: number }
  // Relay one locally-produced command. The server assigns its frame (the current
  // batch window) and broadcasts it; `cmd.tick` from the client is advisory only.
  | { type: 'cmd'; cmd: PlayerCommand }
  // Reconnect into an in-progress match, asking for the frame log past `lastFrame`.
  | { type: 'resume'; roomId: string; owner: number; lastFrame: number }
  // Report the client-computed end state for the server's re-judge/audit backstop (design/06).
  | { type: 'result'; stateHash: number; winner: Winner };
