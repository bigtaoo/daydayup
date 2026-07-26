/**
 * Matchmaker (ROADMAP 3.3, design/06) — the control plane's pure queue/grouping core.
 * It pools players who asked for a match, and the moment enough of them want the same
 * shape (playerCount) it forms a room: one shared `seed`, one `roomId`, and a DISTINCT
 * seat (`owner`) per player, each handed a signed ticket the gameserver will trust.
 *
 * Mirrors the repo's MatchRoom/RoomManager pattern: ALL non-determinism is injected
 * (`nowMs` / `nextSeed` / `newRoomId` / `sign`), so the whole queue lifecycle is unit-
 * testable with fakes — no timers, no sockets, no crypto secret. The HTTP shell
 * (matchsvc.ts) is the only thing that wires the real clock/seed/signer around it.
 *
 * Transport model is deliberately poll-based (matchsvc: POST /find → GET /find/:id): a
 * `find` enqueues and returns a `queueId`; the client polls until its seat is `matched`.
 * The player whose arrival completes a group gets its ticket back inline from `enqueue`.
 */
import type { MatchMode, TicketPayload } from './ticket';

export interface MatchmakerDeps {
  /** Epoch ms — for ticket `exp` and queued-waiter TTL. Injected (real: Date.now). */
  nowMs(): number;
  /** The shared match seed. Injected so tests are deterministic (real: a PRNG/counter). */
  nextSeed(): number;
  /** A fresh room id. Injected (real: a uuid/counter). */
  newRoomId(): string;
  /** Sign a seat grant into a token. Injected — the secret lives in the shell, not here. */
  sign?: (payload: TicketPayload) => string;
  /** Ticket lifetime from formation (ms). Default 30 s — long enough to open the socket. */
  ticketTtlMs?: number;
  /** How long a still-waiting player lives before poll reports `expired` (ms). Default 30 s. */
  queueTtlMs?: number;
}

/** One player's seat assignment — everything the client needs to open the /ws socket. */
export interface MatchTicket {
  roomId: string;
  owner: number;
  seed: number;
  playerCount: number;
  mode: MatchMode;
  token: string;
}

export type EnqueueResult = { queueId: string; ticket?: MatchTicket };
export type PollResult =
  | { status: 'queued' }
  | { status: 'matched'; ticket: MatchTicket }
  | { status: 'expired' };

export const MAX_PLAYERS = 8; // design/06 match-size ceiling (5v5 proven); co-op is ≤4

const DEFAULT_TICKET_TTL_MS = 30_000;
const DEFAULT_QUEUE_TTL_MS = 30_000;

interface Waiter {
  queueId: string;
  playerCount: number;
  mode: MatchMode;
  enqueuedAt: number;
  ticket: MatchTicket | null; // filled the instant its group forms
}

/** A coop 2-seat waiter and a pvp 2-seat waiter must never group together — key the
 * queue by BOTH, not playerCount alone. */
const queueKey = (playerCount: number, mode: MatchMode): string => `${mode}:${playerCount}`;

export class Matchmaker {
  private readonly waiters = new Map<string, Waiter>();
  /** FIFO of still-waiting queueIds per requested (mode, playerCount) shape. */
  private readonly queues = new Map<string, string[]>();
  private counter = 0;
  private readonly ticketTtlMs: number;
  private readonly queueTtlMs: number;
  private readonly sign: (p: TicketPayload) => string;

  constructor(private readonly deps: MatchmakerDeps) {
    this.ticketTtlMs = deps.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;
    this.queueTtlMs = deps.queueTtlMs ?? DEFAULT_QUEUE_TTL_MS;
    // Default signer uses the injected `sign`; a caller can omit it in a test that only
    // asserts grouping (tokens are then empty — verify is covered by ticket.test.ts).
    this.sign = deps.sign ?? (() => '');
  }

  /** Live waiter count for a (playerCount, mode) shape (test/observability). Reaps expired entries first. */
  waiting(playerCount: number, mode: MatchMode = 'coop'): number {
    return this.liveQueue(playerCount, mode).length;
  }

  /**
   * Enqueue a request for a `playerCount`-seat match of the given `mode` (default
   * 'coop', so every pre-PvP caller is unaffected). Returns a `queueId` to poll with;
   * if this arrival completes a group, its own `ticket` is returned inline too. Throws a
   * RangeError for an out-of-bounds playerCount (the shell maps it to HTTP 400).
   */
  enqueue(playerCount: number, mode: MatchMode = 'coop'): EnqueueResult {
    if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > MAX_PLAYERS) {
      throw new RangeError(`playerCount must be an integer in [1, ${MAX_PLAYERS}]`);
    }
    const queueId = `q${++this.counter}`;
    const waiter: Waiter = { queueId, playerCount, mode, enqueuedAt: this.deps.nowMs(), ticket: null };
    this.waiters.set(queueId, waiter);
    this.liveQueue(playerCount, mode).push(queueId);

    this.formIfReady(playerCount, mode);
    return waiter.ticket ? { queueId, ticket: waiter.ticket } : { queueId };
  }

  /** Poll a queued request. `matched` is one-shot — the entry is dropped after it's read. */
  poll(queueId: string): PollResult {
    const waiter = this.waiters.get(queueId);
    if (!waiter) return { status: 'expired' }; // unknown or already reaped/collected
    if (waiter.ticket) {
      this.waiters.delete(queueId);
      return { status: 'matched', ticket: waiter.ticket };
    }
    if (this.deps.nowMs() - waiter.enqueuedAt > this.queueTtlMs) {
      this.dropWaiting(waiter);
      return { status: 'expired' };
    }
    return { status: 'queued' };
  }

  // ───────────────────────── internals ─────────────────────────

  /** The (playerCount, mode) shape's queue with expired still-waiting entries reaped out. */
  private liveQueue(playerCount: number, mode: MatchMode): string[] {
    const key = queueKey(playerCount, mode);
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    const now = this.deps.nowMs();
    const live: string[] = [];
    for (const id of q) {
      const w = this.waiters.get(id);
      if (!w || w.ticket) continue; // gone or already matched
      if (now - w.enqueuedAt > this.queueTtlMs) {
        this.waiters.delete(id);
        continue;
      }
      live.push(id);
    }
    q.length = 0;
    q.push(...live);
    return q;
  }

  /** Form a match while the (playerCount, mode) shape has a full group of live waiters. */
  private formIfReady(playerCount: number, mode: MatchMode): void {
    const q = this.liveQueue(playerCount, mode);
    while (q.length >= playerCount) {
      const group = q.splice(0, playerCount);
      const roomId = this.deps.newRoomId();
      const seed = this.deps.nextSeed();
      const exp = this.deps.nowMs() + this.ticketTtlMs;
      group.forEach((id, owner) => {
        const w = this.waiters.get(id);
        if (!w) return;
        const grant: TicketPayload = { roomId, owner, seed, playerCount, exp, mode };
        w.ticket = { roomId, owner, seed, playerCount, mode, token: this.sign(grant) };
      });
    }
  }

  private dropWaiting(waiter: Waiter): void {
    this.waiters.delete(waiter.queueId);
    const q = this.queues.get(queueKey(waiter.playerCount, waiter.mode));
    if (q) {
      const i = q.indexOf(waiter.queueId);
      if (i >= 0) q.splice(i, 1);
    }
  }
}
