import { Container, Sprite, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';

// Render-side screen overlay: the menu / victory / defeat panels that wrap a run
// (design/10 screen flow). It is pure presentation — it reads nothing from the
// engine and only calls back `onConfirm` (start/restart) / `onMenu` (exit to the main
// menu). Lives in the fixed `ui` layer, on top of the HUD.
//
// Confirm is a single explicit button, not tap-anywhere-on-the-panel (changed
// ENGINE_VERSION-independent, render-only, 2026-08-17): a player report — "swarmed
// and killed almost instantly, then the screen just seemed to vanish" — traced to
// this screen accepting a pointerdown ANYWHERE on the panel, plus a raw fire-button
// rising edge (`confirmEdge.ts`, now deleted), as "confirm". A player who just died
// mid-fight is often still moving the mouse or holding fire from the fight itself,
// so the very first stray click/press after the swarm kill could dismiss this
// screen before it was even read — reading as "the level just exited on its own"
// even though a real confirm technically fired. `confirmBtn` is now the ONE way to
// leave this screen (mirroring `menuBtn`'s secondary exit) — deliberate, not
// incidental.
export class Screens {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.72, background: 'hub' });
  private title: Text;
  private sub: Text;
  private confirmBtn: Button;
  private menuBtn: Button;
  /** Win/loss badge above the title (`RunOutcome.ts`'s titles: EXTRACTED/VICTORY
   * ROYALE = win, DEFEAT/ELIMINATED = loss). Hidden until its art is generated
   * (uiSkins.ts's non-blocking preload) — a missing texture just means no badge. */
  private resultIcon = new Sprite();

  // Called when the player taps `confirmBtn` (start/restart — re-enters the loadout
  // screen to gear up for the next run).
  onConfirm: (() => void) | null = null;
  // Secondary exit — a smaller button, not the primary confirm action (design/10
  // decided result-screen content: confirm still re-enters the loadout screen; this
  // is for a player who wants to fully back out to the main menu instead).
  onMenu: (() => void) | null = null;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (widgets.ts's
    // Button has the full explanation) — these aren't Buttons, so it's set directly.
    this.title = new Text({
      text: '',
      style: { fill: 0xf7fafc, fontSize: 46, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 },
    });
    // Multi-line stat rows (design/10 result-screen content) — `align:'center'` keeps
    // each row centered under the anchor, not just the block as a whole.
    this.sub = new Text({
      text: '',
      style: { fill: 0xcbd5e0, fontSize: 19, fontFamily: 'monospace', align: 'center', lineHeight: 26, padding: 26 },
    });
    this.title.anchor.set(0.5);
    this.sub.anchor.set(0.5);

    // Primary action — same green "go" styling as MainMenu's PLAY / ModeSelect's
    // SOLO / PartyScreen's START MATCHING (widgets.ts's established convention for
    // "the button this screen wants you to press").
    this.confirmBtn = new Button(t('results.confirmButton'), { w: 220, h: 44, fontSize: 17, color: 0x2f855a, borderColor: 0x68d391 });
    this.confirmBtn.onTap = () => this.onConfirm?.();
    this.menuBtn = new Button(t('results.mainMenuButton'), { w: 150, h: 32, fontSize: 13 });
    this.menuBtn.onTap = () => this.onMenu?.();

    this.resultIcon.anchor.set(0.5);
    this.resultIcon.visible = false;

    this.view.addChild(this.panel.view, this.resultIcon, this.title, this.sub, this.confirmBtn.view, this.menuBtn.view);
    this.view.visible = false;
  }

  private layout(w: number, h: number) {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.resultIcon.position.set(cx, cy - 168);
    this.title.position.set(cx, cy - 120);
    this.sub.position.set(cx, cy);
    this.confirmBtn.view.position.set(cx - 110, cy + 92);
    this.menuBtn.view.position.set(cx - 75, cy + 152);
  }

  show(w: number, h: number, won: boolean, title: string, lines: readonly string[]) {
    // Retext on show (design/17-i18n.md) so a language change takes effect next time
    // this screen opens, same convention as MainMenu.ts's `retext()`.
    this.confirmBtn.setText(t('results.confirmButton'));
    this.menuBtn.setText(t('results.mainMenuButton'));
    this.title.text = title;
    this.sub.text = lines.join('\n');
    const tex = getUiTexture(won ? 'icon_result_extract' : 'icon_result_wiped');
    if (tex) {
      this.resultIcon.texture = tex;
      const size = 64;
      this.resultIcon.scale.set(Math.min(size / tex.width, size / tex.height));
      this.resultIcon.visible = true;
    } else {
      this.resultIcon.visible = false;
    }
    this.layout(w, h);
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }

  /** Re-run the pure layout math against a new viewport size — call whenever the
   * caller's own screenSize() changes while this screen is up (window resize). */
  resize(w: number, h: number) {
    if (this.view.visible) this.layout(w, h);
  }
}
