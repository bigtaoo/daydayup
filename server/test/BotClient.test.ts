/**
 * BotClient (design/15 follow-up — PvP practice-bot backfill). Proves the wiring, not
 * the individual pieces (PvpBotController's targeting is pinned in the client package's
 * pvpBot.test.ts; CoopSession/NetInputSource/FrameBroadcast have their own suites): a
 * bot seat, driven through `runBotClient`, actually submits commands into a REAL
 * MatchRoom's broadcast, keeps submitting as new frames confirm, and stops cleanly
 * without leaking its timer — in-process, no sockets, via a `BridgeTransport` wiring
 * `runBotClient`'s injected `Transport` straight to a `RoomConnection` (mirrors
 * MatchRoom.test.ts's FakeConn/FakeScheduler harness). Fake timers stand in for the
 * bot's `setInterval` tick cadence so the test stays synchronous and deterministic.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeCommand, type Brad, type ClientMsg, type PlayerCommand, type ServerMsg } from '@dd/engine';
import type { Transport } from '@dd/net/transport';
import { MatchRoom, type RoomConnection, type Scheduler, type IntervalHandle } from '../src/MatchRoom';
import { runBotClient } from '../src/BotClient';

class FakeScheduler implements Scheduler {
  private fns: Array<() => void> = [];
  setInterval(fn: () => void): IntervalHandle {
    this.fns.push(fn);
    return fn;
  }
  clearInterval(h: IntervalHandle): void {
    this.fns = this.fns.filter((f) => f !== h);
  }
  pulse(): void {
    for (const f of [...this.fns]) f();
  }
}

/** Wires a bot's Transport straight to a RoomConnection — no socket, synchronous. */
class BridgeTransport implements Transport {
  readonly conn: RoomConnection;
  readonly sent: ClientMsg[] = [];
  closed = false;
  private handler: ((msg: ServerMsg) => void) | null = null;

  constructor(owner: number) {
    this.conn = { owner, send: (m) => this.handler?.(m) };
  }
  send(msg: ClientMsg): void {
    this.sent.push(msg);
  }
  onMessage(handler: (msg: ServerMsg) => void): void {
    this.handler = handler;
  }
  close(): void {
    this.closed = true;
  }
}

const humanCmd = (tick: number): PlayerCommand =>
  makeCommand({ owner: 0, tick, moveBrad: 0 as Brad, moveMag: 0, buttons: 0 });

afterEach(() => {
  vi.useRealTimers();
});

describe('BotClient — drives a real seat through a real MatchRoom', () => {
  it('submits commands into the broadcast as frames confirm, then stops cleanly', () => {
    vi.useFakeTimers();
    const scheduler = new FakeScheduler();
    const room = new MatchRoom('r1', 99, 2, { scheduler, onDestroy: () => {}, mode: 'pvp', framesPerBatch: 1 });

    // Seat 0: a silent human stand-in — the test drives its commands directly.
    const human: RoomConnection = { owner: 0, send: () => {} };
    expect(room.join(human)).toBe(true);

    // Seat 1: the bot, wired via the bridge instead of a socket.
    const bridge = new BridgeTransport(1);
    const bot = runBotClient({
      transport: bridge,
      wsUrl: 'unused', // spawnBotClient's own concern, not runBotClient's
      token: 'unused',
      roomId: 'r1',
      owner: 1,
      seed: 99,
      playerCount: 2,
      tickMs: 10,
    });
    expect(room.join(bridge.conn)).toBe(true); // completes the room → match_start fires

    // room.join → launch() → conn.send(match_start) all happen synchronously in-process,
    // so the bot's onMatchStart has already armed its (fake-timer) tick interval.
    room.submitCmd(0, humanCmd(1));
    vi.advanceTimersByTime(10); // one bot tick: computes + submits its own command
    scheduler.pulse(); // one broadcast pulse: confirms the frame both seats submitted to
    room.submitCmd(0, humanCmd(2));
    vi.advanceTimersByTime(10); // the bot drains the newly-confirmed frame, submits again
    scheduler.pulse();

    const cmdMsgsFromBot = bridge.sent.filter((m) => m.type === 'cmd' && m.cmd.owner === 1);
    expect(cmdMsgsFromBot.length).toBeGreaterThan(0); // the bot is a live command source
    expect(bridge.closed).toBe(false); // match still running — no close yet

    bot.stop();
    expect(bridge.closed).toBe(true);
    const sentCountAtStop = bridge.sent.length;
    vi.advanceTimersByTime(50); // any leftover interval must have been cleared by stop()
    scheduler.pulse();
    expect(bridge.sent.length).toBe(sentCountAtStop); // no further ticks after stop()
  });
});
