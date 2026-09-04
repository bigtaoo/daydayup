/**
 * `src/internalFetch.ts` — the outbound half of the internal trust seam (design/19 §3,
 * ROADMAP 8.1), and the fix for D2.
 *
 * The defect this module exists for is invisible to an ordinary integration test: a
 * `fetch(...).catch(() => {})` that never reads its response body passes every functional
 * assertion you can write about one call, and only fails under a concurrent burst, ~30 s
 * later, by which point NOTHING is arriving. So the property that matters —
 * **the body is always released** — is asserted directly, on every exit the function has:
 * 2xx, 4xx, 5xx, and on each attempt of a retry ladder rather than only the last.
 *
 * `bodyUsed` on a real `Response` is the honest witness for that: it reports whether the
 * stream has been disturbed, and a `cancel()` disturbs it. Two cases use real `Response`
 * objects for exactly this reason; the rest use a recording double where the assertion is
 * about how many times the drain happened, which a real `Response` cannot answer.
 *
 * The other three things pinned here are all "the safe default is the DEFAULT":
 *  - no `retry` means exactly one attempt (a caller who forgot cannot get at-least-once);
 *  - a 4xx is never retried and a 5xx always is, because repeating a refusal verbatim
 *    cannot change the answer while a 500 is usually the peer restarting;
 *  - the function never rejects, so a fire-and-forget caller in a settlement path cannot
 *    take the process down with an unhandled rejection.
 */
import { describe, it, expect, vi } from 'vitest';
import { INTERNAL_CALLER_HEADER, INTERNAL_KEY_HEADER } from '../src/internalAuth';
import { DEFAULT_TIMEOUT_MS, internalFetch, retryDelayMs } from '../src/internalFetch';

/** Never sleep for real: every retry case below would otherwise pay its own backoff. */
const noSleep = () => Promise.resolve();

interface Recorded {
  url: string;
  init: RequestInit;
}

/**
 * A `fetch` double that records calls and hands back responses from a script, plus a
 * per-response `cancelled` counter — the thing a real `Response` cannot report, since
 * `bodyUsed` is a boolean and this file needs to know the drain happened on EVERY attempt.
 */
function scriptedFetch(script: Array<{ status?: number; throws?: unknown }>): {
  impl: typeof fetch;
  calls: Recorded[];
  cancels: number;
  bodiesLeftOpen: () => number;
} {
  const calls: Recorded[] = [];
  const state = { cancels: 0, open: 0 };
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)]!;
    if (step.throws !== undefined) throw step.throws;
    state.open += 1;
    return {
      status: step.status ?? 200,
      get ok() {
        return (step.status ?? 200) >= 200 && (step.status ?? 200) < 300;
      },
      bodyUsed: false,
      body: {
        cancel: async () => {
          state.cancels += 1;
          state.open -= 1;
        },
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    impl,
    calls,
    get cancels() {
      return state.cancels;
    },
    bodiesLeftOpen: () => state.open,
  };
}

