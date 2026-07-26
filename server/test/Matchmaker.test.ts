/**
 * Matchmaker queue/grouping (ROADMAP 3.3). Drives the pure core with injected fakes (a
 * hand-advanced clock, a deterministic seed/roomId source, and the real ticket signer) —
 * every branch of enqueue → group formation → poll → expiry is exercised without a
 * network. The ticket's own rejection surface lives in ticket.test.ts; here we assert
 * the tickets a formed group hands out are internally consistent and verifiable.
 */
import { describe, it, expect } from 'vitest';
import { Matchmaker, MAX_PLAYERS, type MatchmakerDeps } from '../src/Matchmaker';
import { signTicket, verifyTicket } from '../src/ticket';

const SECRET = 'mm-secret';

function make(overrides: Partial<MatchmakerDeps> = {}) {
  let now = 1_000;
  let seedN = 100;
  let roomN = 0;
  const deps: MatchmakerDeps = {
    nowMs: () => now,
    nextSeed: () => ++seedN,
    newRoomId: () => `room-${++roomN}`,
    sign: (p) => signTicket(p, SECRET),
    ...overrides,
  };
  const mm = new Matchmaker(deps);
  return { mm, advance: (ms: number) => (now += ms), at: () => now };
}

describe('Matchmaker — grouping', () => {
  it('keeps a partial queue waiting and forms a room only when the seat count is met', () => {
    const { mm } = make();
    const a = mm.enqueue(2);
    expect(a.ticket).toBeUndefined(); // first of two — still waiting
    expect(mm.poll(a.queueId)).toEqual({ status: 'queued' });
    expect(mm.waiting(2)).toBe(1);

    const b = mm.enqueue(2);
    expect(b.ticket).toBeDefined(); // arrival that completes the group gets it inline
    expect(mm.waiting(2)).toBe(0);

    // The first waiter now polls `matched`.
    const polled = mm.poll(a.queueId);
    expect(polled.status).toBe('matched');
  });

  it('assigns one shared seed/room and distinct owners 0..N-1', () => {
    const { mm } = make();
    const ids = [mm.enqueue(3), mm.enqueue(3), mm.enqueue(3)];
    const tickets = ids.map((r) => (r.ticket ?? (mm.poll(r.queueId) as { ticket: any }).ticket));

    const rooms = new Set(tickets.map((t) => t.roomId));
    const seeds = new Set(tickets.map((t) => t.seed));
    expect(rooms.size).toBe(1); // one room
    expect(seeds.size).toBe(1); // one shared seed
    expect(tickets.map((t) => t.owner).sort()).toEqual([0, 1, 2]); // distinct seats
    expect(tickets.every((t) => t.playerCount === 3)).toBe(true);
  });

  it('issues tickets that verify against the same secret and carry the seat grant', () => {
    const { mm, at } = make();
    mm.enqueue(2);
    const b = mm.enqueue(2);
    const payload = verifyTicket(b.ticket!.token, SECRET, at());
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({ roomId: b.ticket!.roomId, owner: b.ticket!.owner, seed: b.ticket!.seed, playerCount: 2 });
  });

  it('forms back-to-back groups from a burst (4 → two 2-seat rooms)', () => {
    const { mm } = make();
    const r = [mm.enqueue(2), mm.enqueue(2), mm.enqueue(2), mm.enqueue(2)];
    const rooms = r.map((x) => (x.ticket ?? (mm.poll(x.queueId) as { ticket: any }).ticket).roomId);
    expect(new Set(rooms).size).toBe(2); // two distinct rooms, two per room
  });

  it('handles a 1-seat request by matching immediately', () => {
    const { mm } = make();
    const a = mm.enqueue(1);
    expect(a.ticket).toBeDefined();
    expect(a.ticket!.owner).toBe(0);
  });

  it('does not cross modes — a 2-seat and a 3-seat waiter never group', () => {
    const { mm } = make();
    const a = mm.enqueue(2);
    const b = mm.enqueue(3);
    expect(a.ticket).toBeUndefined();
    expect(b.ticket).toBeUndefined();
    expect(mm.waiting(2)).toBe(1);
    expect(mm.waiting(3)).toBe(1);
  });

  it('does not cross game modes — a coop 2-seat and a pvp 2-seat waiter never group (design/15)', () => {
    const { mm } = make();
    const coop = mm.enqueue(2); // default mode
    const pvp = mm.enqueue(2, 'pvp');
    expect(coop.ticket).toBeUndefined();
    expect(pvp.ticket).toBeUndefined();
    expect(mm.waiting(2)).toBe(1); // coop queue
    expect(mm.waiting(2, 'pvp')).toBe(1); // separate pvp queue

    const coop2 = mm.enqueue(2);
    expect(coop2.ticket).toBeDefined(); // pairs with the coop waiter, not the pvp one
    expect(mm.waiting(2, 'pvp')).toBe(1); // pvp waiter untouched
  });

  it('tags every ticket in a group with the requested mode, defaulting to coop', () => {
    const { mm } = make();
    const a = mm.enqueue(2); // no mode → coop
    const b = mm.enqueue(2);
    const ticketA = a.ticket ?? (mm.poll(a.queueId) as { ticket: any }).ticket;
    expect(ticketA.mode).toBe('coop');
    expect(b.ticket!.mode).toBe('coop');

    const c = mm.enqueue(3, 'pvp');
    mm.enqueue(3, 'pvp');
    const e = mm.enqueue(3, 'pvp');
    expect(e.ticket!.mode).toBe('pvp');
    const ticketC = c.ticket ?? (mm.poll(c.queueId) as { ticket: any }).ticket;
    expect(ticketC.mode).toBe('pvp');
  });
});

