import { Container, Text } from 'pixi.js';
import type { GameState } from '@dd/engine';
import { Panel, Button } from './widgets';
import { t } from '../../i18n';

/** This floor's not-yet-banked buffer (design/05) — shown on the popup so "bank &
 * leave" isn't an abstract phrase without a number attached to it. */
function totalPending(s: GameState): number {
  let n = 0;
  for (const v of Object.values(s.floorMaterials)) n += v ?? 0;
  return n;
}

/**
 * The extraction-checkpoint choice popup (design/10 legibility fix, 2026-08-02) —
 * replaces the old "HOLD [E] to EXTRACT / TAP [E] to DESCEND" text banner with a real
 * two-button choice, shown only once the player has walked up to the portal (Portal.ts,
 * RoomBuilder). Mirrors PauseMenu.ts's shape: pure presentation, Game owns what each
 * button actually does (wires onExtract/onDescend to CommandBuilder's one-shot
 * confirm latches).
 */
export class PortalPrompt {
  readonly view = new Container();
  private readonly panel = new Panel({ radius: 10, color: 0x0b1a10, alpha: 0.9, borderColor: 0x68d391, borderAlpha: 0.6 });
  private readonly titleText: Text;
  private readonly extractBtn: Button;
  private readonly descendBtn: Button;
  private _isOpen = false;
  // Extract-button Y for the two-choice layout vs. the last floor's Descend-hidden,
  // single-choice layout (set in reposition, read in update) — the midpoint between
  // the two normal slots reads as "vertically centred in the panel" once Descend is gone.
  private normalExtractY = 0;
  private lastFloorExtractY = 0;

  onExtract: (() => void) | null = null;
  onDescend: (() => void) | null = null;

  get isOpen(): boolean {
    return this._isOpen;
  }

  constructor() {
    this.titleText = new Text({
      text: '',
      style: { fill: 0x9ae6b4, fontSize: 15, fontFamily: 'monospace', fontWeight: 'bold', align: 'center', padding: 6 },
    });
    this.titleText.anchor.set(0.5, 0);

    this.extractBtn = new Button('', { w: 260, h: 40 });
    this.extractBtn.onTap = () => this.onExtract?.();
    this.descendBtn = new Button('', { w: 260, h: 40 });
    this.descendBtn.onTap = () => this.onDescend?.();

    this.view.addChild(this.panel.view, this.titleText, this.extractBtn.view, this.descendBtn.view);
    this.view.visible = false;
  }

  /** Re-anchor on viewport resize (Game's relayoutViewport, same convention as HudView). */
  reposition(screenPx: { w: number; h: number }): void {
    const w = Math.min(320, screenPx.w - 24);
    const h = 150;
    this.panel.layout(w, h);
    const x = screenPx.w / 2 - w / 2;
    const y = screenPx.h * 0.6;
    this.panel.view.position.set(x, y);
    this.titleText.style.wordWrap = true;
    this.titleText.style.wordWrapWidth = w - 24;
    // Pixi's wordWrap only breaks at whitespace by default — CJK text has none, so an
    // unbroken Chinese/Japanese/Korean run longer than wordWrapWidth would otherwise
    // overflow the panel as one line instead of wrapping (confirmed live under the zh
    // locale, design/17-i18n.md's flagged-but-unverified risk). `breakWords` forces a
    // character-level break when a run has no earlier break point, fixing CJK without
    // changing anything about how space-delimited English wraps.
    this.titleText.style.breakWords = true;
    this.titleText.position.set(screenPx.w / 2, y + 12);
    this.normalExtractY = y + 52;
    this.lastFloorExtractY = y + 76; // midpoint of the two normal slots, Descend hidden
    this.extractBtn.view.position.set(x + w / 2 - 130, this.normalExtractY);
    this.descendBtn.view.position.set(x + w / 2 - 130, y + 100);
  }

  /** `show` is the caller's already-computed "at an eligible checkpoint AND standing
   *  near the portal" condition — kept out of this class so Game doesn't have to
   *  duplicate it between here and RoomBuilder.setPortalOpen (which needs the same
   *  checkpoint half without the proximity half). `isLastFloor` hides the Descend
   *  button (design/05: the last floor's boss room has no next floor to descend to) —
   *  the Extract button re-centers into its slot so the last floor's popup reads as a
   *  deliberate single choice, not a two-button prompt with one dead half (2026-08-12,
   *  live bug report follow-up: the last floor used to skip this popup entirely and
   *  auto-resolve EXTRACT the instant the boss died, which left no time to walk over to
   *  its death drops). */
  update(s: GameState, show: boolean, isLastFloor = false): void {
    this._isOpen = show;
    this.view.visible = show;
    if (!show) return;
    const nextFloor = s.floorIndex + 2; // 1-based display, one floor further than current
    this.titleText.text = t('hud.portalTitle');
    this.extractBtn.setText(t('hud.portalExtract', { pending: totalPending(s) }));
    this.descendBtn.view.visible = !isLastFloor;
    if (!isLastFloor) this.descendBtn.setText(t('hud.portalDescend', { floor: nextFloor }));
    this.extractBtn.view.position.y = isLastFloor ? this.lastFloorExtractY : this.normalExtractY;
  }
}
