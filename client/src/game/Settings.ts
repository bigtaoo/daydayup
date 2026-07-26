import { Container, Text } from 'pixi.js';
import type { SettingsState } from '../settings';
import { Panel, Slider, Button } from './ui/widgets';

/**
 * The settings screen (design/10 "Settings incl. SFX/music volume"). Pure
 * presentation: it renders a `SettingsState` and reports changes via `onChange`; Game
 * owns persistence (SettingsStore) and applying volume to the AudioBus. Reached from
 * the forge outpost only — there's no in-run pause menu yet (design/10 open question).
 */
export class Settings {
  readonly view = new Container();
  private panel = new Panel({ alpha: 0.88 });
  private title: Text;
  private masterLabel: Text;
  private sfxLabel: Text;
  private musicLabel: Text;
  private masterSlider: Slider;
  private sfxSlider: Slider;
  private musicSlider: Slider;
  private muteBtn: Button;
  private backBtn: Button;

  onChange: ((s: SettingsState) => void) | null = null;
  onBack: (() => void) | null = null;

  private state: SettingsState = { master: 1, sfx: 0.5, music: 0.5, muted: false };

  constructor() {
    this.title = new Text({ text: 'SETTINGS', style: { fill: 0xf7fafc, fontSize: 30, fontWeight: 'bold', fontFamily: 'sans-serif' } });
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

    this.backBtn = new Button('BACK', { w: 120, h: 34 });
    this.backBtn.onTap = () => this.onBack?.();

    this.view.addChild(
      this.panel.view, this.title,
      this.masterLabel, this.masterSlider.view,
      this.sfxLabel, this.sfxSlider.view,
      this.musicLabel, this.musicSlider.view,
      this.muteBtn.view, this.backBtn.view,
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
    this.masterSlider.set(this.state.master);
    this.sfxSlider.set(this.state.sfx);
    this.musicSlider.set(this.state.music);
    this.masterLabel.text = `Master   ${pct(this.state.master)}`;
    this.sfxLabel.text = `SFX      ${pct(this.state.sfx)}`;
    this.musicLabel.text = `Music    ${pct(this.state.music)}`;
    this.muteBtn.setText(this.state.muted ? 'UNMUTE' : 'MUTE');
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