describe('internalFetch — obligation 1: the response body is ALWAYS released (D2)', () => {
  it('drains a 200 body — a real Response reports bodyUsed after the call', async () => {
    const res = new Response('{"changes":[]}', { status: 200 });
    const result = await internalFetch('http://peer.test/x', {
      json: { a: 1 },
      fetchImpl: (async () => res) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, status: 200, attempts: 1 });
    expect(res.bodyUsed).toBe(true);
  });

  it('drains a 4xx body too — an error response wedges the pool exactly as well as a 200', async () => {
    const res = new Response('{"error":"unauthorized"}', { status: 401 });
    const result = await internalFetch('http://peer.test/x', {
      fetchImpl: (async () => res) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ ok: false, failure: 'http', status: 401 });
    expect(res.bodyUsed).toBe(true);
  });

  it('drains on EVERY attempt of a retry ladder, not just the last one', async () => {
    // The regression this guards: draining after the loop instead of inside it looks
    // correct and leaves attempts 1..n-1 checked out — which is the burst case exactly.
    const f = scriptedFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const result = await internalFetch('http://peer.test/x', {
      json: {},
      fetchImpl: f.impl,
      retry: { attempts: 3 },
      sleep: noSleep,
    });
    expect(result).toMatchObject({ ok: false, failure: 'http', status: 500, attempts: 3 });
    expect(f.calls).toHaveLength(3);
    expect(f.cancels).toBe(3);
    expect(f.bodiesLeftOpen()).toBe(0);
  });

  it('consumes a response with no stream (204 / HEAD / a hand-built double)', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const res = { status: 204, ok: true, bodyUsed: false, body: null, arrayBuffer } as unknown as Response;
    const result = await internalFetch('http://peer.test/x', {
      fetchImpl: (async () => res) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, status: 204, attempts: 1 });
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it('leaves an ALREADY-consumed body alone (reading it twice throws)', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const cancel = vi.fn(async () => {});
    const res = {
      status: 200,
      ok: true,
      bodyUsed: true,
      body: { cancel },
      arrayBuffer,
    } as unknown as Response;
    const result = await internalFetch('http://peer.test/x', {
      fetchImpl: (async () => res) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, status: 200, attempts: 1 });
    expect(cancel).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('a body that THROWS while draining does not fail the call — the status was already read', async () => {
    const res = {
      status: 200,
      ok: true,
      bodyUsed: false,
      body: {
        cancel: async () => {
          throw new Error('stream already errored');
        },
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
    const result = await internalFetch('http://peer.test/x', {
      fetchImpl: (async () => res) as unknown as typeof fetch,
    });
    expect(result).toEqual({ ok: true, status: 200, attempts: 1 });
  });
});

describe('internalFetch — obligation 2: an explicit per-attempt timeout', () => {
  it('passes an AbortSignal on every request (undici fetch has no default timeout)', async () => {
    const f = scriptedFetch([{ status: 200 }]);
    await internalFetch('http://peer.test/x', { fetchImpl: f.impl });
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(f.calls[0]!.init.signal!.aborted).toBe(false);
  });

  it('aborts a hanging attempt and reports it as a TIMEOUT, not a network error', async () => {
    // A real hang: the double resolves only when its own signal fires, which is what the
    // wedged-pool case actually looks like from here.
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      })) as unknown as typeof fetch;
    const result = await internalFetch('http://peer.test/x', { fetchImpl: hang, timeoutMs: 5 });
    expect(result).toMatchObject({ ok: false, failure: 'timeout', attempts: 1 });
    expect(result.ok === false && result.error).toContain('5ms');
  });

  it('retries a timeout — a stuck socket is transient, unlike a refusal', async () => {
    let call = 0;
    const impl = ((_url: string, init: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Promise((_r, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;
    const result = await internalFetch('http://peer.test/x', {
      fetchImpl: impl,
      timeoutMs: 5,
      retry: { attempts: 2 },
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: true, status: 200, attempts: 2 });
  });

  it('applies DEFAULT_TIMEOUT_MS when the caller names none', async () => {
    // The default is the case that actually ships — `reportSettledMatch` passes no
    // `timeoutMs` — so "an omitted timeout still aborts" is the property worth pinning, not
    // just that the constant is finite. Fake timers so the assertion costs no wall clock.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_TIMEOUT_MS)).toBe(true);
    vi.useFakeTimers();
    try {
      const hang = ((_url: string, init: RequestInit) =>
        new Promise((_r, reject) =>
          init.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        )) as unknown as typeof fetch;
      const pending = internalFetch('http://peer.test/x', { fetchImpl: hang });
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
      const result = await pending;
      expect(result).toMatchObject({ ok: false, failure: 'timeout', attempts: 1 });
      expect(result.ok === false && result.error).toContain(String(DEFAULT_TIMEOUT_MS));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('internalFetch — obligation 3: bounded retry, opt-in only', () => {
  it('makes exactly ONE attempt when no retry policy is given', async () => {
    const f = scriptedFetch([{ status: 500 }]);
    const result = await internalFetch('http://peer.test/x', { fetchImpl: f.impl, sleep: noSleep });
    expect(result).toMatchObject({ ok: false, failure: 'http', status: 500, attempts: 1 });
    expect(f.calls).toHaveLength(1);
  });

  it('retries a 5xx and reports the attempt it finally succeeded on', async () => {
    const f = scriptedFetch([{ status: 503 }, { status: 200 }]);
    const result = await internalFetch('http://peer.test/x', {
      fetchImpl: f.impl,
      retry: { attempts: 3 },
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: true, status: 200, attempts: 2 });
    expect(f.calls).toHaveLength(2); // stopped as soon as it worked
  });

  it.each([400, 401, 403, 404, 409, 422, 429])(
    'never retries %i — repeating a refusal verbatim cannot change the answer',
    async (status) => {
      const f = scriptedFetch([{ status }, { status: 200 }]);
      const result = await internalFetch('http://peer.test/x', {
        fetchImpl: f.impl,
        retry: { attempts: 5 },
        sleep: noSleep,
      });
      expect(result).toMatchObject({ ok: false, failure: 'http', status, attempts: 1 });
      expect(f.calls).toHaveLength(1);
    },
  );

  it('retries a network throw, then gives up at the budget', async () => {
    const f = scriptedFetch([{ throws: new Error('ECONNREFUSED') }]);
    const result = await internalFetch('http://peer.test/x', {
      fetchImpl: f.impl,
      retry: { attempts: 3 },
      sleep: noSleep,
    });
    expect(result).toMatchObject({ ok: false, failure: 'network', attempts: 3 });
    expect(result.ok === false && result.error).toContain('ECONNREFUSED');
    expect(f.calls).toHaveLength(3);
  });

  it('a non-Error throw still yields a described failure rather than "[object Object]"', async () => {
    const f = scriptedFetch([{ throws: 'a bare string rejection' }]);
    const result = await internalFetch('http://peer.test/x', { fetchImpl: f.impl });
    expect(result.ok === false && result.error).toBe('a bare string rejection');
  });

  it('sleeps between attempts with capped exponential backoff, and not after the last one', async () => {
    const slept: number[] = [];
    const f = scriptedFetch([{ status: 500 }]);
    await internalFetch('http://peer.test/x', {
      fetchImpl: f.impl,
      retry: { attempts: 4, baseDelayMs: 100, maxDelayMs: 250 },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    // 3 gaps for 4 attempts — a 4th sleep would be time spent waiting to do nothing.
    expect(slept).toEqual([100, 200, 250]);
  });

  it('`attempts: 1` and `attempts: 0` both mean one attempt (the budget is a floor)', async () => {
    for (const attempts of [1, 0, -5]) {
      const f = scriptedFetch([{ status: 500 }]);
      const result = await internalFetch('http://peer.test/x', {
        fetchImpl: f.impl,
        retry: { attempts },
        sleep: noSleep,
      });
      expect(result.attempts).toBe(1);
      expect(f.calls).toHaveLength(1);
    }
  });

  it('waits on a real timer between attempts when no sleep is injected', async () => {
    // Every other retry case injects a fake sleep, so the SHIPPED backoff — the one
    // production actually runs — would otherwise never execute. Driven with fake timers
    // rather than a short real delay plus a wall-clock assertion: `Date.now()` has ~15ms
    // granularity on Windows, so `elapsed >= 1` after a 1ms sleep reads 0 often enough to
    // go red in CI while proving nothing when it passes.
    vi.useFakeTimers();
    try {
      const f = scriptedFetch([{ status: 500 }, { status: 200 }]);
      const pending = internalFetch('http://peer.test/x', {
        fetchImpl: f.impl,
        retry: { attempts: 2, baseDelayMs: 25 },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(await pending).toEqual({ ok: true, status: 200, attempts: 2 });
      expect(f.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retryDelayMs is exponential from the base and clamped by the max', () => {
    const policy = { attempts: 9, baseDelayMs: 100, maxDelayMs: 500 };
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, policy))).toEqual([100, 200, 400, 500, 500]);
  });

  it('retryDelayMs has real defaults when the policy names neither bound', () => {
    const delays = [1, 2, 3, 4, 5, 6].map((n) => retryDelayMs(n, { attempts: 6 }));
    expect(delays[0]).toBeGreaterThan(0);
    expect(delays).toEqual([...delays].sort((a, b) => a - b)); // monotonic
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_000); // and capped
  });
});

describe('internalFetch — the request it actually builds', () => {
  it('sends the internal key and the advisory caller header, and a JSON content-type', async () => {
    const f = scriptedFetch([{ status: 200 }]);
    await internalFetch('http://peer.test/rating/report', {
      json: { accountIds: ['a'], places: [1] },
      internalKey: 'the-key',
      caller: 'gameserver',
      fetchImpl: f.impl,
    });
    const { url, init } = f.calls[0]!;
    expect(url).toBe('http://peer.test/rating/report');
    expect(init.method).toBe('POST'); // a json body implies POST
    const headers = init.headers as Record<string, string>;
    expect(headers[INTERNAL_KEY_HEADER]).toBe('the-key');
    expect(headers[INTERNAL_CALLER_HEADER]).toBe('gameserver');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ accountIds: ['a'], places: [1] });
  });

  it('omits the key header entirely when no key is configured (fail closed, visibly)', async () => {
    // `config.ts`'s production branch returns no key; sending a placeholder would have to be
    // recognised as one somewhere, so nothing is sent and the peer refuses out loud.
    const f = scriptedFetch([{ status: 401 }]);
    await internalFetch('http://peer.test/x', { json: {}, fetchImpl: f.impl });
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(INTERNAL_KEY_HEADER in headers).toBe(false);
    expect(INTERNAL_CALLER_HEADER in headers).toBe(false);
  });

  it('defaults to GET with no body, and keeps caller-supplied headers', async () => {
    const f = scriptedFetch([{ status: 200 }]);
    await internalFetch('http://peer.test/x', { fetchImpl: f.impl, headers: { 'x-trace': 't1' } });
    const { init } = f.calls[0]!;
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['x-trace']).toBe('t1');
    expect('content-type' in (init.headers as Record<string, string>)).toBe(false);
  });

  it('an explicit method wins over the body-derived default', async () => {
    const f = scriptedFetch([{ status: 200 }]);
    await internalFetch('http://peer.test/x', { method: 'PUT', json: { a: 1 }, fetchImpl: f.impl });
    expect(f.calls[0]!.init.method).toBe('PUT');
  });

  it('uses the CURRENT globalThis.fetch when none is injected (so vi.stubGlobal works)', async () => {
    const stub = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', stub);
    try {
      const result = await internalFetch('http://peer.test/x');
      expect(result).toEqual({ ok: true, status: 200, attempts: 1 });
      expect(stub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('internalFetch — never rejects', () => {
  it.each([
    ['a rejecting fetch', (async () => Promise.reject(new Error('down'))) as unknown as typeof fetch],
    [
      'a synchronously throwing fetch',
      (() => {
        throw new Error('threw before any promise');
      }) as unknown as typeof fetch,
    ],
  ])('%s resolves to a failure result instead', async (_label, impl) => {
    // The whole reason `reportSettledMatch` can stay fire-and-forget: an unhandled rejection
    // out of a settlement callback would take the gameserver down mid-match.
    await expect(internalFetch('http://peer.test/x', { fetchImpl: impl })).resolves.toMatchObject({
      ok: false,
      failure: 'network',
    });
  });
});
