/**
 * The OUTBOUND half of the internal trust seam (design/19 §3, ROADMAP 8.1) — the one helper
 * every cross-service call goes through, so that the three things a bare `fetch` forgets
 * cannot be forgotten at a call site.
 *
 * D2 is why this exists rather than being a style preference. `index.ts`'s ladder callback
 * was `fetch(...).catch(() => {})`: the response body was never consumed. funny shipped that
 * exact shape and MEASURED the consequence under a concurrent burst — an unconsumed undici
 * body keeps its socket checked out of the keep-alive pool, the pool runs dry, and every
 * subsequent request fails with `fetch failed` about 30 s later. The failure mode is not
 * "some reports were slow"; it is that NONE of them arrived, silently, because the call was
 * fire-and-forget in the first place. Low PvP settlement volume is the only reason it had
 * not bitten here yet.
 *
 * The three obligations, in the order they bite:
 *
 *  1. **Always drain or cancel the body.** Even for a 500. Even when the real answer comes
 *     back through another channel and this response carries nothing the caller wants.
 *  2. **An explicit per-attempt timeout.** undici's `fetch` has NO default timeout, so a
 *     half-open socket hangs for tens of seconds rather than failing fast — which is what
 *     turns one stuck peer into a backlog.
 *  3. **Bounded retry ONLY where the call is idempotent and not self-healing.** Retry is
 *     opt-in (`retry` absent = exactly one attempt) because the default has to be the safe
 *     one. A settlement report is worth retrying: it happens once and nothing re-sends it.
 *     A periodic heartbeat (design/19 §6's deferred `GameRegistry`) is NOT: the next tick
 *     re-sends it anyway, so a retry only adds load to a peer that is already struggling.
 *
 * This function NEVER throws and NEVER rejects — every failure is a returned result. A
 * caller in a settlement path must not be able to take the process down with an unhandled
 * rejection, and a caller that wants to log a failure should not have to write a `catch` to
 * find out about one.
 *
 * `fetchImpl`/`sleep` are injection seams: `globalThis.fetch` is read at CALL time (never
 * captured at module scope) so `vi.stubGlobal('fetch', ...)` keeps working, and a test can
 * drive the whole retry ladder without real timers.
 *
 * READING THE PEER'S ANSWER (`collectBody`, added 2026-09-05 for ROADMAP 8.8's store proxy).
 * The first two callers here — the ladder report and the delivery pump — get their real
 * answer from a status code, so obligation 1 was satisfied by CANCELLING the body and this
 * helper never returned one. A PROXY needs the bytes: matchsvc relays billsvc's `{ skus }`,
 * `{ order, payment }` and its `{ error }` refusals to a player's client. `collectBody: true`
 * therefore READS the body instead of cancelling it — which is the same obligation discharged
 * a different way, not an exception to it: `res.text()` consumes the stream and releases the
 * socket exactly as `cancel()` does. It is opt-in because buffering a body a caller will not
 * look at is pure cost, and the default has to be the cheap one.
 *
 * `internalFetchJson` is the whole proxy shape in one place: collect, then parse, and NEVER
 * throw on either. A peer that answers with an HTML error page from something in front of it
 * must degrade to "no usable body" — the same defensive posture `client/src/net/billing.ts`
 * takes on the other end of the same hop, for the same reason.
 */
import { INTERNAL_CALLER_HEADER, INTERNAL_KEY_HEADER } from './internalAuth';

/** Bounded retry. `attempts` counts the TOTAL tries, so `attempts: 1` is "no retry". */
export interface RetryPolicy {
  attempts: number;
  /** First backoff, doubled per further attempt. */
  baseDelayMs?: number;
  /** Ceiling for the doubling, so a long ladder cannot wander into minutes. */
  maxDelayMs?: number;
}

