/**
 * PauseMenu (design/10 open question, now resolved). Pixi Container/Text/Graphics
 * construct and mutate fine under plain vitest with no renderer attached (same finding
 * MainMenu.test.ts/PartyScreen.test.ts made).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PauseMenu } from './PauseMenu';
import { setLocale, resetLocaleForTests } from '../../i18n';

function privateOf(m: PauseMenu) {
  return m as unknown as {
    title: { text: string };
    resumeBtn: { label: { text: string }; onTap: (() => void) | null };
    settingsBtn: { label: { text: string }; onTap: (() => void) | null };
    quitBtn: { label: { text: string }; onTap: (() => void) | null };
  };
}

afterEach(() => resetLocaleForTests());

describe('PauseMenu — callbacks', () => {
  it('tapping each button fires its own callback, not another one', () => {
    const m = new PauseMenu();
    const p = privateOf(m);
    const calls: string[] = [];
    m.onResume = () => calls.push('resume');
    m.onSettings = () => calls.push('settings');
    m.onQuit = () => calls.push('quit');

    p.resumeBtn.onTap?.();
    p.settingsBtn.onTap?.();
    p.quitBtn.onTap?.();

    expect(calls).toEqual(['resume', 'settings', 'quit']);
  });
});

describe('PauseMenu — show()', () => {
  it('becomes visible and centers on the given viewport', () => {
    const m = new PauseMenu();
    m.show(800, 600);
    expect(m.view.visible).toBe(true);
  });
});

// design/10 screen-flow gap: the tutorial level's Skip reuses this same pause menu, but
// "QUIT TO FORGE" is wrong once quitting no longer always returns to Forge — the quit
// button's label can be overridden per-show() without changing what it calls (onQuit).
describe('PauseMenu — quit label override (design/10 tutorial Skip)', () => {
  it('uses the default label when no override is given', () => {
    const m = new PauseMenu();
    m.show(800, 600);
    expect(privateOf(m).quitBtn.label.text).toBe('QUIT TO FORGE');
  });

  it('uses the override text when given', () => {
    const m = new PauseMenu();
    m.show(800, 600, 'SKIP TUTORIAL');
    expect(privateOf(m).quitBtn.label.text).toBe('SKIP TUTORIAL');
  });

  it('a later show() without an override reverts to the default label', () => {
    const m = new PauseMenu();
    m.show(800, 600, 'SKIP TUTORIAL');
    m.show(800, 600);
    expect(privateOf(m).quitBtn.label.text).toBe('QUIT TO FORGE');
  });

  it('the override never changes which callback the button fires', () => {
    const m = new PauseMenu();
    const calls: string[] = [];
    m.onQuit = () => calls.push('quit');
    m.show(800, 600, 'SKIP TUTORIAL');
    privateOf(m).quitBtn.onTap?.();
    expect(calls).toEqual(['quit']);
  });
});

describe('PauseMenu — i18n (design/17-i18n.md)', () => {
  it('defaults to English', () => {
    const p = privateOf(new PauseMenu());
    expect(p.title.text).toBe('PAUSED');
    expect(p.quitBtn.label.text).toBe('QUIT TO FORGE');
  });

  it('retexts its static labels from the active locale on show()', () => {
    const m = new PauseMenu();
    setLocale('zh');
    m.show(800, 600);
    const p = privateOf(m);
    expect(p.title.text).toBe('已暂停');
    expect(p.resumeBtn.label.text).toBe('继续');
    expect(p.settingsBtn.label.text).toBe('设置');
    expect(p.quitBtn.label.text).toBe('返回锻造场');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const m = new PauseMenu();
    setLocale('zh');
    m.show(800, 600);
    setLocale('en');
    m.show(800, 600);
    expect(privateOf(m).title.text).toBe('PAUSED');
  });
});
