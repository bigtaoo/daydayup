import { Container, Text } from 'pixi.js';
import { Panel, Button } from './ui/widgets';

/**
 * The boot/main-menu screen (design/10 screen flow — the front door that never got
 * built). Pure presentation, same shape as PauseMenu.ts/Settings.ts: Game owns what
 * each button actually does. Deliberately minimal (design/10's "clutter" decision) —
 * two buttons, no PvP/Arena entry yet (that's still a URL-flag boot-time choice, not a
 * runtime one — see Game.ts's `online`/`pvp`/`arenaDemo` fields).
 */
export class MainMenu {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82 });
  private title: Text;
  private subtitle: Text;
  private playBtn: Button;
  private settingsBtn: Button;

  onPlay: (() => void) | null = null;
  onSettings: (() => void) | null = null;

  constructor() {
    // `padding` guards against a real observed font-metrics clipping bug (see
    // widgets.ts's Button — same mitigation, needed here too since these aren't Buttons).
    this.title = new Text({ text: 'DAYDAYUP', style: { fill: 0xf7fafc, fontSize: 46, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);
    this.subtitle = new Text({ text: 'descend, extract, survive', style: { fill: 0x90cdf4, fontSize: 16, fontFamily: 'monospace', padding: 26 } });
    this.subtitle.anchor.set(0.5, 0);

    this.playBtn = new Button('PLAY', { w: 220, h: 56, fontSize: 22 });
    this.playBtn.onTap = () => this.onPlay?.();
    this.settingsBtn = new Button('SETTINGS', { w: 160, h: 36, fontSize: 14 });
    this.settingsBtn.onTap = () => this.onSettings?.();

    this.view.addChild(this.panel.view, this.title, this.subtitle, this.playBtn.view, this.settingsBtn.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  show(w: number, h: number) {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.title.position.set(cx, cy - 150);
    this.subtitle.position.set(cx, cy - 96);
    this.playBtn.view.position.set(cx - 110, cy - 20);
    this.settingsBtn.view.position.set(cx - 80, cy + 50);
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }
}
