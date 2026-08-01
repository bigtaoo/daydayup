import { Container, Sprite, Text } from 'pixi.js';
import { Panel, Button } from './ui/widgets';
import { getUiTexture } from '../render/uiSkins';

// Render-side screen overlay: the menu / victory / defeat panels that wrap a run
// (design/10 screen flow). It is pure presentation — it reads nothing from the
// engine and only calls back `onConfirm` (start/restart) / `onMenu` (exit to the main
// menu). Lives in the fixed `ui` layer, on top of the HUD.
export class Screens {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.72, background: 'hub' });
  private title: Text;
  private sub: Text;
  private hint: Text;
  private menuBtn: Button;
  /** Win/loss badge above the title (`RunOutcome.ts`'s titles: EXTRACTED/VICTORY
   * ROYALE = win, DEFEAT/ELIMINATED = loss). Hidden until its art is generated
   * (uiSkins.ts's non-blocking preload) — a missing texture just means no badge. */
  private resultIcon = new Sprite();

  // Called when the player confirms (pointer tap or fire/jump edge — wired in Game).
  onConfirm: (() => void) | null = null;
  // Secondary exit — a small link, not the primary confirm action (design/10 decided
  // result-screen content: confirm still re-enters the loadout screen to gear up for
  // the next run; this is for a player who wants to fully back out instead).
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
    this.hint = new Text({
      text: '',
      style: { fill: 0x90cdf4, fontSize: 17, fontFamily: 'monospace', padding: 20 },
    });
    for (const t of [this.title, this.sub, this.hint]) t.anchor.set(0.5);

    this.menuBtn = new Button('MAIN MENU', { w: 150, h: 32, fontSize: 13 });
    this.menuBtn.onTap = () => this.onMenu?.();

    this.resultIcon.anchor.set(0.5);
    this.resultIcon.visible = false;

    this.view.addChild(this.panel.view, this.resultIcon, this.title, this.sub, this.hint, this.menuBtn.view);
    // Full-panel is clickable/tappable on web; the fire/jump fallback covers WeChat.
    // `menuBtn` stops its own pointerdown from bubbling here (widgets.ts's Button), so
    // tapping it doesn't ALSO trigger the full-panel confirm.
    this.view.eventMode = 'static';
    this.view.on('pointerdown', () => this.onConfirm?.());
    this.view.visible = false;
  }

  private layout(w: number, h: number) {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.resultIcon.position.set(cx, cy - 168);
    this.title.position.set(cx, cy - 120);
    this.sub.position.set(cx, cy);
    this.hint.position.set(cx, cy + 96);
    this.menuBtn.view.position.set(cx - 75, cy + 128);
  }

  show(w: number, h: number, title: string, lines: readonly string[], hint: string) {
    this.title.text = title;
    this.sub.text = lines.join('\n');
    this.hint.text = hint;
    const won = title === 'EXTRACTED' || title === 'VICTORY ROYALE';
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
