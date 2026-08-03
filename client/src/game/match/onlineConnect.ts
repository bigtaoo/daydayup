import { CoopSession } from '../../net/CoopSession';
import { WebSocketTransport, LaggyTransport, type Transport } from '../../net/transport';
import { findMatch } from '../../net/matchmaking';
import { buildOnlineConfig } from './matchConfig';

export interface OnlineConnectOptions {
  matchBaseUrl: string;
  pvp: boolean;
  pvpSeats: number;
  /** `?lag=` dev toggle — wraps the socket to inject synthetic one-way latency (ms). */
  lagMs: number;
  /** A pre-formed party's id (design/05/15's PvP squad follow-up) — see
   * `findMatch`'s `FindMatchOptions.partyId`. Omitted → plain solo queue. */
  partyId?: string;
  /** The ticket assigns THIS client's seat — the caller's camera/HUD should follow it. */
  onMatchStart: (localOwner: number) => void;
  /** Cooperative cancel (design/10 Matchmaking screen's Cancel button) — threaded
   * straight into `findMatch`'s own `signal`. Checked once per poll; setting
   * `cancelled = true` rejects with `'matchmaking cancelled'`. */
  signal?: { cancelled: boolean };
  /**
   * How long to wait for `match_start` after the socket exists before giving up
   * (default 20s). Before this existed there was NO bound at all here — a bad ticket
   * or a server-side stall left the caller's promise resolved-but-useless (a
   * `CoopSession` that would just never start) with no way to detect it; this makes
   * that failure mode a real rejection the Matchmaking screen can show.
   */
  matchStartTimeoutMs?: number;
  /** Injected for tests (default: the real `net/matchmaking.ts` `fetch`/`sleep`), same
   * DI convention `findMatch` itself already documents as "the ONLY real-network
   * dependency, mirroring how transport.ts isolates the WebSocket." Forwarded straight
   * into `findMatch`'s own options. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests (default: a real `WebSocketTransport`) — lets a test drive the
   * post-ticket phase (match_start / timeout / disconnect) with a fake `Transport`
   * instead of a real socket, the same way `net/coopsession.test.ts`'s `FakeTransport`
   * already does for `CoopSession` directly. */
  createTransport?: (url: string) => Transport;
}

/**
 * Ask the control plane for a match, redeem the signed ticket on the gameserver socket,
 * and wait for `match_start` — resolving with a live CoopSession only once the match has
 * actually begun (ROADMAP 3.3). Previously this resolved right after ticket redemption,
 * well before `match_start`, so a caller had no way to observe "still connecting" vs.
 * "genuinely stuck" — and a post-ticket socket failure (bad ticket, dropped connection)
 * was completely unobservable (`WebSocketTransport` had no error/close handling at all).
 * Both are fixed here: `transport.onDisconnect` and a `matchStartTimeoutMs` bound now
 * reject this promise instead of leaving the caller to hang forever.
 */
export async function connectOnlineSession(opts: OnlineConnectOptions): Promise<CoopSession> {
  const info = await findMatch(opts.matchBaseUrl, {
    playerCount: opts.pvp ? opts.pvpSeats : 2,
    mode: opts.pvp ? 'pvp' : 'coop',
    partyId: opts.partyId,
    signal: opts.signal,
    fetch: opts.fetch,
    sleep: opts.sleep,
  });
  const url = `${info.wsUrl}?ticket=${encodeURIComponent(info.token)}`;
  let transport: Transport = opts.createTransport ? opts.createTransport(url) : new WebSocketTransport(url);
  if (opts.lagMs > 0) transport = new LaggyTransport(transport, opts.lagMs);

  return new Promise<CoopSession>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      transport.close();
      reject(new Error('matchmaking: timed out waiting for the match to start'));
    }, opts.matchStartTimeoutMs ?? 20_000);

    transport.onDisconnect?.((reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`matchmaking: connection failed (${reason})`));
    });

    const session = new CoopSession({
      transport,
      roomId: info.roomId,
      owner: info.owner,
      seed: info.seed,
      playerCount: info.playerCount,
      buildConfig: buildOnlineConfig,
      onMatchStart: (m) => {
        opts.onMatchStart(m.localOwner);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(session);
      },
    });
  });
}
