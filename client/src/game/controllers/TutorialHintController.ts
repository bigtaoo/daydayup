import type { GameEvent, GameState } from '@dd/engine';
import type { HudView } from '../ui/HudView';
import { THEME } from '../theme';
import { t } from '../../i18n';

/** The bits of Game a hint reaction needs — same tiny-callback-interface convention as
 * EventReactorHost, kept separate from it since the tutorial is the only caller. */
export interface TutorialHintHost {
  readonly localOwner: number;
}

type Step = 'move' | 'swap' | 'deflect' | 'done';

/** How long the move/aim/fire hint stays the active step before yielding to the
 * weapon-swap hint — a render-only timer off the sim's own tick counter (never an engine
 * hook), long enough to read, short enough not to nag a player who's already moving. */
const MOVE_HINT_TICKS = 90; // 3s at the engine's fixed 30Hz step (design/06)

/**
 * The tutorial level's teaching beats (design/10 screen-flow gap) — render-only, follows
 * EventReactor's exact shape (reads `GameState` + the per-tick `events` queue, never
 * mutates the engine, design/10's "UI reads state+events" rule). A step machine
 * (move → swap → deflect → done) drives one-shot HUD toasts as each lesson's condition
 * is met — reuses the existing `HudView.toast` (ToastQueue) rather than a new persistent
 * widget, same transient-feedback channel every pickup/buff toast already uses.
 *
 * Conditions are read entirely off state already present regardless of run mode:
 * `PlayerActor.activeSlot` (weapon-swap) and the `'deflect'` `GameEvent` (melee parry) —
 * no tutorial-specific engine field or hook was added for this.
 */
export class TutorialHintController {
  private step: Step = 'move';
  private startTick = -1;
  private baselineSlot: number | null = null;
  private shownForStep: Step | null = null;

  constructor(
    private readonly hud: HudView,
    private readonly host: TutorialHintHost,
  ) {}

  consume(s: GameState, events: readonly GameEvent[]): void {
    if (this.startTick < 0) this.startTick = s.tick;
    const p = s.players[this.host.localOwner];
    if (!p) return;

    if (this.step === 'move' && s.tick - this.startTick >= MOVE_HINT_TICKS) {
      this.step = 'swap';
      this.baselineSlot = p.activeSlot; // compare future slots against the moment this step began
    }
    if (this.step === 'swap' && this.baselineSlot !== null && p.activeSlot !== this.baselineSlot) {
      this.step = 'deflect';
    }
    if (this.step === 'deflect' && events.some((e) => e.type === 'deflect')) {
      this.step = 'done';
    }

    if (this.step !== this.shownForStep) {
      this.shownForStep = this.step;
      switch (this.step) {
        case 'move':
          this.hud.toast(t('tutorial.hintMove'), THEME.colors.pickupBuff);
          break;
        case 'swap':
          this.hud.toast(t('tutorial.hintSwap'), THEME.colors.pickupBuff);
          break;
        case 'deflect':
          this.hud.toast(t('tutorial.hintDeflect'), THEME.colors.pickupBuff);
          break;
        case 'done':
          this.hud.toast(t('tutorial.hintCleared'), THEME.colors.extractGlow);
          break;
      }
    }
  }

  /** Call once per fresh tutorial attempt (Retry is not a thing here, but a future
   * "play again" would need this) — resets the step machine to the beginning. */
  reset(): void {
    this.step = 'move';
    this.startTick = -1;
    this.baselineSlot = null;
    this.shownForStep = null;
  }
}
