/**
 * MatchRoom / RoomManager lifecycle (design/06, ROADMAP 3.1). Drives the room with a
 * fake metronome and fake connections (no sockets, no timers) — every branch of seat
 * assignment, match start, command relay, reconnect, and settlement is exercised
 * deterministically. The relay CONTENT (ordering/watermark) is proven in @dd/engine's
 * FrameBroadcast tests; this pins the server's orchestration around it.
 */
import { describe, it, expect } from 'vitest';
import { makeCommand } from '@dd/engine';
import type { Brad, PlayerCommand, ServerMsg } from '@dd/engine';
import { MatchRoom, type RoomConnection, type Scheduler, type IntervalHandle } from '../src/MatchRoom';
import { RoomManager } from '../src/RoomManager';

class FakeScheduler implements Scheduler {
  private fns: Array<() => void> = [];
  setInterval(fn: () => void): IntervalHandle {
    this.fns.push(fn);
    return fn;
  }
  clearInterval(h: IntervalHandle): void {
    this.fns = this.fns.filter((f) => f !== h);
  }
  /** Fire every live metronome once (one broadcast pulse). */
  pulse(): void {
    for (const f of [...this.fns]) f();
  }
  get running(): boolean {
    return this.fns.length > 0;
  }
}

class FakeConn implements RoomConnection {
  readonly msgs: ServerMsg[] = [];
  constructor(readonly owner: number) {}
  send(m: ServerMsg): void {
    this.msgs.push(m);
  }
  ofType<T extends ServerMsg['type']>(t: T): Extract<ServerMsg, { type: T }>[] {
    return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
  }
}

const cmd = (owner: number, buttons = 0): PlayerCommand =>
  makeCommand({ owner, tick: 0, moveBrad: 0 as Brad, moveMag: 0, aimBrad: 0 as Brad, buttons });

function room(playerCount = 2, framesPerBatch = 3) {
  const scheduler = new FakeScheduler();
  const destroyed: string[] = [];
  const r = new MatchRoom('r1', 99, playerCount, {
    scheduler,
    onDestroy: (id) => destroyed.push(id),
    framesPerBatch,
  });
  return { r, scheduler, destroyed };
}

describe('MatchRoom — start / relay / broadcast', () => {
  it('launches only when every seat is filled, and tells each seat its own localOwner', () => {
    const { r, scheduler } = room(2);
    const a = new FakeConn(0);
    const b = new FakeConn(1);

    expect(r.join(a)).toBe(true);
    expect(a.ofType('match_start')).toHaveLength(0); // room not full yet
    expect(scheduler.running).toBe(false);

    expect(r.join(b)).toBe(true);
    const sa = a.ofType('match_start')[0]!;
    const sb = b.ofType('match_start')[0]!;
    expect([sa.localOwner, sb.localOwner]).toEqual([0, 1]); // each learns ITS seat
    expect(sa.seed).toBe(99);
    expect(sa.playerCount).toBe(2);
    expect(scheduler.running).toBe(true); // metronome started
  });

  it('a metronome pulse broadcasts a frame_batch to every seat; the watermark advances', () => {
    const { r, scheduler } = room(2, 3);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);

    scheduler.pulse(); // empty pulse
    for (const c of [a, b]) {
      const batch = c.ofType('frame_batch').at(-1)!;
      expect(batch.toFrame).toBe(3);
      expect(batch.frames).toEqual([]);
    }
    scheduler.pulse();
    expect(a.ofType('frame_batch').at(-1)!.toFrame).toBe(6);
  });

  it('relays a command tagged with the connection\'s OWN seat, ignoring any client-sent owner', () => {
    const { r, scheduler } = room(2, 3);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);

    // Seat 1 tries to spoof a command as owner 0 — the server must overwrite it to 1.
    r.submitCmd(1, cmd(0, 4));
    scheduler.pulse();
    const batch = a.ofType('frame_batch').at(-1)!;
    expect(batch.frames).toHaveLength(1);
    expect(batch.frames[0]!.cmds).toHaveLength(1);
    expect(batch.frames[0]!.cmds[0]!.owner).toBe(1); // authority: owner forced to the seat
    expect(batch.frames[0]!.frame).toBe(3);
  });
});

