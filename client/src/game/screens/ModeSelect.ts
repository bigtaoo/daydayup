import { Container, Text } from 'pixi.js';
import { Panel, Button } from '../ui/widgets';
import { getUiTexture } from '../../render/uiSkins';
import { t } from '../../i18n';

/**
 * The mode-select branch point (design/10 screen-flow gap — previously PLAY jumped
 * straight to Forge, so a solo-queue co-op/PvP run only existed as a `?online=1`/
 * `?pvp=1` boot-time URL flag, never a menu choice). MainMenu's PLAY now opens this
 * screen instead of Forge directly. Pure presentation, same shape as MainMenu.ts —
 * Game.ts owns what each button actually does.
 *
 * SOLO PvE is unchanged (still routes to Forge → the existing offline loadout/run
 * path). CO-OP and PVP SOLO QUEUE are the new menu-driven entry points into the
 * matchmaking screen (previously URL-flag-only). TUTORIAL is the new standalone
 * teaching level — never forced, just flagged as recommended (`setRecommendTutorial`)
 * for a player who hasn't seen it yet, same "never required" ethos as LoginScreen.
 */
export class ModeSelect {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.82, background: 'hub' });
  private menuCard = new Panel({ radius: 18, color: 0x05070c, alpha: 0.62, borderColor: 0x3a4a5c, borderAlpha: 0.5 });
  private title: Text;
  private soloBtn: Button;
  private coopBtn: Button;
  private pvpSoloBtn: Button;
  private tutorialBtn: Button;
  private recommendedTag: Text;
  private backBtn: Button;
  private recommendTutorial = false;

  onSolo: (() => void) | null = null;
  onCoop: (() => void) | null = null;
  onPvpSolo: (() => void) | null = null;
  onTutorial: (() => void) | null = null;
  onBack: (() => void) | null = null;

  constructor() {
    this.title = new Text({ text: t('modeSelect.title'), style: { fill: 0xf7fafc, fontSize: 38, fontWeight: 'bold', fontFamily: 'sans-serif', padding: 16 } });
    this.title.anchor.set(0.5, 0);

    this.soloBtn = new Button(t('modeSelect.solo'), { w: 260, h: 56, fontSize: 20, color: 0x2f855a, borderColor: 0x68d391 });
    this.soloBtn.onTap = () => this.onSolo?.();
    this.soloBtn.setIcon(getUiTexture('icon_play'));

    this.coopBtn = new Button(t('modeSelect.coop'), { w: 260, h: 48, fontSize: 16, borderColor: 0x718096 });
    this.coopBtn.onTap = () => this.onCoop?.();
    this.coopBtn.setIcon(getUiTexture('icon_party_join'), 0x2c5282);

    this.pvpSoloBtn = new Button(t('modeSelect.pvpSolo'), { w: 260, h: 48, fontSize: 16, borderColor: 0x718096 });
    this.pvpSoloBtn.onTap = () => this.onPvpSolo?.();
    this.pvpSoloBtn.setIcon(getUiTexture('icon_squad'), 0x742a2a);

    this.tutorialBtn = new Button(t('modeSelect.tutorial'), { w: 260, h: 48, fontSize: 16, borderColor: 0x718096 });
    this.tutorialBtn.onTap = () => this.onTutorial?.();
    this.tutorialBtn.setIcon(getUiTexture('icon_account'), 0x6b46c1);

    // Never forced (LoginScreen's own "never required" convention) — just a small
    // badge next to TUTORIAL for a player who hasn't seen it yet, hidden the moment
    // they've completed OR skipped it once (`setRecommendTutorial`).
    this.recommendedTag = new Text({ text: t('modeSelect.recommended'), style: { fill: 0xfbd38d, fontSize: 12, fontFamily: 'monospace', fontWeight: 'bold' } });
    this.recommendedTag.visible = false;

    this.backBtn = new Button(t('modeSelect.back'), { w: 140, h: 34, fontSize: 13, sound: 'ui.back' });
    this.backBtn.onTap = () => this.onBack?.();
    this.backBtn.setIcon(getUiTexture('icon_back'));

    this.view.addChild(
      this.panel.view, this.menuCard.view, this.title,
      this.soloBtn.view, this.coopBtn.view, this.pvpSoloBtn.view, this.tutorialBtn.view,
      this.recommendedTag, this.backBtn.view,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  /** Call before `show()` so the TUTORIAL badge reflects `!MetaState.hasSeenTutorial`. */
  setRecommendTutorial(recommend: boolean): void {
    this.recommendTutorial = recommend;
    this.recommendedTag.visible = recommend;
  }

  show(w: number, h: number): void {
    this.retext();
    this.panel.layout(w, h);
    const cx = w / 2;
    const cy = h / 2;
    this.title.position.set(cx, cy - 190);

    const cardW = 260 + 40;
    const cardTop = cy - 130;
    const cardH = 56 + 12 + 48 + 12 + 48 + 12 + 48 + 24;
    this.menuCard.layout(cardW, cardH);
    this.menuCard.view.position.set(cx - cardW / 2, cardTop);

    this.soloBtn.view.position.set(cx - 130, cardTop + 12);
    this.coopBtn.view.position.set(cx - 130, cardTop + 12 + 56 + 12);
    this.pvpSoloBtn.view.position.set(cx - 130, cardTop + 12 + 56 + 12 + 48 + 12);
    const tutorialY = cardTop + 12 + 56 + 12 + 48 + 12 + 48 + 12;
    this.tutorialBtn.view.position.set(cx - 130, tutorialY);
    this.recommendedTag.position.set(cx - 130 + 260 + 10, tutorialY + 48 / 2 - 7);
    this.backBtn.view.position.set(cx - 70, cardTop + cardH + 24);

    this.recommendedTag.visible = this.recommendTutorial;
    this.view.visible = true;
  }

  hide(): void {
    this.view.visible = false;
  }

  private retext(): void {
    this.title.text = t('modeSelect.title');
    this.soloBtn.setText(t('modeSelect.solo'));
    this.coopBtn.setText(t('modeSelect.coop'));
    this.pvpSoloBtn.setText(t('modeSelect.pvpSolo'));
    this.tutorialBtn.setText(t('modeSelect.tutorial'));
    this.recommendedTag.text = t('modeSelect.recommended');
    this.backBtn.setText(t('modeSelect.back'));
  }
}
