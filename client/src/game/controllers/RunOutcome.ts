import { TICK_RATE, type GameState } from '@dd/engine';
import { SCORE } from '../score';
import { t } from '../../i18n';
import { totalFloorCount } from '../match/floorCount';
import { localSeatWon } from './localOutcome';

/** The bits of Game a run-outcome reaction needs — score/meta/phase/screen are all
 *  Game-owned state, so this stays a callback interface (same EventReactor-style
 *  decoupling: this file never imports Game.ts). */
export interface RunOutcomeHost {
  readonly localOwner: number;
  addScore(delta: number): void;
  currentScore(): number;
  setPhase(phase: 'victory' | 'defeat'): void;
  hideHud(): void;
  /** Bank the run's carry-out into the persistent account (design/05/14). */
  bankRunMaterials(s: GameState): void;
  /** `won` drives the result icon (Screens.ts) — kept as an explicit flag rather than
   * inferred from `title` text now that `title` is a translated, locale-dependent
   * string (design/17-i18n.md) instead of a fixed English literal. */
  showOutcomeScreen(won: boolean, title: string, lines: readonly string[]): void;
}

/** Total materials safely banked so far this run (design/05 carry-out bag). */
function totalBanked(s: GameState): number {
  let n = 0;
  for (const v of Object.values(s.bankedMaterials)) n += v ?? 0;
  return n;
}

/** `Time M:SS`, from the sim's own tick counter (GameEngine.ts increments `s.tick`
 *  every step) — free: no new state, already part of the hashed/serialized state, so
 *  this is a zero-risk render-only addition (design/06 determinism untouched). */
function timeText(s: GameState): string {
  const totalSec = Math.floor(s.tick / TICK_RATE);
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return t('results.timeLine', { m, ss: String(sec).padStart(2, '0') });
}

/**
 * Decides + shows a run's outcome from the sim's own gameover state (design/15's
 * placement model for an arena run, the PvE extract/wipe model otherwise). Shared by
 * the offline sim (stepSim) and the online/matchmade path (advanceOnline) — both just
 * detect `s.phase === 'gameover'` and hand the state to `handle()`. Extracted out of
 * Game.ts 2026-07-28.
 */
export class RunOutcome {
  constructor(private readonly host: RunOutcomeHost) {}

  handle(s: GameState): void {
    // WHETHER the local seat won and WHICH screen says so are two separate questions: the
    // first is `localSeatWon` (split out of this file 2026-09-02, once the `win` audio cue
    // needed the same answer and had been guessing), the second is the arena/PvE split
    // below, which only picks the copy — placement text or floor/materials text.
    const won = localSeatWon(s, this.host.localOwner, s.winner);
    if (s.zoneEnabled) {
      if (won) this.winArena(s);
      else this.loseArena(s);
    } else {
      if (won) this.win(s);
      else this.lose(s);
    }
  }

  private win(s: GameState): void {
    const floor = s.floorIndex + 1;
    const carried = totalBanked(s);
    // A death (lose) never reaches here, so its floor buffer is simply forfeited, no
    // extra code — banking the carry-out is the only thing that leaves a run.
    this.host.bankRunMaterials(s);
    this.host.setPhase('victory');
    this.host.hideHud();
    this.host.addScore(SCORE.victory);
    this.host.showOutcomeScreen(true, t('results.extractedTitle'), [
      t('results.floorLine', { floor, floorCount: totalFloorCount(s) }),
      t('results.materialsBanked', { count: carried }),
      timeText(s),
      t('results.scoreLine', { score: this.host.currentScore() }),
    ]);
  }

  private lose(s: GameState): void {
    const floor = s.floorIndex + 1;
    this.host.setPhase('defeat');
    this.host.hideHud();
    this.host.showOutcomeScreen(false, t('results.defeatTitle'), [
      t('results.fellOnFloor', { floor, floorCount: totalFloorCount(s) }),
      t('results.materialsLost'),
      timeText(s),
      t('results.scoreLine', { score: this.host.currentScore() }),
    ]);
  }

  /** PvP arena victory (design/15) — last seat standing. No materials/floor concept. */
  private winArena(s: GameState): void {
    this.host.setPhase('victory');
    this.host.hideHud();
    this.host.addScore(SCORE.victory);
    this.host.showOutcomeScreen(true, t('results.victoryTitle'), [
      t('results.placeOf', { total: s.players.length }),
      timeText(s),
      t('results.scoreLine', { score: this.host.currentScore() }),
    ]);
  }

  /** PvP arena elimination (design/15) — `state.placements` is worst-to-best, the
   *  winner never in it, so this seat's rank from the top is (total - its index). */
  private loseArena(s: GameState): void {
    this.host.setPhase('defeat');
    this.host.hideHud();
    const idx = s.placements.indexOf(this.host.localOwner);
    const place = idx === -1 ? s.players.length : s.players.length - idx;
    this.host.showOutcomeScreen(false, t('results.eliminatedTitle'), [
      t('results.placedOfTotal', { place, total: s.players.length }),
      timeText(s),
      t('results.scoreLine', { score: this.host.currentScore() }),
    ]);
  }
}
