import { Container, Text } from 'pixi.js';
import type { SettingsState } from '../../settings';
import { Panel, Slider, Button } from '../ui/widgets';
import { t, setLocale, type Locale } from '../../i18n';

/** Display name for the LANGUAGE toggle — always shown in that language's own name
 * (not translated), same convention most apps use for a language picker. */
const LOCALE_NAMES: Record<Locale, string> = { en: 'English', zh: '中文' };
const OTHER_LOCALE: Record<Locale, Locale> = { en: 'zh', zh: 'en' };

/**
 * The settings screen (design/10 "Settings incl. SFX/music volume"). Pure
 * presentation: it renders a `SettingsState` and reports changes via `onChange`; Game
 * owns persistence (SettingsStore) and applying volume to the AudioBus. Reached from
 * the forge outpost only — there's no in-run pause menu yet (design/10 open question).
 */
export class Settings {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.88, background: 'hub' });
  private title: Text;
  private masterLabel: Text;
  private sfxLabel: Text;
  private musicLabel: Text;
  private masterSlider: Slider;
  private sfxSlider: Slider;
  private musicSlider: Slider;
  private muteBtn: Button;
  private languageBtn: Button;
  private backBtn: Button;

  onChange: ((s: SettingsState) => void) | null = null;
  onBack: (() => void) | null = null;

  private state: SettingsState = { master: 1, sfx: 0.5, music: 0.5, muted: false, locale: 'en' };

  constructor() {
    this.title = new Text({ text: t('settings.title'), style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif' } });
    this.title.anchor.set(0.5, 0);

    const labelStyle = { fill: 0xcbd5e0, fontSize: 16, fontFamily: 'monospace' as const };
    this.masterLabel = new Text({ text: '', style: labelStyle });
    this.sfxLabel = new Text({ text: '', style: labelStyle });
    this.musicLabel = new Text({ text: '', style: labelStyle });

    // Full-view eventMode is already 'static' below (needed for the sliders' drag
    // surface, design/10 "no DOM widgets" — everything is a Pixi hit-area).
    this.masterSlider = new Slider({ w: 260, dragSurface: this.view });
    this.sfxSlider = new Slider({ w: 260, dragSurface: this.view });
    this.musicSlider = new Slider({ w: 260, dragSurface: this.view });
    this.masterSlider.onChange = (v) => this.update({ ...this.state, master: v });
    this.sfxSlider.onChange = (v) => this.update({ ...this.state, sfx: v });
    this.musicSlider.onChange = (v) => this.update({ ...this.state, music: v });

    this.muteBtn = new Button('', { w: 120, h: 34 });
    this.muteBtn.onTap = () => this.update({ ...this.state, muted: !this.state.muted });

    // Language toggle (design/17-i18n.md) — same tappable-toggle pattern as muteBtn
    // (design/10 "no DOM widgets"). Only two locales exist today, so a toggle rather
    // than a picker; `setLocale` takes effect immediately so this button's own next
    // `syncWidgets()` already reads in the new language.
    this.languageBtn = new Button('', { w: 160, h: 34 });
    this.languageBtn.onTap = () => {
      const next = OTHER_LOCALE[this.state.locale];
      setLocale(next);
      this.update({ ...this.state, locale: next });
    };

    this.backBtn = new Button(t('settings.back'), { w: 120, h: 34 });
    this.backBtn.onTap = () => this.onBack?.();

    this.view.addChild(
      this.panel.view, this.title,
      this.masterLabel, this.masterSlider.view,
      this.sfxLabel, this.sfxSlider.view,
      this.musicLabel, this.musicSlider.view,
      this.muteBtn.view, this.languageBtn.view, this.backBtn.view,
    );
    this.view.eventMode = 'static';
    this.view.visible = false;
  }

  private update(next: SettingsState) {
    this.state = next;
    this.syncWidgets();
    this.onChange?.(this.state);
  }

  private syncWidgets() {
    // Re-applies static labels too (not just the ones that vary with `state`) — same
    // "resync on every call" convention as the rest of this method, so a language
    // change (design/17-i18n.md) takes effect the next time this screen is shown.
    this.title.text = t('settings.title');
    this.backBtn.setText(t('settings.back'));
    this.masterSlider.set(this.state.master);
    this.sfxSlider.set(this.state.sfx);
    this.musicSlider.set(this.state.music);
    // `padEnd` (not a literal-spaces template) so the value column still lines up
    // regardless of how long the translated label word is.
    this.masterLabel.text = `${t('settings.master').padEnd(9)}${pct(this.state.master)}`;
    this.sfxLabel.text = `${t('settings.sfx').padEnd(9)}${pct(this.state.sfx)}`;
    this.musicLabel.text = `${t('settings.music').padEnd(9)}${pct(this.state.music)}`;
    this.muteBtn.setText(this.state.muted ? t('settings.unmute') : t('settings.mute'));
    this.languageBtn.setText(t('settings.language', { name: LOCALE_NAMES[this.state.locale] }));
  }

  show(w: number, h: number, s: SettingsState) {
    this.state = s;
    this.panel.layout(w, h);
    const cx = w / 2;
    const rowX = cx - 130;
    let y = Math.max(40, h * 0.15);
    this.title.position.set(cx, y);
    y += 70;
    for (const [label, slider] of [
      [this.masterLabel, this.masterSlider] as const,
      [this.sfxLabel, this.sfxSlider] as const,
      [this.musicLabel, this.musicSlider] as const,
    ]) {
      label.position.set(rowX, y);
      slider.view.position.set(rowX, y + 30);
      y += 70;
    }
    this.languageBtn.view.position.set(cx - 80, y + 10);
    y += 44;
    this.muteBtn.view.position.set(cx - 130, y + 10);
    this.backBtn.view.position.set(cx + 10, y + 10);
    this.syncWidgets();
    this.view.visible = true;
  }

  hide() {
    this.view.visible = false;
  }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
