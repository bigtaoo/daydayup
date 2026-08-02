import { Container, Text } from 'pixi.js';
import { Panel, Button } from './ui/widgets';
import { getUiTexture } from '../render/uiSkins';

/**
 * The in-run pause menu (design/10 open question, now resolved) — resume / open
 * settings / quit to the forge, reachable mid-run instead of only between runs.
 * Pure presentation, same shape as Screens.ts/Settings.ts: it reads nothing from the
 * engine, Game owns what each button actually does.
 */
export class PauseMenu {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82, background: 'hub' });
  private title: Text;
  private resumeBtn: Button;
  private settingsBtn: Button;
  private quitBtn: Button;

  onResume: (() => void) | null = null;
  onSettings: (() => void) | null = null;
  onQuit: (() => void) | null = null;

  constructor() {
    this.title = new Text({ text: 'PAUSED', style: { fill: 0xf7fafc, fontSize: 34, fontWeight: 'bold', fontFamily: 'sans-serif' } });
    this.title.anchor.set(0.5, 0);

    this.resumeBtn = new Button('RESUME', { w: 200, h: 40 });
    this.resumeBtn.onTap = () => this.onResume?.();
    this.resumeBtn.setIcon(getUiTexture('icon_play'));
    this.settingsBtn = new Button('SETTINGS', { w: 200, h: 40 });
    this.settingsBtn.onTap = () => this.onSettings?.();
    this.settingsBtn.setIcon(getUiTexture('icon_settings'));
    this.quitBtn = new Button('QUIT TO FORGE', { w: 200, h: 40 });
    this.quitBtn.onTap = () => this.onQuit?.();
    this.quitBtn.setIcon(getUiTexture('icon_quit'));

    this.view.addChild(this.panel.view, this.title, this.resumeBtn.view, this.settingsBtn.view, this.quitBtn.view);
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  show(w: number, h: number) {
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.title.position.set(cx, cy - 130);
    this.resumeBtn.view.position.set(cx - 100, cy - 60);
    this.settingsBtn.view.position.set(cx - 100, cy - 5);
    this.quitBtn.view.position.set(cx - 100, cy + 50);
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }
}
