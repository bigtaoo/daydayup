/**
 * Step 13 — Co-op downed / revive (design/05/07, ROADMAP 3.2). Runs AFTER Extraction
 * (12) and BEFORE WinCondition (14), so a bleedout death or a completed revive resolves
 * before the win check reads who is still "up".
 *
 * A player at 0 HP was flagged `downed` by DeathDropsSystem (step 9): frozen, alive, and
 * revivable. Each tick, for every downed player:
 *   - if a VALID reviver exists — another player who is up (alive & not downed), holding
 *     INTERACT, within REVIVE_RANGE — advance the revive channel and PAUSE bleedout, so a
 *     committed, uninterrupted revive always completes. Reaching REVIVE_CHANNEL_TICKS
 *     brings the player back up with REVIVE_HP.
 *   - otherwise the channel is interrupted: progress resets to 0 (design/07 "the reviver
 *     moving / being downed cancels it") and the bleedout timer ticks down. At 0 the
 *     player dies permanently (alive=false).
 *
 * There is no revive cap (design/05): the bleedout timer + the long channel + the
 * reviver's own exposure are the limiter. In single-player there is never a valid reviver,
 * so a downed player simply waits out bleedout — but WinCondition (14) ends the run the
 * same tick it went down anyway ("no player up"), so the timer is inert without a teammate.
 */
import { DOWNED_BLEEDOUT_TICKS, REVIVE_CHANNEL_TICKS, REVIVE_HP, REVIVE_RANGE_GRID } from '../config';
import { toFpGrid } from '../content/convert';
import type { GameState } from '../state/GameState';
import type { PlayerActor } from '../state/entities';

const REVIVE_RANGE_FP = toFpGrid(REVIVE_RANGE_GRID);

export class ReviveSystem {
  tick(state: GameState): void {
    for (const d of state.players) {
      if (!d.alive || !d.downed) continue;
      if (this.hasReviver(state, d)) {
        // Committed revive: bleedout paused, channel advances.
        d.reviveProgressTicks++;
        if (d.reviveProgressTicks >= REVIVE_CHANNEL_TICKS) {
          d.downed = false;
          d.hp = REVIVE_HP;
          d.bleedoutTicks = 0;
          d.reviveProgressTicks = 0;
          d.ticksSinceHit = 0; // treat the rescue as a fresh start for shield regen (design/07)
          state.events.push({ type: 'revived', id: d.id, gx: d.gx, gy: d.gy });
        }
      } else {
        d.reviveProgressTicks = 0; // interrupted → the channel resets (design/07)
        d.bleedoutTicks--;
        if (d.bleedoutTicks <= 0) {
          d.downed = false;
          d.alive = false;
          d.bleedoutTicks = 0;
          state.events.push({ type: 'death', id: d.id, faction: 'player', gx: d.gx, gy: d.gy });
        }
      }
    }
  }

  /** Is another up player holding INTERACT within reach of the downed player `d`? */
  private hasReviver(state: GameState, d: PlayerActor): boolean {
    for (const r of state.players) {
      if (r.id === d.id || !r.alive || r.downed || !r.interacting) continue;
      const dx = (r.gx - d.gx) as number;
      const dy = (r.gy - d.gy) as number;
      const reach = (REVIVE_RANGE_FP + r.radius + d.radius) as number;
      if (dx * dx + dy * dy <= reach * reach) return true;
    }
    return false;
  }
}

// Re-export the bleedout constant next to the system that owns the mechanic, so callers
// (tests) don't need two import sites. The canonical value stays in config.ts.
export { DOWNED_BLEEDOUT_TICKS };