describe('MatchRoom — join guards', () => {
  it('rejects an out-of-range seat, a taken seat, and a join after the match started', () => {
    const { r } = room(2);
    expect(r.join(new FakeConn(5))).toBe(false); // out of range
    expect(r.join(new FakeConn(0))).toBe(true);
    expect(r.join(new FakeConn(0))).toBe(false); // seat 0 taken
    r.join(new FakeConn(1)); // fills → launches
    expect(r.join(new FakeConn(1))).toBe(false); // match already started
  });
});

describe('MatchRoom — reconnect', () => {
  it('pauses the metronome on disconnect and resyncs the missed frame log on resume', () => {
    const { r, scheduler } = room(2, 3);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);

    r.submitCmd(0, cmd(0, 1));
    scheduler.pulse(); // frame 3, logged (non-empty)
    scheduler.pulse(); // frame 6, empty

    r.onDisconnect(b); // seat 1 drops
    expect(scheduler.running).toBe(false); // clock paused — co-op waits, doesn't forfeit

    const b2 = new FakeConn(1);
    expect(r.resume(b2, 0)).toBe(true); // rejoin, asking for everything after frame 0
    const resync = b2.ofType('conn_resync')[0]!;
    expect(resync.curFrame).toBe(6);
    expect(resync.log.map((f) => f.frame)).toEqual([3]); // only the non-empty frame
    expect(scheduler.running).toBe(true); // metronome resumed (both connected again)
  });
});

describe('MatchRoom — settlement', () => {
  it('broadcasts match_over and destroys once every seat reports, and agrees the outcome', () => {
    const { r, scheduler, destroyed } = room(2);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);

    r.reportResult(0, 0xabc, 'enemies');
    expect(a.ofType('match_over')).toHaveLength(0); // waiting for seat 1
    r.reportResult(1, 0xabc, 'enemies'); // matching hash

    const over = a.ofType('match_over')[0]!;
    expect(over.winner).toBe('enemies');
    expect(over.reason).toBe('wipe');
    expect(destroyed).toEqual(['r1']);
    expect(scheduler.running).toBe(false);
  });

  it('flags a hash mismatch (re-judge backstop) but still ends the match', () => {
    const { r } = room(2);
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    r.join(a); r.join(b);
    r.reportResult(0, 0x111, 0);
    r.reportResult(1, 0x222, 0); // divergent hash
    expect(a.ofType('match_over')[0]!.reason).toBe('disconnect'); // mismatch marker
  });
});

describe('RoomManager — routing + room parameter cross-check', () => {
  it('creates a room on the first join and rejects a joiner that disagrees on seed/count', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    const a = new FakeConn(0);
    const b = new FakeConn(1);

    expect(mgr.join(a, 'room', 7, 2)).toBe(true);
    expect(mgr.size).toBe(1);
    expect(mgr.join(b, 'room', 8, 2)).toBe(false); // seed disagreement → rejected
    expect(mgr.join(b, 'room', 7, 3)).toBe(false); // playerCount disagreement → rejected
    expect(mgr.join(b, 'room', 7, 2)).toBe(true); // agrees → seated, match starts
    expect(scheduler.running).toBe(true);
  });

  it('routes cmd/resume/result by roomId and cleans up on the last disconnect', () => {
    const scheduler = new FakeScheduler();
    const mgr = new RoomManager({ scheduler });
    const a = new FakeConn(0);
    const b = new FakeConn(1);
    mgr.join(a, 'room', 7, 2);
    mgr.join(b, 'room', 7, 2);

    mgr.handle(a, 'room', { type: 'cmd', cmd: cmd(0, 1) });
    scheduler.pulse();
    expect(a.ofType('frame_batch').at(-1)!.frames).toHaveLength(1);

    mgr.onClose(a, 'room');
    mgr.onClose(b, 'room');
    expect(mgr.size).toBe(0); // room destroyed when empty
  });
});
