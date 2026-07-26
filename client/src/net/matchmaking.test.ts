/**
 * Client matchmaking (ROADMAP 3.3). Drives findMatch with a fake fetch + fake sleep (no
 * network, no timers) through every branch: inline match, queued→matched polling,
 * expired, timeout, and service error. The ticket it returns is opaque here — the
 * server's ticket/Matchmaker tests own that surface; this pins the client's poll loop.
 */
import { describe, it, expect, vi } from 'vitest';
import { findMatch, type MatchInfo } from './matchmaking';

const MATCH: MatchInfo = {
  wsUrl: 'ws://localhost:8787/ws', roomId: 'room-1', owner: 1, seed: 42, playerCount: 2, token: 'tok',
};

/** A fetch stub that returns the queued JSON bodies in sequence. */
function fakeFetch(bodies: unknown[]) {
  let i = 0;
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, json: async () => body } as Response;
  });
}

const noSleep = async () => {};

describe('findMatch', () => {
  it('returns the inline match when this arrival completes the group (no polling)', async () => {
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    const info = await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    expect(info).toEqual(MATCH);
    expect(fetch).toHaveBeenCalledTimes(1); // POST /find only, never polled
  });

  it('polls while queued, then resolves when the seat is matched', async () => {
    const fetch = fakeFetch([
      { queueId: 'q1' }, // POST /find → queued
      { status: 'queued' }, // poll 1
      { status: 'queued' }, // poll 2
      { status: 'matched', match: MATCH }, // poll 3
    ]);
    const info = await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    expect(info).toEqual(MATCH);
    expect(fetch).toHaveBeenCalledTimes(4);
    // The polls hit the queue-scoped URL.
    expect((fetch.mock.calls[1]![0] as string)).toBe('http://mm/find/q1');
  });

  it('rejects when the server expires the request', async () => {
    const fetch = fakeFetch([{ queueId: 'q1' }, { status: 'expired' }]);
    await expect(findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep })).rejects.toThrow(/expired/);
  });

  it('rejects on a service error body', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'playerCount must be an integer in [1, 8]' }) } as Response));
    await expect(findMatch('http://mm', { playerCount: 99, fetch, sleep: noSleep })).rejects.toThrow(/playerCount/);
  });

  it('times out after the budget while stuck queued', async () => {
    const fetch = fakeFetch([{ queueId: 'q1' }, { status: 'queued' }]);
    await expect(
      findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep, pollIntervalMs: 100, timeoutMs: 250 }),
    ).rejects.toThrow(/timed out/);
    // POST + ceil(250/100)=3 polls before the budget is spent.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('honours a cancel signal', async () => {
    const signal = { cancelled: true };
    const fetch = fakeFetch([{ queueId: 'q1' }]);
    await expect(
      findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep, signal }),
    ).rejects.toThrow(/cancelled/);
  });

  it('sends mode in the /find body — defaulting to coop, and passing pvp through explicitly (design/15)', async () => {
    const fetch = fakeFetch([{ queueId: 'q1', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 2, fetch, sleep: noSleep });
    const [, initDefault] = fetch.mock.calls[0]!;
    expect(JSON.parse((initDefault as RequestInit).body as string)).toMatchObject({ mode: 'coop' });

    const fetch2 = fakeFetch([{ queueId: 'q2', match: MATCH }]);
    await findMatch('http://mm', { playerCount: 8, mode: 'pvp', fetch: fetch2, sleep: noSleep });
    const [, initPvp] = fetch2.mock.calls[0]!;
    expect(JSON.parse((initPvp as RequestInit).body as string)).toMatchObject({ playerCount: 8, mode: 'pvp' });
  });
});
