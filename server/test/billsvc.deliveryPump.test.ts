/**
 * `billsvc/deliveryPump.ts` — the ASYNC half of design/19 §4's closed delivery loop, and
 * the file where the branches live. Every case here is a way the control plane can fail,
 * because the happy path is one line and the policy is everything else.
 *
 * The distinction the whole design turns on, asserted three ways below: a 4xx is the peer
 * refusing ON PURPOSE (terminal — the row is written off loudly, because money moved and
 * nothing was granted), while a 5xx, a timeout or a refused connection is the peer being
 * broken (the row stays owed, forever, because a peer that comes back heals it). Getting
 * that inverted is how an outbox either loses purchases or hammers a dead service.
 *
 * `fetch` is injected rather than stubbed onto the global: `internalFetch` reads
 * `globalThis.fetch` at call time so either would work, but a `fetchImpl` in `deps` is what
 * the production wiring actually passes through, so this exercises the real seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openBillingDb } from '../src/billingDb';
import { DeliveryPump, GRANT_PATH, parseGrants, type GrantDeliveryBody } from '../src/billsvc/deliveryPump';
import { deliveryById, pendingDeliveries } from '../src/billsvc/outbox';
import { INTERNAL_CALLER_HEADER, INTERNAL_KEY_HEADER } from '../src/internalAuth';

let db: DatabaseSync;
/** Every request the pump made, in order — url, headers and parsed body. */
let calls: { url: string; headers: Record<string, string>; body: GrantDeliveryBody }[];

beforeEach(() => {
  db = openBillingDb(':memory:');
  calls = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function insert(id: string, over: { accountId?: string; grantsJson?: string; createdAt?: number } = {}): void {
  db.prepare(
    `INSERT INTO deliveries (id, account_id, sku, grants_json, order_id, receipt_id, state, attempts, created_at, delivered_at)
     VALUES (?, ?, 'bp.cannon', ?, 'o1', 'dev:r1', 'pending', 0, ?, NULL)`,
  ).run(id, over.accountId ?? 'a1', over.grantsJson ?? '[{"kind":"blueprint","id":"cannon"}]', over.createdAt ?? 1);
}

/** A `fetch` double that answers each call from `answers`, repeating the last one. */
function fetchReturning(...answers: (number | 'network')[]): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const answer = answers[Math.min(i++, answers.length - 1)]!;
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as GrantDeliveryBody,
    });
    if (answer === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ ok: answer < 400 }), { status: answer });
  }) as unknown as typeof fetch;
}

function pump(fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof DeliveryPump>[0]> = {}): DeliveryPump {
  return new DeliveryPump({
    db,
    matchsvcUrl: 'http://control-plane:8788',
    internalKey: 'the-key',
    caller: 'billsvc',
    nowMs: () => 4242,
    fetchImpl,
    // No real backoff, and no real retry unless a case asks for one — the ladder itself is
    // `internalFetch`'s own tested behaviour, not this file's.
    retry: { attempts: 1 },
    sleep: async () => {},
    ...over,
  });
}

