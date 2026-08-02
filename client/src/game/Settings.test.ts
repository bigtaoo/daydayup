/**
 * Settings (design/10 "Settings incl. SFX/music volume"; language toggle added by
 * design/17-i18n.md). Pure presentation: it renders a `SettingsState` and reports
 * changes via `onChange`, same convention as every other screen here — driven directly
 * through its private widgets (sliders/buttons), same escape hatch PartyScreen.test.ts/
 * MainMenu.test.ts use, since Pixi has no real pointer/drag simulation under vitest.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Settings } from './Settings';
import { defaultSettingsState, type SettingsState } from '../settings';
import { getLocale, setLocale, resetLocaleForTests } from '../i18n';

function privateOf(s: Settings) {
  return s as unknown as {
    title: { text: string };
    masterLabel: { text: string };
    sfxLabel: { text: string };
    musicLabel: { text: string };
    masterSlider: { onChange: ((v: number) => void) | null };
    sfxSlider: { onChange: ((v: number) => void) | null };
    musicSlider: { onChange: ((v: number) => void) | null };
    muteBtn: { label: { text: string }; onTap: (() => void) | null };
    languageBtn: { label: { text: string }; onTap: (() => void) | null };
    backBtn: { label: { text: string }; onTap: (() => void) | null };
  };
}

afterEach(() => resetLocaleForTests());

describe('Settings — sliders', () => {
  it('dragging a slider reports the new state via onChange, other fields unchanged', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).masterSlider.onChange?.(0.3);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ master: 0.3, sfx: 0.5, music: 0.5, muted: false }));
  });
});

describe('Settings — mute toggle', () => {
  it('tapping mute flips `muted` and relabels to UNMUTE', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).muteBtn.onTap?.();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ muted: true }));
    expect(privateOf(s).muteBtn.label.text).toBe('UNMUTE');
  });
});

describe('Settings — back', () => {
  it('tapping back fires onBack', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onBack = vi.fn();
    s.onBack = onBack;
    privateOf(s).backBtn.onTap?.();
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('Settings — language toggle (design/17-i18n.md)', () => {
  it('starts on English, showing its own name', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    expect(privateOf(s).languageBtn.label.text).toBe('LANGUAGE: English');
  });

  it('tapping the toggle flips the live locale immediately and reports it via onChange', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const onChange = vi.fn();
    s.onChange = onChange;
    privateOf(s).languageBtn.onTap?.();
    expect(getLocale()).toBe('zh'); // setLocale() happens synchronously inside onTap
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ locale: 'zh' }));
  });

  it('the toggle relabels itself and every other static label in the same tap', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    privateOf(s).languageBtn.onTap?.();
    const p = privateOf(s);
    expect(p.languageBtn.label.text).toBe('语言：中文');
    expect(p.title.text).toBe('设置');
    expect(p.backBtn.label.text).toBe('返回');
  });

  it('tapping twice cycles back to English', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    const p = privateOf(s);
    p.languageBtn.onTap?.();
    p.languageBtn.onTap?.();
    expect(getLocale()).toBe('en');
    expect(p.languageBtn.label.text).toBe('LANGUAGE: English');
  });

  it('a later show() re-applies the active locale, e.g. after re-entering from the pause menu', () => {
    const s = new Settings();
    s.show(800, 600, defaultSettingsState());
    setLocale('zh');
    const zhState: SettingsState = { ...defaultSettingsState(), locale: 'zh' };
    s.show(800, 600, zhState);
    expect(privateOf(s).title.text).toBe('设置');
    expect(privateOf(s).masterLabel.text).toContain('总音量');
  });
});
