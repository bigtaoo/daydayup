/**
 * Step 14 — Win condition. PvE: no player "up" (all downed-or-dead) → enemies win;
 * last wave cleared with no enemies left → the (single) player wins. PvP (arena
 * mode, design/15 ROADMAP 4.2e): last seat standing wins, with a per-seat finish
 * order recorded as each seat is eliminated. Sets state.winner + phase='gameover'
 * once and emits a win event. After gameover the orchestrator returns early and
 * never re-enters here.
 *
 * Runs AFTER ReviveSystem (step 13, ROADMAP 3.2) so a completed revive / bleedout death
 * has already resolved this tick, and AFTER ExtractionSystem (step 12, ROADMAP 1.4/1.5): when `floorsEnabled`,
 * reaching wavesExhausted-with-no-enemies is a per-floor CHECKPOINT, not an
 * automatic win — ExtractionSystem owns that transition (EXTRACT/DESCEND), so this
 * system's wavesExhausted branch is skipped entirely for a floors-mode run. For
 * every config that predates 1.4 (floorsEnabled always false), this guard never
 * fires and behavior is byte-identical to before — additive, no ENGINE_VERSION bump.
 *
 * Ports Game.ts win()/lose() outcome logic; the menu/result shell (design/10)
 * stays render-side and is not the engine's concern.
 */
import type { GameState } from '../state/GameState';

export class WinConditionSystem {
  tick(state: GameState): void {
    if (state.winner !== null) return;

    // Arena mode (design/15) is a completely different win model — elimination
    // placement, not "enemies win"/wave-clear — so it branches BEFORE any PvE check
    // below rather than layering onto them (every pre-4.2e config never sets
    // zoneEnabled, so this is additive — byte-identical, no ENGINE_VERSION bump).
    if (state.zoneEnabled) {
      this.tickPlacement(state);
      return;
    }

    // "Up" = alive AND not downed (design/05/07, ROADMAP 3.2). A run ends the moment no
    // player is up — every player downed-or-dead, so no one remains to revive. In
    // single-player this fires the same tick the sole player goes down (its old death
    // behaviour); in co-op the run survives as long as one teammate is still standing.
    if (!state.players.some((p) => p.alive && !p.downed)) {
      state.winner = 'enemies';
      state.phase = 'gameover';
      state.events.push({ type: 'win', winner: 'enemies' });
      return;
    }

    if (state.floorsEnabled) return; // ExtractionSystem (12) owns the win transition instead

    if (state.wavesExhausted && state.enemies.length === 0) {
      state.winner = 0; // single-player: player id 0
      state.phase = 'gameover';
      state.events.push({ type: 'win', winner: 0 });
    }
  }

  /**
   * Battle-royale placement (design/15). Record every newly-eliminated seat (worst
   * place first); when exactly one seat remains, it's the winner. The zero-survivors
   * case (two-or-more seats died on the identical tick) is design/15's explicit
   * same-tick tiebreak — deterministic, never a coin flip: ascending `teamId` places
   * higher, so the lowest-teamId dead seat is pulled out as the winner instead of
   * being left in `placements`.
   */
  private tickPlacement(state: GameState): void {
    state.players.forEach((p, i) => {
      if (!p.alive && !state.placements.includes(i)) state.placements.push(i);
    });

    const survivors: number[] = [];
    state.players.forEach((p, i) => {
      if (p.alive) survivors.push(i);
    });
    if (survivors.length > 1) return; // match continues

    let winnerIdx: number;
    if (survivors.length === 1) {
      winnerIdx = survivors[0]!;
    } else {
      winnerIdx = 0;
      for (let i = 1; i < state.players.length; i++) {
        if (state.players[i]!.teamId < state.players[winnerIdx]!.teamId) winnerIdx = i;
      }
      const pos = state.placements.indexOf(winnerIdx);
      if (pos !== -1) state.placements.splice(pos, 1); // the winner is 1st, not a loser
    }

    state.winner = winnerIdx;
    state.phase = 'gameover';
    state.events.push({ type: 'win', winner: winnerIdx });
  }
}
