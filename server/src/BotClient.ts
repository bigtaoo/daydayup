/**
 * PvP practice-bot runner (design/15 follow-up, Matchmaker.ts's `onBotFill`). When a
 * PvP queue bot-fills after sitting `pvpBotFillMs` without enough real players, matchsvc
 * spawns one of these per empty seat. It redeems a ticket and opens the gameserver
 * socket EXACTLY like a real player's browser tab would (same ticket-authenticated `/ws`
 * handshake, same `join`/`cmd`/`result` wire messages) — MatchRoom/RoomManager need no
 * bot concept at all, because a bot connection is byte-for-byte the same shape as a
 * human one.
 *
 * It drives a real headless `CoopSession` off the server's confirmed frame stream (full
 * determinism, no shortcuts — the engine can't tell a bot from a remote player, design/08)
 * and picks its own commands via `PvpBotController` (fight the nearest living opponent,
 * hold position otherwise). `buildPvpEngineConfig` (client/src/game/pvpConfig.ts) is the
 * SAME function `Game.buildOnlineConfig` calls for a real player's pvp branch, so the
 * bot's engine is byte-identical to every human client's (design/06 anti-drift).
 *
 * Known limitation (accepted, not solved here): if a bot's socket drops mid-match, this
 * seat behaves exactly like a disconnected real player — MatchRoom pauses the metronome
 * waiting for a reconnect (co-op/PvP are both latency-tolerant) rather than forfeiting.
 * There is no bot reconnect logic; a dropped bot stalls the match same as a dropped human
 * would, an existing accepted tradeoff this feature doesn't change.
 */
import { WebSocket } from 'ws';
import { CoopSession } from '@dd/net/CoopSession';
import type { Transport } from '@dd/net/transport';
import { hashState, type ClientMsg, type ServerMsg } from '@dd/engine';
import { buildPvpEngineConfig } from '@dd/game/match/pvpConfig';
import { PvpBotController } from '@dd/game/controllers/PvpBotController';

export interface BotClientOptions {
  wsUrl: string; // the gameserver's ws:// origin (matchsvc's GAMESERVER_URL)
  token: string; // a ticket signed for this bot's own seat
  roomId: string;
  owner: number;
  seed: number;
  playerCount: number;
  /** Sim tick cadence (ms) — matches the client's fixed step (30 Hz, SIM_DT_MS). */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 1000 / 30;

/** Node `ws`-backed Transport — the only place this module touches a real socket. */
class WsTransport implements Transport {
  private handler: ((msg: ServerMsg) => void) | null = null;
  private readonly ws: WebSocket;
  private readonly outbox: string[] = [];
  private open = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('open', () => {
      this.open = true;
      for (const s of this.outbox) this.ws.send(s);
      this.outbox.length = 0;
    });
    this.ws.on('message', (data: Buffer) => {
      if (!this.handler) return;
      try {
        this.handler(JSON.parse(data.toString('utf8')) as ServerMsg);
      } catch {
        /* ignore malformed frames */
      }
    });
  }

  send(msg: ClientMsg): void {
    const s = JSON.stringify(msg);
    if (this.open) this.ws.send(s);
    else this.outbox.push(s); // flushed on open
  }

  onMessage(handler: (msg: ServerMsg) => void): void {
    this.handler = handler;
  }

  close(): void {
    this.ws.close();
  }
}

/** Spawn a bot's own connection + session. Fire-and-forget — matchsvc doesn't track the
 * handle; the bot lives and dies with the match (closes itself at match/gameover). */
export function spawnBotClient(opts: BotClientOptions): void {
  runBotClient({ ...opts, transport: new WsTransport(`${opts.wsUrl}?ticket=${encodeURIComponent(opts.token)}`) });
}

/** The testable core: takes an injected Transport (a fake in tests, WsTransport in prod). */
export function runBotClient(opts: BotClientOptions & { transport: Transport }): { stop: () => void } {
  const bot = new PvpBotController();
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let done = false;

  const session = new CoopSession({
    transport: opts.transport,
    roomId: opts.roomId,
    owner: opts.owner,
    seed: opts.seed,
    playerCount: opts.playerCount,
    buildConfig: () => buildPvpEngineConfig(opts.seed, opts.playerCount),
    onMatchStart: () => {
      timer = setInterval(tick, tickMs);
    },
  });

  function stop(): void {
    if (done) return;
    done = true;
    if (timer !== null) clearInterval(timer);
    session.close();
  }

  function tick(): void {
    if (done || !session.started) return;
    const s = session.state!;
    session.submit(bot.build(s, opts.owner, session.frame));
    session.drive();
    if (s.phase === 'gameover') {
      session.reportResult(hashState(s));
      stop();
    }
  }

  return { stop };
}
