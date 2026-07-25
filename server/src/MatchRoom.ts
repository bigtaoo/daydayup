/**
 * One co-op match — the server-side room (design/06, ROADMAP 3.1). A thin lifecycle
 * shell around the pure @dd/engine FrameBroadcast core: it fills seats, starts the
 * metronome when the room is full, relays each client's commands into the broadcaster,
 * and fans the resulting batches back out. It is the co-op adaptation of funny's
 * `gameserver/src/Room.ts`, minus the PvP concerns DayDayUp doesn't have (sides/ELO/
 * decks/ticket settlement) and generalised from 2 fixed sides to N co-op seats.
 *
 * Deliberately free of any socket/timer import: the WebSocket glue lives only in the
 * entrypoint (index.ts), which passes in a `Scheduler` (the metronome clock) and
 * `RoomConnection`s (per-seat senders). That keeps the whole lifecycle — seat
 * assignment, match start, batch broadcast, reconnect, settlement — unit-testable with
 * a fake clock and fake connections (see test/MatchRoom.test.ts). The determinism-
 * critical relay logic it wraps is already proven in @dd/engine's own tests.
 */
import { FrameBroadcast, type PlayerCommand, type ServerMsg, type Winner } from '@dd/engine';

/** A per-seat sink — one connected client. The transport wraps a socket as this. */
export interface RoomConnection {
  /** Which co-op seat this connection drives (its `owner` in every PlayerCommand). */
  readonly owner: number;
  send(msg: ServerMsg): void;
}

/** The metronome clock, injected so tests can drive it by hand (no real timers). */
export interface Scheduler {
  setInterval(fn: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}
export type IntervalHandle = unknown;

export interface MatchRoomDeps {
  scheduler: Scheduler;
  onDestroy: (roomId: string) => void;
  /** Broadcast pulse period (ms). Default 100 (10 Hz, funny). */
  batchMs?: number;
  /** Sim frames per pulse. Default 3 (30 Hz sim ÷ 10 Hz net). Must match the client. */
  framesPerBatch?: number;
}

const Phase = { WAITING: 0, IN_MATCH: 1, OVER: 2 } as const;
type PhaseVal = (typeof Phase)[keyof typeof Phase];

const DEFAULT_BATCH_MS = 100;
const DEFAULT_FRAMES_PER_BATCH = 3;
const START_FRAME = 0;

interface Seat {
  owner: number;
  conn: RoomConnection | null;
}

export class MatchRoom {
  phase: PhaseVal = Phase.WAITING;
  private readonly seats: Seat[];
  private readonly broadcast: FrameBroadcast;
  private readonly batchMs: number;
  private metronome: IntervalHandle | null = null;
  private readonly results = new Map<number, { hash: number; winner: Winner }>();
  private settled = false;

  constructor(
    readonly roomId: string,
    private readonly seed: number,
    private readonly playerCount: number,
    private readonly deps: MatchRoomDeps,
  ) {
    this.batchMs = deps.batchMs ?? DEFAULT_BATCH_MS;
    this.broadcast = new FrameBroadcast({
      framesPerBatch: deps.framesPerBatch ?? DEFAULT_FRAMES_PER_BATCH,
      startFrame: START_FRAME,
    });
    this.seats = Array.from({ length: playerCount }, (_, owner) => ({ owner, conn: null }));
  }

  get seedValue(): number {
    return this.seed;
  }
  get playerCountValue(): number {
    return this.playerCount;
  }
  get frame(): number {
    return this.broadcast.frame;
  }
  private get connected(): boolean {
    return this.seats.every((s) => s.conn !== null);
  }

  // ───────────────────────── join / start ─────────────────────────

  /**
   * Claim a seat. The room fills in seat (owner) order; once every seat has a
   * connection the match launches. Returns false (and the caller closes the socket)
   * for an out-of-range or already-taken seat, or a join after the match started
   * (a reconnect must use `resume`, not `join`).
   */
  join(conn: RoomConnection): boolean {
    if (this.phase !== Phase.WAITING) return false;
    const seat = this.seats[conn.owner];
    if (!seat || seat.conn !== null) return false;
    seat.conn = conn;
    if (this.connected) this.launch();
    return true;
  }

