/**
 * Client party calls (design/05/15 PvP squad follow-up). Fake-fetch driven, mirrors
 * matchmaking.test.ts's style — the server's own PartyService.test.ts owns the real
 * grouping/expiry behavior; this just pins the client's request/response shapes.
 */
import { describe, it, expect, vi } from 'vitest';
import { createParty, joinParty, leaveParty, startPartyMatching, getParty } from './party';

const PARTY = { partyId: 'p1', code: 'ABCDE', leaderId: 'alice', members: ['alice'], matching: false };

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body }) as Response);
}

describe('party client calls', () => {
  it('createParty posts playerId and returns the PartyInfo', async () => {
    const fetch = fakeFetch(200, PARTY);
    const info = await createParty('http://mm', 'alice', { fetch });
    expect(info).toEqual(PARTY);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://mm/party/create');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ playerId: 'alice' });
  });

  it('joinParty posts playerId+code', async () => {
    const fetch = fakeFetch(200, { ...PARTY, members: ['alice', 'bob'] });
    const info = await joinParty('http://mm', 'bob', 'ABCDE', { fetch });
    expect(info.members).toEqual(['alice', 'bob']);
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ playerId: 'bob', code: 'ABCDE' });
  });

  it('rejects with the server error message on a non-ok response', async () => {
    const fetch = fakeFetch(404, { error: 'party not found or full' });
    await expect(joinParty('http://mm', 'bob', 'NOPE', { fetch })).rejects.toThrow(/not found or full/);
  });

  it('startPartyMatching posts partyId+playerId', async () => {
    const fetch = fakeFetch(200, { ...PARTY, matching: true });
    const info = await startPartyMatching('http://mm', 'p1', 'alice', { fetch });
    expect(info.matching).toBe(true);
  });

  it('leaveParty returns null when the server reports the party dissolved', async () => {
    const fetch = fakeFetch(200, null);
    const info = await leaveParty('http://mm', 'p1', 'alice', { fetch });
    expect(info).toBeNull();
  });

  it('getParty returns null on a 404 instead of throwing', async () => {
    const fetch = fakeFetch(404, { error: 'party not found' });
    const info = await getParty('http://mm', 'gone', { fetch });
    expect(info).toBeNull();
  });

  it('getParty returns the info on success', async () => {
    const fetch = fakeFetch(200, PARTY);
    const info = await getParty('http://mm', 'p1', { fetch });
    expect(info).toEqual(PARTY);
  });
});
