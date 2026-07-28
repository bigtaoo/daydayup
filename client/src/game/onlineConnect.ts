import { CoopSession } from '../net/CoopSession';
import { WebSocketTransport, LaggyTransport, type Transport } from '../net/transport';
import { findMatch } from '../net/matchmaking';
import { buildOnlineConfig } from './matchConfig';

export interface OnlineConnectOptions {
  matchBaseUrl: string;
  pvp: boolean;
  pvpSeats: number;
  /** `?lag=` dev toggle — wraps the socket to inject synthetic one-way latency (ms). */
  lagMs: number;
  /** The ticket assigns THIS client's seat — the caller's camera/HUD should follow it. */
  onMatchStart: (localOwner: number) => void;
}

/**
 * Ask the control plane for a match and redeem the signed ticket on the gameserver
 * socket, returning a CoopSession that drives the engine off the confirmed frame
 * stream (ROADMAP 3.3). Extracted out of Game.beginOnlineRun 2026-07-28 — pure
 * connection setup, no Game state; the caller owns the resulting session's lifecycle.
 */
export async function connectOnlineSession(opts: OnlineConnectOptions): Promise<CoopSession> {
  const info = await findMatch(opts.matchBaseUrl, {
    playerCount: opts.pvp ? opts.pvpSeats : 2,
    mode: opts.pvp ? 'pvp' : 'coop',
  });
  const url = `${info.wsUrl}?ticket=${encodeURIComponent(info.token)}`;
  let transport: Transport = new WebSocketTransport(url);
  if (opts.lagMs > 0) transport = new LaggyTransport(transport, opts.lagMs);
  return new CoopSession({
    transport,
    roomId: info.roomId,
    owner: info.owner,
    seed: info.seed,
    playerCount: info.playerCount,
    buildConfig: buildOnlineConfig,
    onMatchStart: (m) => opts.onMatchStart(m.localOwner),
  });
}
