// A deterministic PvP practice bot (design/15 follow-up — matchmaking bot backfill). It
// generalizes AllyController's "just another command source" pattern (design/08 "render
// only produces input") to the arena's every-seat-its-own-team shape: engage the
// nearest LIVING opponent (a different teamId — every real PvP seat has its own,
// AllyController.ts / buildOnlineConfig), and idle when none remain (an empty arena, or
// this bot is the last one standing). Pure function of GameState — no wall-clock/RNG —
// so it is reproducible: any two observers computing this from the SAME confirmed state
// at the SAME tick get the identical command, which is exactly what lets
// server/src/BotClient.ts drive a bot seat as a normal headless client, indistinguishable
// from a real one at the wire level (design/06).
import { type GameState, type PlayerCommand } from '@dd/engine';
import { engageNearest, idleCommand, type Point } from './ai/engage';

export class PvpBotController {
  /** Build this bot seat's command for `tick`. */
  build(s: GameState, owner: number, tick: number): PlayerCommand {
    const me = s.players[owner];
    if (!me || !me.alive || me.downed) return idleCommand(owner, tick);

    // Nearest living opponent on a different team.
    const opponents: Point[] = [];
    for (const p of s.players) if (p !== me && p.alive && !p.downed && p.teamId !== me.teamId) opponents.push(p);

    return engageNearest(owner, tick, me, opponents) ?? idleCommand(owner, tick);
  }
}
