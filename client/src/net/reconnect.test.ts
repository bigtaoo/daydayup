/**
 * driveReconnect (ROADMAP reconnect, design/06) — the bounded retry loop that turns a
 * mid-match `CoopSession` disconnect into a fresh resume ticket + a swapped-in
 * transport. `onlineConnect.test.ts` already exercises this wired end-to-end through
 * `connectOnlineSession`; this file pins the driver's OWN contract in isolation: exact
 * backoff timing, re-arming after a successful reconnect for a SECOND drop, and the
 * `inFlight` re-entrancy guard.
 */
import { describe, it, expect, vi } from 'vitest';
import { CoopSession } from './CoopSession';
import { driveReconnect } from './reconnect';
import type { Transport } from './transport';
import type { ClientMsg, ServerMsg, MatchStart } from '@dd/engine/net/protocol';
import type { EngineConfig } from '@dd/engine/state/GameState';

class FakeTransport implements Transport {
  readonly sent: ClientMsg[] = [];
  private handler: ((m: ServerMsg) => void) | null = null;
  private disconnectHandler: ((reason: string) => void) | null = null;
  send(m: ClientMsg): void {
    this.sent.push(m);
  }
  onMessage(h: (m: ServerMsg) => void): void {
    this.handler = h;
  }
  onDisconnect(h: (reason: string) => void): void {
    this.disconnectHandler = h;
  }
  close(): void {}
  deliver(m: ServerMsg): void {
    this.handler?.(m);
  }
  fail(reason: string): void {
    this.disconnectHandler?.(reason);
  }
}

const SEED = 99;
const CONFIG: EngineConfig = { seed: SEED, worldW: 400, worldH: 400, waves: [], players: [{ start: [200, 200] }] };
const MATCH = { wsUrl: 'ws://gs/ws', roomId: 'r', owner: 0, seed: SEED, playerCount: 1, teamId: 0, token: 'tok' };

function makeSession(transport: Transport) {
  return new CoopSession({
    transport, roomId: 'r', owner: 0, seed: SEED, playerCount: 1,
    buildConfig: (_info: MatchStart) => CONFIG,
  });
}

const noSleep = async () => {};

/** Flush the microtask queue (the sleep→fetch→json promise chain inside each attempt)
 *  without needing fake timers — same helper `onlineConnect.test.ts` already uses. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('driveReconnect', () => {
  it('starts an attempt immediately for the disconnect that triggered it, and reconnects on success', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    let transport2!: FakeTransport;
    const reconnecting: number[] = [];
    let reconnected = false;

    const resumeFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ match: { ...MATCH, token: 'tok2' } }) }) as unknown as Response);

    driveReconnect(session, {
      matchBaseUrl: 'http://mm',
      initialToken: 'tok',
      fetch: resumeFetch,
      sleep: noSleep,
      createTransport: (url) => {
        expect(url).toBe(`${MATCH.wsUrl}?ticket=tok2`);
        return (transport2 = new FakeTransport());
      },
      onReconnecting: (n) => reconnecting.push(n),
      onReconnected: () => { reconnected = true; },
    });

    transport.fail('dropped');
    expect(reconnecting).toEqual([1]); // fired synchronously, before any await

    await flush();

    expect(resumeFetch).toHaveBeenCalledTimes(1);
    expect(reconnected).toBe(true);
    expect(transport2.sent).toEqual([{ type: 'resume', roomId: 'r', owner: 0, lastFrame: 0 }]);
  });

  it('re-arms after a successful reconnect — a SECOND drop (on the new transport) starts a fresh retry sequence', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    const transports: FakeTransport[] = [];
    let attempts = 0;
    const resumeFetch = vi.fn(async () => {
      attempts++;
      return { ok: true, status: 200, json: async () => ({ match: { ...MATCH, token: `tok${attempts}` } }) } as unknown as Response;
    });

    driveReconnect(session, {
      matchBaseUrl: 'http://mm',
      initialToken: 'tok',
      fetch: resumeFetch,
      sleep: noSleep,
      createTransport: () => {
        const t = new FakeTransport();
        transports.push(t);
        return t;
      },
    });

    transport.fail('first drop');
    await flush();
    expect(transports).toHaveLength(1);

    transports[0]!.fail('second drop');
    await flush();

    expect(attempts).toBe(2);
    expect(transports).toHaveLength(2);
    expect(transports[1]!.sent).toEqual([{ type: 'resume', roomId: 'r', owner: 0, lastFrame: 0 }]);
  });

  it('ignores a disconnect while an attempt is already in flight (re-entrancy guard)', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    const resumeFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ match: { ...MATCH, token: 'tok2' } }) }) as unknown as Response);

    driveReconnect(session, {
      matchBaseUrl: 'http://mm',
      initialToken: 'tok',
      fetch: resumeFetch,
      sleep: noSleep,
      createTransport: () => new FakeTransport(),
    });

    transport.fail('drop A');
    transport.fail('drop B'); // same dead transport firing again before the first attempt resolves
    await flush();

    expect(resumeFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts, reporting the last failure', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    const resumeFetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'server exploded' }) }) as unknown as Response);
    let lost: string | undefined;

    driveReconnect(session, {
      matchBaseUrl: 'http://mm',
      initialToken: 'tok',
      fetch: resumeFetch,
      sleep: noSleep,
      maxAttempts: 3,
      createTransport: () => new FakeTransport(),
      onGiveUp: (reason) => { lost = reason; },
    });

    transport.fail('dropped');
    await flush(30);

    expect(resumeFetch).toHaveBeenCalledTimes(3);
    expect(lost).toMatch(/server exploded/);
  });

  it('a resume_failed server error ends the loop immediately and is not treated as a further disconnect', async () => {
    const transport = new FakeTransport();
    const session = makeSession(transport);
    let transport2!: FakeTransport;
    const resumeFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ match: { ...MATCH, token: 'tok2' } }) }) as unknown as Response);
    let lost: string | undefined;
    let reconnected = false;

    driveReconnect(session, {
      matchBaseUrl: 'http://mm',
      initialToken: 'tok',
      fetch: resumeFetch,
      sleep: noSleep,
      createTransport: () => (transport2 = new FakeTransport()),
      onReconnected: () => { reconnected = true; },
      onGiveUp: (reason) => { lost = reason; },
    });

    transport.fail('dropped');
    await flush();
    expect(reconnected).toBe(true);

    transport2.deliver({ type: 'error', code: 'resume_failed', message: 'room is gone' });
    expect(lost).toBe('room is gone');
  });
});
