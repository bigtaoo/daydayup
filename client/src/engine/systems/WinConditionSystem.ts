/**
 * Step 11 — Win condition. All players down → enemies win; last wave cleared with
 * no enemies left → the (single) player wins. Sets state.winner + phase='gameover'
 * once and emits a win event. After gameover the orchestrator returns early and
 * never re-enters here.
 *
 * Ports Game.ts win()/lose() outcome logic; the menu/result shell (design/10)
 * stays render-side and is not the engine's concern.
 */
import type { GameState } from '../state/GameState';

export class WinConditionSystem {
  tick(state: GameState): void {
    if (state.winner !== null) return;

    if (!state.players.some((p) => p.alive)) {
      state.winner = 'enemies';
      state.phase = 'gameover';
      state.events.push({ type: 'win', winner: 'enemies' });
      return;
    }

    if (state.wavesExhausted && state.enemies.length === 0) {
      state.winner = 0; // single-player: player id 0
      state.phase = 'gameover';
      state.events.push({ type: 'win', winner: 0 });
    }
  }
}
