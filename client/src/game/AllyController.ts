// A deterministic ally for local co-op (ROADMAP 3.1 — making the SECOND player visible
// and live). It produces a normal PlayerCommand for a non-local seat each sim tick, so
// the engine treats the ally exactly like a networked teammate: the command goes through
// the same input-edge quantization (quantizeMove/quantizeAim → integer brad/mag) and the
// same ApplyInputSystem path. Nothing here decides outcomes — it only decides an INPUT,
// which the deterministic engine then simulates (design/08 "render only produces input").
//
// Behaviour: engage the nearest enemy (aim + fire in range, hold spacing), and when the
// floor is quiet, regroup toward the local player so the two stay together through room
// transitions. All from the engine's fp state, no wall-clock / RNG — a bot is just
// another command source, and keeping it state-derived makes the run reproducible.
import { Button, makeCommand, quantizeAim, quantizeMove, FP_SCALE, type Brad, type GameState, type PlayerCommand } from '@dd/engine';

const gridFp = (g: number): number => g * FP_SCALE; // 1 grid unit = FP_SCALE fp
const FIRE_RANGE_FP = gridFp(11); // open fire once this close to a target
const KEEP_DIST_FP = gridFp(4); //   stop advancing inside this ring (don't body-block)
const REGROUP_FP = gridFp(3); //     when idle, only close to the leader if further than this

export class AllyController {
  /** Build the ally seat's command for this tick. `leaderOwner` is the seat to regroup on. */
  build(s: GameState, owner: number, leaderOwner: number, tick: number): PlayerCommand {
    const me = s.players[owner];
    const hold = (me?.facing ?? 0) as Brad;
    const idle = (): PlayerCommand => makeCommand({ owner, tick, moveBrad: 0 as Brad, moveMag: 0, aimBrad: hold, buttons: 0 });
    if (!me || !me.alive || me.downed) return idle();

    // Nearest living enemy (squared fp distance; JS doubles, so no overflow worry).
    let target: { gx: number; gy: number } | null = null;
    let best = Infinity;
    for (const e of s.enemies) {
      if (!e.alive) continue;
      const dx = e.gx - me.gx;
      const dy = e.gy - me.gy;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; target = { gx: e.gx, gy: e.gy }; }
    }

    if (target) {
      const dx = target.gx - me.gx;
      const dy = target.gy - me.gy;
      const dist = Math.hypot(dx, dy);
      // Advance while out of spacing; hold position once close enough to fight.
      const move = dist > KEEP_DIST_FP ? quantizeMove(dx, dy) : { moveBrad: 0 as Brad, moveMag: 0 };
      const buttons = dist <= FIRE_RANGE_FP ? Button.FIRE : 0;
      return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, aimBrad: quantizeAim(dx, dy), buttons });
    }

    // No enemies: regroup on the leader so the pair traverses rooms together.
    const leader = s.players[leaderOwner];
    if (leader && leader.alive) {
      const dx = leader.gx - me.gx;
      const dy = leader.gy - me.gy;
      if (Math.hypot(dx, dy) > REGROUP_FP) {
        const move = quantizeMove(dx, dy);
        return makeCommand({ owner, tick, moveBrad: move.moveBrad, moveMag: move.moveMag, aimBrad: quantizeAim(dx, dy), buttons: 0 });
      }
    }
    return idle();
  }
}
