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
import { Button, makeCommand, quantizeAim, quantizeMove, FP_SCALE, type Brad, type GameState, type PlayerCommand } from '@dd/engine';

const gridFp = (g: number): number => g * FP_SCALE; // 1 grid unit = FP_SCALE fp
const FIRE_RANGE_FP = gridFp(11); // open fire once this close to a target
const KEEP_DIST_FP = gridFp(4); //   stop advancing inside this ring (don't body-block)

export class PvpBotController {
  /** Build this bot seat's command for `tick`. */
  build(s: GameState, owner: number, tick: number): PlayerCommand {
    const me = s.players[owner];
    const hold = (me?.facing ?? 0) as Brad;
    const idle = (): PlayerCommand => makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, aimBrad: hold, buttons: 0 });
    if (!me || !me.alive || me.downed) return idle();

    // Nearest living opponent on a different team (squared fp distance; JS doubles, no
    // overflow worry at arena scale).
    let target: { gx: number; gy: number } | null = null;
    let best = Infinity;
    for (const p of s.players) {
      if (p === me || !p.alive || p.downed || p.teamId === me.teamId) continue;
      const dx = p.gx - me.gx;
      const dy = p.gy - me.gy;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; target = { gx: p.gx, gy: p.gy }; }
    }

    if (!target) return idle(); // no live opponents left — nothing to engage

    const dx = target.gx - me.gx;
    const dy = target.gy - me.gy;
    const dist = Math.hypot(dx, dy);
    // Advance while out of spacing; hold position once close enough to fight.
    const move = dist > KEEP_DIST_FP ? quantizeMove(dx, dy) : { moveBrad: 0 as Brad, moveMag: 0 };
    const buttons = dist <= FIRE_RANGE_FP ? Button.FIRE : 0;
    return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, aimBrad: quantizeAim(dx, dy), buttons });
  }
}