  private launch(): void {
    this.phase = Phase.IN_MATCH;
    for (const seat of this.seats) {
      seat.conn?.send({
        type: 'match_start',
        seed: this.seed,
        startFrame: START_FRAME,
        localOwner: seat.owner,
        playerCount: this.playerCount,
      });
    }
    this.startMetronome();
  }

  // ───────────────────────── in-match relay ─────────────────────────

  /**
   * Relay a command from a seat. The server is the seat authority: it stamps the
   * command's `owner` from the connection (never trusts a client-sent owner) so a
   * client can only ever move its own player. The frame is assigned by the metronome
   * (the command lands on the current window's `toFrame`).
   */
  submitCmd(owner: number, cmd: PlayerCommand): void {
    if (this.phase !== Phase.IN_MATCH) return;
    if (!this.seats[owner]) return;
    this.broadcast.submit({ ...cmd, owner });
  }

  private startMetronome(): void {
    if (this.metronome !== null) return;
    if (!this.connected) return;
    this.metronome = this.deps.scheduler.setInterval(() => this.pulse(), this.batchMs);
  }

  private stopMetronome(): void {
    if (this.metronome !== null) {
      this.deps.scheduler.clearInterval(this.metronome);
      this.metronome = null;
    }
  }

  /** One broadcast pulse — advance the shared clock and fan the batch out to every seat. */
  private pulse(): void {
    const batch = this.broadcast.tick();
    this.sendAll({ type: 'frame_batch', ...batch });
  }

  private sendAll(msg: ServerMsg): void {
    for (const seat of this.seats) seat.conn?.send(msg);
  }

  // ───────────────────────── reconnect ─────────────────────────

  /**
   * A client rejoins mid-match. Rebind its seat, send the frame log it missed
   * (everything after `lastFrame`) plus the current watermark, and resume the
   * metronome once every seat is connected again (it pauses on a disconnect).
   */
  resume(conn: RoomConnection, lastFrame: number): boolean {
    const seat = this.seats[conn.owner];
    if (!seat || this.phase !== Phase.IN_MATCH || this.settled) return false;
    seat.conn = conn;
    conn.send({
      type: 'conn_resync',
      startFrame: START_FRAME,
      curFrame: this.broadcast.frame,
      log: this.broadcast.logSince(lastFrame),
    });
    if (this.connected) this.startMetronome();
    return true;
  }

  /**
   * A connection dropped. Free its seat and pause the metronome (the shared clock
   * cannot advance past a player who can't receive it — co-op is latency-tolerant, so
   * it waits for a reconnect rather than forfeiting). If every seat is gone, destroy.
   */
  onDisconnect(conn: RoomConnection): void {
    const seat = this.seats[conn.owner];
    if (!seat || seat.conn !== conn) return; // already replaced by a newer connection
    seat.conn = null;
    if (this.phase === Phase.IN_MATCH) this.stopMetronome();
    if (this.seats.every((s) => s.conn === null)) this.destroy();
  }

  // ───────────────────────── settlement ─────────────────────────

  /**
   * A client reports its end-of-match state (the deterministic hash + the outcome).
   * Once every seat has reported, the room settles: it broadcasts `match_over` and
   * destroys itself. Divergent hashes are flagged (design/06: the authoritative
   * backstop is a server-side runHeadless re-judge, not realtime trust).
   */
  reportResult(owner: number, stateHash: number, winner: Winner): void {
    if (this.phase !== Phase.IN_MATCH || this.settled) return;
    if (!this.seats[owner]) return;
    this.results.set(owner, { hash: stateHash, winner });
    if (this.results.size < this.playerCount) return;

    const reports = [...this.results.values()];
    const hashOk = reports.every((r) => r.hash === reports[0]!.hash);
    const agreedWinner = reports[0]!.winner;
    this.settled = true;
    this.stopMetronome();
    this.phase = Phase.OVER;
    this.sendAll({
      type: 'match_over',
      winner: agreedWinner,
      reason: hashOk ? (agreedWinner === 'enemies' ? 'wipe' : 'extract') : 'disconnect',
    });
    this.destroy();
  }

  destroy(): void {
    this.stopMetronome();
    this.deps.onDestroy(this.roomId);
  }
}