describe('Matchmaker — expiry & validation', () => {
  it('reports a stale waiter as expired and drops it from the queue', () => {
    const { mm, advance } = make();
    const a = mm.enqueue(2);
    advance(30_001); // past the default 30 s queue TTL
    expect(mm.poll(a.queueId)).toEqual({ status: 'expired' });
    expect(mm.waiting(2)).toBe(0); // reaped

    // A fresh partner after the expiry does NOT match the dead waiter.
    const b = mm.enqueue(2);
    expect(b.ticket).toBeUndefined();
  });

  it('an expired waiter is not counted toward a new group', () => {
    const { mm, advance } = make();
    mm.enqueue(2); // will go stale
    advance(30_001);
    const b = mm.enqueue(2); // should NOT pair with the stale one
    expect(b.ticket).toBeUndefined();
    expect(mm.waiting(2)).toBe(1);
  });

  it('poll of an unknown/collected queueId is expired', () => {
    const { mm } = make();
    expect(mm.poll('nope')).toEqual({ status: 'expired' });
    mm.enqueue(2);
    const b = mm.enqueue(2);
    mm.poll(b.queueId); // collect (was inline too, but poll drops it)
    expect(mm.poll(b.queueId)).toEqual({ status: 'expired' }); // one-shot
  });

  it('rejects an out-of-bounds playerCount', () => {
    const { mm } = make();
    expect(() => mm.enqueue(0)).toThrow(RangeError);
    expect(() => mm.enqueue(MAX_PLAYERS + 1)).toThrow(RangeError);
    expect(() => mm.enqueue(1.5)).toThrow(RangeError);
  });
});

describe('Matchmaker — PvP practice-bot backfill (design/15 follow-up)', () => {
  it('forms the group with bots after pvpBotFillMs, leaving coop unaffected at the same wait', () => {
    const botFills: { roomId: string; botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });

    const a = mm.enqueue(4, 'pvp'); // wants a 4-seat PvP match, alone
    const coop = mm.enqueue(4); // a coop 4-seat waiter, same wait, must NOT bot-fill

    advance(30_000); // exactly at the default pvpBotFillMs/queueTtlMs boundary
    const polledPvp = mm.poll(a.queueId);
    expect(polledPvp.status).toBe('matched');
    expect(polledPvp).toHaveProperty('ticket.owner', 0);
    expect(botFills).toEqual([{ roomId: (polledPvp as { ticket: { roomId: string } }).ticket.roomId, seed: expect.any(Number), playerCount: 4, mode: 'pvp', botOwners: [1, 2, 3] }]);

    // Coop still just sits queued at the identical wait — no bot-fill concept for it.
    expect(mm.poll(coop.queueId)).toEqual({ status: 'queued' });
  });

  it('includes every real waiter still queued for the shape, bot-filling only the remainder', () => {
    const botFills: { botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });

    const a = mm.enqueue(4, 'pvp');
    advance(10_000);
    const b = mm.enqueue(4, 'pvp'); // joins the same shape partway through a's wait
    advance(20_001); // a is now past 30s; b has only waited ~20s

    const polledA = mm.poll(a.queueId);
    expect(polledA.status).toBe('matched');
    expect((polledA as { ticket: { owner: number } }).ticket.owner).toBe(0);
    // b was swept into the SAME group instead of bot-filled — it gets a real seat too.
    const polledB = mm.poll(b.queueId);
    expect(polledB.status).toBe('matched');
    expect((polledB as { ticket: { owner: number } }).ticket.owner).toBe(1);
    expect(botFills).toEqual([expect.objectContaining({ botOwners: [2, 3] })]);
  });

  it('never bot-fills once the shape is already full (formIfReady wins first)', () => {
    const botFills: unknown[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });
    const seats = [mm.enqueue(2, 'pvp'), mm.enqueue(2, 'pvp')];
    expect(seats.some((r) => r.ticket)).toBe(true); // already matched instantly, full group
    advance(30_001);
    for (const r of seats) {
      if (!r.ticket) mm.poll(r.queueId);
    }
    expect(botFills).toEqual([]); // nothing left waiting to ever trigger it
  });

  it('a lone PvP waiter still bot-fills all the way down to a 1-real-seat match', () => {
    const botFills: { botOwners: readonly number[] }[] = [];
    const { mm, advance } = make({ onBotFill: (info) => botFills.push(info) });
    const a = mm.enqueue(8, 'pvp');
    advance(30_000);
    const polled = mm.poll(a.queueId);
    expect(polled.status).toBe('matched');
    expect((polled as { ticket: { owner: number; playerCount: number } }).ticket).toMatchObject({ owner: 0, playerCount: 8 });
    expect(botFills).toEqual([expect.objectContaining({ botOwners: [1, 2, 3, 4, 5, 6, 7] })]);
  });

  it('is a no-op without onBotFill wired — PvP still forms the smaller room, just silently', () => {
    const { mm, advance } = make(); // no onBotFill dep at all
    const a = mm.enqueue(3, 'pvp');
    advance(30_000);
    expect(mm.poll(a.queueId).status).toBe('matched');
  });
});
