// Split out of RunOutcome.ts (2026-09-02): "is the local seat on the winning side?" — the
// one question two unrelated reactions both have to answer, and must never answer
// differently. A free-function module rather than a method on either of them, because
// neither owns the notion and both only read state (CLAUDE.md's form (1) split).
import type { GameState, Winner } from '@dd/engine';

/**
 * Whether the seat this client is playing is on the winning side of a finished run.
 *
 * Two win models, matching the two branches of `RunOutcome.handle` this was lifted out of:
 *
 * - **PvE (extract/wipe)** — an outcome the whole party shares. `'enemies'` means no player
 *   was left up, and anything else means the floor was cleared or the run extracted, so the
 *   local seat has no private answer here. Deliberately NOT compared against the seat the sim
 *   names on a win (a hardcoded `0`, *"single-player: player id 0"* in both
 *   `WinConditionSystem` and `ExtractionSystem`): in a co-op run the whole party extracted,
 *   not just seat 0.
 * - **PvP arena (design/15)** — `winner` names one REPRESENTATIVE seat of the winning SQUAD
 *   (the squad's lowest seat index, `WinConditionSystem.tickPlacement`), not necessarily the
 *   local one, so this compares team MEMBERSHIP. Comparing seat identity instead was a real
 *   bug, fixed 2026-08-04: most of a winning squad saw DEFEAT.
 *
 * `winner` is a parameter rather than read off `s` so a caller can answer for the winner a
 * `win` EVENT announced (`EventReactor`, design/08) as well as for the one the state settled
 * on (`RunOutcome`). They are the same value — every producer sets `state.winner` and pushes
 * the event in one tick — and passing it in makes that an argument instead of an assumption.
 */
export function localSeatWon(s: GameState, localOwner: number, winner: Winner): boolean {
  if (!s.zoneEnabled) return winner !== 'enemies';
  // No arena winner named yet -> nobody won. This guard is also what NARROWS `winner` for the
  // index below, and that is the only thing that can catch its removal: without it the lookup
  // yields undefined for `'enemies'`/null and the `!== undefined` test already returns false, so
  // deleting it is behaviourally equivalent and survives every test in the repo. `tsc` fails it
  // (TS2538, "Type null cannot be used as an index type") -- measured, not assumed, 2026-09-02.
  if (typeof winner !== 'number') return false;
  const localTeam = s.players[localOwner]?.teamId;
  const winnerTeam = s.players[winner]?.teamId;
  return localTeam !== undefined && localTeam === winnerTeam;
}