export interface InternalFetchInit {
  method?: string;
  /** JSON request body. Serialized here, with the content-type set to match. */
  json?: unknown;
  /** The `x-internal-key` this process presents. Omitted (unset key) = header not sent, and
   * the peer's `internalAuth` rejects the call — which is the correct, visible outcome. */
  internalKey?: string;
  /** The advisory `x-internal-caller` the peer records in its audit line. */
  caller?: string;
  headers?: Record<string, string>;
  /** Per ATTEMPT, not per call: a 3-attempt ladder can take 3x this plus its backoffs. */
  timeoutMs?: number;
  retry?: RetryPolicy;
  /**
   * Read the response body into the result (as `body`) instead of cancelling it, on the
   * SUCCESS and the http-failure arm alike — a 4xx's `{ error }` is exactly the payload a
   * proxy has to relay. Off by default; see this file's header.
   */
  collectBody?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type InternalFetchFailure =
  /** A response arrived and its status was not 2xx. */
  | 'http'
  /** The attempt exceeded `timeoutMs` and was aborted. */
  | 'timeout'
  /** `fetch` itself threw or rejected — DNS, connection refused, a wedged pool. */
  | 'network';

export type InternalFetchResult =
  | { ok: true; status: number; attempts: number; body?: string }
  | { ok: false; failure: InternalFetchFailure; status?: number; attempts: number; error?: string; body?: string };

export const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Obligation 1, in one place. Ordered by what is actually true of the response rather than
 * by preference: a body already read by someone else must not be read again (that throws),
 * a streaming body is cancelled without buffering it, and a response with no stream at all
 * (204, HEAD, a hand-built test double) is still consumed so nothing is left half-open.
 * Any error draining is swallowed — the socket is released either way, and by this point
 * the status has already been observed.
 */
async function drainBody(res: Response, collect: boolean): Promise<string | undefined> {
  try {
    if (res.bodyUsed) return undefined;
    // READING is draining. `res.text()` consumes the stream and releases the socket exactly
    // as `cancel()` does, so the `collect` branch is obligation 1 discharged rather than
    // skipped — and it deliberately shares this `try`, because a body that errors mid-read
    // must still leave the caller with a status rather than a rejection.
    if (collect) return await res.text();
    if (res.body) {
      await res.body.cancel();
      return undefined;
    }
    await res.arrayBuffer();
  } catch {
    /* already released, or a body that errored mid-drain — nothing left to do either way */
  }
  return undefined;
}

/** One attempt's outcome. A union rather than a bag of optionals so the retry loop below
 *  reads `failure`/`status` only where they provably exist. */
type Attempt =
  | { ok: true; status: number; body?: string }
  | { ok: false; failure: InternalFetchFailure; status?: number; error?: string; retryable: boolean; body?: string };

/**
 * One attempt, with obligations 1 and 2. The `finally` clearing the timer matters as much
 * as the timer itself: a per-attempt `setTimeout` left pending keeps the event loop alive,
 * which on the gameserver means a `SIGTERM` deploy waits for it (see `main()`'s shutdown
 * ordering in `index.ts`, which exists for exactly this class of leak).
 */
async function attemptOnce(url: string, init: InternalFetchInit, body?: string): Promise<Attempt> {
  const doFetch = init.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { ...init.headers };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (init.internalKey !== undefined) headers[INTERNAL_KEY_HEADER] = init.internalKey;
    if (init.caller !== undefined) headers[INTERNAL_CALLER_HEADER] = init.caller;

    const res = await doFetch(url, {
      method: init.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: controller.signal,
    });
    // Before ANY status branch — a 4xx/5xx body is exactly as capable of wedging the pool
    // as a 200's, and it is the error paths that get retried and so drain repeatedly.
    const responseBody = await drainBody(res, init.collectBody === true);

    if (res.status >= 500) {
      return { ok: false, status: res.status, failure: 'http', retryable: true, body: responseBody };
    }
    // Every other non-2xx is the peer saying no on purpose — a rejected key, a malformed
    // body, a route that does not exist. Repeating it verbatim cannot change the answer, so
    // 4xx is never retried (429 is not special-cased: these callers are our own processes,
    // and nothing here rate-limits them).
    if (!res.ok) return { ok: false, status: res.status, failure: 'http', retryable: false, body: responseBody };
    return { ok: true, status: res.status, body: responseBody };
  } catch (err) {
    // `signal.aborted` is what distinguishes our own timeout from the peer refusing the
    // connection; both are retryable, but only one of them means "we gave up", and an
    // operator reading the log needs to know which.
    if (controller.signal.aborted) {
      return { ok: false, failure: 'timeout', retryable: true, error: `timed out after ${init.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` };
    }
    return { ok: false, failure: 'network', retryable: true, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Capped exponential backoff. `attempt` is 1-based: the wait AFTER the first failure. */
export function retryDelayMs(attempt: number, retry: RetryPolicy): number {
  const base = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  return Math.min(base * 2 ** (attempt - 1), max);
}

/**
 * Call another one of our processes. Resolves to a result; never rejects.
 *
 * The retry loop stops on the first of three conditions: success, a non-retryable failure
 * (any 4xx — see `attemptOnce`), or the attempt budget. `attempts` in the result is the
 * number actually made, which is what a log line needs to distinguish "the peer was down
 * for a moment" from "the peer refused us three times".
 */
export async function internalFetch(url: string, init: InternalFetchInit = {}): Promise<InternalFetchResult> {
  const body = init.json === undefined ? undefined : JSON.stringify(init.json);
  const retry: RetryPolicy = init.retry ?? { attempts: 1 };
  const budget = Math.max(1, retry.attempts);
  const sleep = init.sleep ?? defaultSleep;

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const outcome = await attemptOnce(url, init, body);
    if (outcome.ok) return { ok: true, status: outcome.status, attempts, body: outcome.body };
    if (!outcome.retryable || attempts >= budget) {
      return {
        ok: false,
        failure: outcome.failure,
        status: outcome.status,
        attempts,
        error: outcome.error,
        body: outcome.body,
      };
    }
    await sleep(retryDelayMs(attempts, retry));
  }
}

/**
 * The proxy shape: call a peer, and hand back BOTH the transport result and the peer's parsed
 * JSON body. Never throws and never rejects, for the same reason `internalFetch` does not —
 * and with one addition of its own: a body that is not JSON (a load balancer's HTML 502, a
 * truncated response, an empty 204) resolves to `json: null` rather than a `SyntaxError`.
 *
 * `result` is carried verbatim rather than flattened, so a caller still reads `status`,
 * `failure` and `attempts` off exactly the union `internalFetch` documents; `json` is the
 * only thing this wrapper adds. `json` is `unknown` on purpose: the peer's answer is data
 * arriving over a network, and a generic parameter here would only let a caller assert a
 * shape nobody checked.
 */
export interface InternalJsonResult {
  result: InternalFetchResult;
  json: unknown;
}

export async function internalFetchJson(url: string, init: InternalFetchInit = {}): Promise<InternalJsonResult> {
  const result = await internalFetch(url, { ...init, collectBody: true });
  if (result.body === undefined || result.body.length === 0) return { result, json: null };
  try {
    return { result, json: JSON.parse(result.body) as unknown };
  } catch {
    return { result, json: null };
  }
}
