/**
 * Drives a `CoopSession` through a mid-match transport failure (ROADMAP reconnect,
 * design/06). The server side of this — `resume`/`conn_resync`, `MatchRoom.resume()` —
 * has existed since ROADMAP 3.1, but nothing ever called it: `CoopSession.onDisconnect`
 * was wired for the pre-match-start "connecting" race only (`onlineConnect.ts`), and a
 * drop AFTER `match_start` just left the client stalled forever with no error and no
 * retry. This module is the missing driver.
 *
 * The ORIGINAL match ticket is almost always expired by the time a drop happens (30s
 * TTL vs. a match that runs for minutes — `net/matchmaking.ts`'s `requestResume` mints
 * a fresh one), so a reconnect is: ask matchsvc for a new short-lived ticket for the
 * same seat, open a new transport, hand it to `session.reconnect()`. Bounded retries
 * with backoff — co-op is latency-tolerant (the server pauses rather than forfeits a
 * dropped seat), but not infinitely so from the client's own perspective; `onGiveUp`
 * lets the caller show a real failure state instead of a silent freeze.
 */
import type { CoopSession } from './CoopSession';
import { WebSocketTransport, type Transport } from './transport';
import { requestResume } from './matchmaking';

export interface ReconnectOptions {
  matchBaseUrl: string;
  /** The ticket last used to connect (the original `/find` ticket, or a prior resume's
   *  reissued one) — the proof-of-prior-seat `requestResume` verifies. */
  initialToken: string;
  /** Give up after this many attempts. Default 5. */
  maxAttempts?: number;
  /** Backoff before attempt `n` (1-based). Default: capped exponential (1s, 2s, 4s, 8s, 10s...). */
  backoffMs?: (attempt: number) => number;
  onReconnecting?: (attempt: number) => void;
  onReconnected?: () => void;
  /** The loop is exhausted, or the server told us the match is definitively gone
   *  (`resume_failed`) — nothing left to retry. */
  onGiveUp?: (reason: string) => void;
  /** Injected for tests; default: the global fetch / a real timer / a real WebSocket. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  createTransport?: (url: string) => Transport;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const defaultBackoff = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 10_000);

/**
 * Wires `session`'s disconnect/server-error signals to a bounded reconnect loop, and
 * immediately starts the first attempt — the caller invokes this FROM its own
 * `session.onDisconnect` handler (a single-slot registration `reconnect.ts` then takes
 * over: the `session.onDisconnect` call below re-arms it for any LATER drop, e.g. from
 * the fresh transport a successful reconnect just installed, but does nothing about the
 * drop that's already in progress right now — that's why this function starts the
 * first attempt itself rather than waiting to be re-entered). Idempotent to re-entry:
 * a disconnect that fires while an attempt is already in flight is ignored (the
 * in-flight attempt owns the retry sequence).
 */
export function driveReconnect(session: CoopSession, opts: ReconnectOptions): void {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const maxAttempts = opts.maxAttempts ?? 5;
  const backoff = opts.backoffMs ?? defaultBackoff;
  let token = opts.initialToken;
  let inFlight = false;

  session.onServerError((code, message) => {
    if (code === 'resume_failed') {
      inFlight = false; // nothing more to retry — the match itself is gone
      opts.onGiveUp?.(message);
    }
  });

  const start = (): void => {
    if (inFlight) return; // a retry sequence already owns recovery
    inFlight = true;
    void attempt(1);
  };
  session.onDisconnect(start); // covers any FUTURE drop (a fresh post-reconnect transport)
  start(); // and kicks off for the drop that's happening right now

  async function attempt(n: number): Promise<void> {
    opts.onReconnecting?.(n);
    await sleep(backoff(n));
    try {
      const info = await requestResume(opts.matchBaseUrl, token, { fetch: doFetch });
      token = info.token; // keep the latest reissued ticket for a possible NEXT drop
      const url = `${info.wsUrl}?ticket=${encodeURIComponent(info.token)}`;
      const transport = opts.createTransport ? opts.createTransport(url) : new WebSocketTransport(url);
      session.reconnect(transport);
      // Optimistic: the socket opened and `resume` was sent. A definitive failure still
      // arrives async via `resume_failed` (handled above) if the room turned out to be
      // gone; a further transport-level failure re-triggers this same disconnect handler.
      inFlight = false;
      opts.onReconnected?.();
    } catch (e) {
      if (n >= maxAttempts) {
        inFlight = false;
        opts.onGiveUp?.(e instanceof Error ? e.message : String(e));
        return;
      }
      void attempt(n + 1);
    }
  }
}