describe('DeliveryPump.pumpOnce', () => {
  it('delivers a pending row and marks it, with the internal key and the caller label on the wire', async () => {
    insert('purchase:dev:T1');
    const result = await pump(fetchReturning(200)).pumpOnce();

    expect(result).toEqual({ attempted: 1, delivered: 1, failed: 0, deferred: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://control-plane:8788${GRANT_PATH}`);
    expect(calls[0]!.headers[INTERNAL_KEY_HEADER]).toBe('the-key');
    expect(calls[0]!.headers[INTERNAL_CALLER_HEADER]).toBe('billsvc');
    expect(calls[0]!.body).toMatchObject({
      deliveryId: 'purchase:dev:T1',
      accountId: 'a1',
      sku: 'bp.cannon',
      orderId: 'o1',
      grants: [{ kind: 'blueprint', id: 'cannon' }],
    });
    expect(deliveryById(db, 'purchase:dev:T1')).toMatchObject({ state: 'delivered', deliveredAt: 4242, attempts: 1 });
  });

  it('does nothing at all when nothing is owed', async () => {
    const result = await pump(fetchReturning(200)).pumpOnce();
    expect(result).toEqual({ attempted: 0, delivered: 0, failed: 0, deferred: 0 });
    expect(calls).toHaveLength(0);
  });

  it('normalises a trailing slash on the control-plane URL rather than posting a double one', async () => {
    insert('d1');
    await pump(fetchReturning(200), { matchsvcUrl: 'http://control-plane:8788/' }).pumpOnce();
    expect(calls[0]!.url).toBe(`http://control-plane:8788${GRANT_PATH}`);
  });

  it('does not send an internal-key header at all when no key is configured', async () => {
    // The production fail-closed branch (`config.ts` under NODE_ENV=production with no key).
    // The peer then rejects with a logged reason, which is the visible outcome — better than
    // a placeholder that something downstream would have to recognise as one.
    insert('d1');
    await pump(fetchReturning(401), { internalKey: undefined }).pumpOnce();
    expect(calls[0]!.headers[INTERNAL_KEY_HEADER]).toBeUndefined();
  });

  // ── the failure policy ────────────────────────────────────────────────────────────────

  it('writes a 4xx off as TERMINAL, without retrying it', async () => {
    insert('d1');
    const result = await pump(fetchReturning(400), { retry: { attempts: 3 } }).pumpOnce();

    expect(result).toEqual({ attempted: 1, delivered: 0, failed: 1, deferred: 0 });
    // Three attempts were BUDGETED and one was made: `internalFetch` stops its own ladder on
    // a non-retryable status, so the pump inherits "a deliberate refusal is not repeated".
    expect(calls).toHaveLength(1);
    expect(deliveryById(db, 'd1')).toMatchObject({ state: 'failed', deliveredAt: null, attempts: 1 });
    // Money taken, nothing granted: this has to be loud, and it has to name the account.
    expect(vi.mocked(console.error).mock.calls[0]![0]).toMatch(/REFUSED delivery 'd1' with 400.*a1.*Needs a manual grant/s);
  });

  it('treats a 401 from the control plane the same way — a rejected key is not a retryable outage', async () => {
    insert('d1');
    expect(await pump(fetchReturning(401)).pumpOnce()).toMatchObject({ failed: 1, deferred: 0 });
    expect(deliveryById(db, 'd1')!.state).toBe('failed');
  });

  it('leaves a 5xx PENDING and retries it on the next sweep', async () => {
    insert('d1');
    const p = pump(fetchReturning(503, 503, 200));
    expect(await p.pumpOnce()).toEqual({ attempted: 1, delivered: 0, failed: 0, deferred: 1 });
    expect(deliveryById(db, 'd1')).toMatchObject({ state: 'pending', attempts: 1 });

    expect(await p.pumpOnce()).toMatchObject({ deferred: 1 });
    expect(deliveryById(db, 'd1')).toMatchObject({ state: 'pending', attempts: 2 });

    // Third sweep: the peer is back, and the row that was never written off is delivered.
    expect(await p.pumpOnce()).toMatchObject({ delivered: 1 });
    expect(deliveryById(db, 'd1')).toMatchObject({ state: 'delivered', attempts: 3 });
  });

  it('leaves a NETWORK error pending too — a refused connection is the peer being down', async () => {
    insert('d1');
    expect(await pump(fetchReturning('network')).pumpOnce()).toMatchObject({ deferred: 1, failed: 0 });
    expect(deliveryById(db, 'd1')).toMatchObject({ state: 'pending', attempts: 1 });
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toMatch(/deferred after 1 attempt\(s\).*network/);
  });

  it('exhausts `internalFetch`\'s in-sweep ladder on a 5xx before deferring the row', async () => {
    // The two retry layers are different things: the ladder absorbs a peer that is
    // restarting (three attempts, seconds apart) and never touches the table; the sweep-level
    // retry is for an outage that outlives it. A row that reached `attempts: 1` after three
    // HTTP calls is the shape that proves both exist.
    insert('d1');
    await pump(fetchReturning(500), { retry: { attempts: 3 } }).pumpOnce();
    expect(calls).toHaveLength(3);
    expect(deliveryById(db, 'd1')).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('never gives up on a retryable failure, however many attempts it has made', async () => {
    // Deliberate, and the opposite of the usual dead-letter reflex: abandoning the row loses
    // a purchase that was paid for, while retrying costs one request a minute. `attempts` is
    // the operator's signal, not a budget.
    insert('d1');
    const p = pump(fetchReturning(500));
    for (let i = 0; i < 20; i++) await p.pumpOnce();
    expect(deliveryById(db, 'd1')).toMatchObject({ state: 'pending', attempts: 20 });
    expect(pendingDeliveries(db, 10).map((r) => r.id)).toEqual(['d1']);
  });

  it('counts the attempt even when the call never returns an answer', async () => {
    // Counted BEFORE the request, so a crash mid-attempt still leaves a trace — the case the
    // count is worth the most in, since nothing else would record it.
    insert('d1');
    const hang = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await pump(hang).pumpOnce();
    expect(deliveryById(db, 'd1')!.attempts).toBe(1);
  });

  // ── batching and ordering ─────────────────────────────────────────────────────────────

  it('carries on past a failed row rather than stopping the sweep on it', async () => {
    insert('bad', { createdAt: 1 });
    insert('good', { createdAt: 2 });
    const result = await pump(fetchReturning(400, 200)).pumpOnce();
    expect(result).toEqual({ attempted: 2, delivered: 1, failed: 1, deferred: 0 });
    expect(deliveryById(db, 'bad')!.state).toBe('failed');
    expect(deliveryById(db, 'good')!.state).toBe('delivered');
  });

  it('stops at the batch size and picks the rest up next sweep', async () => {
    for (let i = 0; i < 5; i++) insert(`d${i}`, { createdAt: i });
    const p = pump(fetchReturning(200), { batchSize: 2 });
    expect(await p.pumpOnce()).toMatchObject({ attempted: 2, delivered: 2 });
    expect(pendingDeliveries(db, 10).map((r) => r.id)).toEqual(['d2', 'd3', 'd4']);
    await p.pumpOnce();
    await p.pumpOnce();
    expect(pendingDeliveries(db, 10)).toHaveLength(0);
  });

  it('posts rows one at a time rather than as a burst', async () => {
    // A control plane that is struggling is exactly the one being retried against, so a
    // batch-sized burst from a peer that is already backing off is the wrong shape.
    let concurrent = 0;
    let peak = 0;
    const serial = (async () => {
      peak = Math.max(peak, ++concurrent);
      await Promise.resolve();
      concurrent--;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    for (let i = 0; i < 4; i++) insert(`d${i}`, { createdAt: i });
    await pump(serial).pumpOnce();
    expect(peak).toBe(1);
  });

  // ── a row nothing can deliver ─────────────────────────────────────────────────────────

  it('writes a row with unreadable grants off as terminal, without calling the control plane', async () => {
    // Unreachable through the outbox and reachable through the `sqlite3` prompt design/19 §7
    // plans corrections at. Re-reading the same bytes cannot make them parse, so retrying
    // forever in silence is strictly worse than telling an operator once.
    insert('d1', { grantsJson: '{not json' });
    expect(await pump(fetchReturning(200)).pumpOnce()).toEqual({
      attempted: 1,
      delivered: 0,
      failed: 1,
      deferred: 0,
    });
    expect(calls).toHaveLength(0);
    expect(deliveryById(db, 'd1')!.state).toBe('failed');
    expect(vi.mocked(console.error).mock.calls[0]![0]).toMatch(/unreadable grants_json.*Needs a manual grant/s);
  });

  it('treats well-formed JSON that is not an array the same way', async () => {
    insert('d1', { grantsJson: '{"kind":"blueprint","id":"cannon"}' });
    expect(await pump(fetchReturning(200)).pumpOnce()).toMatchObject({ failed: 1 });
    expect(calls).toHaveLength(0);
  });
});

describe('parseGrants', () => {
  it('reads the array the outbox writes', () => {
    expect(parseGrants('[{"kind":"blueprint","id":"cannon"}]')).toEqual([{ kind: 'blueprint', id: 'cannon' }]);
  });

  it('accepts an empty array — the RECEIVER decides that is a refusal, not the parser', () => {
    // Split deliberately: the parser answers "are these readable bytes", and the control
    // plane answers "is this a deliverable purchase". Folding the second into the first would
    // make a legitimately empty list indistinguishable from corruption in the log.
    expect(parseGrants('[]')).toEqual([]);
  });

  it('rejects malformed JSON, a bare object, a string and null', () => {
    expect(parseGrants('{oops')).toBeNull();
    expect(parseGrants('{"kind":"blueprint"}')).toBeNull();
    expect(parseGrants('"cannon"')).toBeNull();
    expect(parseGrants('null')).toBeNull();
  });
});

describe('DeliveryPump scheduling', () => {
  it('coalesces overlapping schedules into one sweep, then one more', async () => {
    // The opportunistic trigger fires per settlement, and two settlements landing together
    // must not produce two concurrent sweeps posting the same rows twice.
    insert('d1');
    let inFlight = 0;
    let peak = 0;
    let release: (() => void) | null = null;
    // Only the FIRST call blocks — it is the one that has to still be running while the
    // second and third `schedule()` arrive. Later calls (the queued rerun's) resolve at once.
    const gated = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: {}, body: JSON.parse(String(init?.body ?? '{}')) as GrantDeliveryBody });
      peak = Math.max(peak, ++inFlight);
      if (release === null) await new Promise<void>((r) => (release = r));
      inFlight--;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const p = pump(gated);
    p.schedule();
    await Promise.resolve();
    insert('d2'); // committed while the first sweep already has its snapshot
    p.schedule();
    p.schedule();
    expect(peak).toBe(1);

    release!();
    await p.stop();
    // The queued rerun is what picks up `d2` — without it the row would wait for the
    // backstop interval even though a settlement had just asked for a sweep.
    expect(pendingDeliveries(db, 10)).toHaveLength(0);
    expect(calls.map((c) => c.body.deliveryId)).toEqual(['d1', 'd2']);
  });

  it('start() sweeps immediately and arms a backstop that sweeps again', async () => {
    vi.useFakeTimers();
    try {
      insert('d1');
      const p = pump(fetchReturning(500, 200), { intervalMs: 1_000 });
      p.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(deliveryById(db, 'd1')).toMatchObject({ state: 'pending', attempts: 1 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(deliveryById(db, 'd1')).toMatchObject({ state: 'delivered' });
      await p.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() twice arms one interval, and stop() disarms it', async () => {
    vi.useFakeTimers();
    try {
      const p = pump(fetchReturning(200), { intervalMs: 1_000 });
      p.start();
      p.start();
      insert('d1');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toHaveLength(1); // one interval, not two

      await p.stop();
      insert('d2');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(1); // nothing fires after stop
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() awaits the sweep in flight rather than returning into a closing database', async () => {
    insert('d1');
    let release: (() => void) | null = null;
    const gated = (async () => {
      await new Promise<void>((r) => (release = r));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const p = pump(gated);
    p.schedule();
    await Promise.resolve();

    let stopped = false;
    const stopping = p.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);

    release!();
    await stopping;
    expect(deliveryById(db, 'd1')!.state).toBe('delivered');
  });

  it('stop() on a pump that never ran resolves rather than hanging', async () => {
    await expect(pump(fetchReturning(200)).stop()).resolves.toBeUndefined();
  });
});
