/**
 * Step 14 — Win condition. No player "up" (all downed-or-dead) → enemies win; last wave
 * cleared with no enemies left → the (single) player wins. Sets state.winner +
 * phase='gameover' once and emits a win event. After gameover the orchestrator returns
 * early and never re-enters here.
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
}
