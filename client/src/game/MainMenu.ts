import { Container, Text } from 'pixi.js';
import { Panel, Button } from './ui/widgets';
import { getSession } from '../net/session';

/**
 * The boot/main-menu screen (design/10 screen flow — the front door that never got
 * built). Pure presentation, same shape as PauseMenu.ts/Settings.ts: Game owns what
 * each button actually does. Deliberately minimal (design/10's "clutter" decision) —
 * PvP arena entry is still a URL-flag boot-time choice (see Game.ts's `online`/`pvp`/
 * `arenaDemo` fields); SQUAD is the one runtime entry point added so far (design/05/15's
 * PvP squad follow-up) — a pre-formed party still needs somewhere to be created/joined
 * before a run starts, which a boot-time flag alone can't offer. ACCOUNT (design/16
 * -accounts.md) opens login/register; its label reflects the current session so a
 * logged-in player sees who they are without opening the screen.
 */
export class MainMenu {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82 });
  private title: Text;
  private subtitle: Text;
  private playBtn: Button;
  private squadBtn: Button;
  private accountBtn: Button;
  private settingsBtn: Button;

  onPlay: (() => void) | null = null;
  onSquad: (() => void) | null = null;
  onAccount: (() => void) | null = null;
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
    this.squadBtn = new Button('SQUAD', { w: 220, h: 40, fontSize: 16 });
    this.squadBtn.onTap = () => this.onSquad?.();
    this.accountBtn = new Button('LOGIN', { w: 220, h: 36, fontSize: 14 });
    this.accountBtn.onTap = () => this.onAccount?.();
    this.settingsBtn = new Button('SETTINGS', { w: 160, h: 36, fontSize: 14 });
    this.settingsBtn.onTap = () => this.onSettings?.();

    this.view.addChild(
      this.panel.view, this.title, this.subtitle,
      this.playBtn.view, this.squadBtn.view, this.accountBtn.view, this.settingsBtn.view,
    );
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
    this.squadBtn.view.position.set(cx - 110, cy + 42);
    this.accountBtn.view.position.set(cx - 110, cy + 94);
    this.settingsBtn.view.position.set(cx - 80, cy + 148);
    this.refreshAccountLabel();
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }

  /** Call after a login/register/logout so the button reflects the current session
   * without needing to re-`show()` the whole menu. */
  refreshAccountLabel() {
    const session = getSession();
    this.accountBtn.setText(session ? `Hi, ${session.username}` : 'LOGIN');
  }
}
