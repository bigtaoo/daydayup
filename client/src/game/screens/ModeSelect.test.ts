/**
 * ModeSelect (design/10 screen-flow gap — PLAY's new branch point). Same plain-vitest,
 * no-renderer convention as MainMenu.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ModeSelect } from './ModeSelect';
import { setLocale, resetLocaleForTests } from '../../i18n';

function privateOf(m: ModeSelect) {
  return m as unknown as {
    title: { text: string };
    soloBtn: { label: { text: string }; onTap: (() => void) | null };
    coopBtn: { label: { text: string }; onTap: (() => void) | null };
    pvpSoloBtn: { label: { text: string }; onTap: (() => void) | null };
    tutorialBtn: { label: { text: string }; onTap: (() => void) | null };
    backBtn: { label: { text: string }; onTap: (() => void) | null };
    recommendedTag: { visible: boolean; text: string };
  };
}

afterEach(() => resetLocaleForTests());

describe('ModeSelect — callbacks', () => {
  it('tapping each button fires its own callback, not another one', () => {
    const m = new ModeSelect();
    const p = privateOf(m);
    const calls: string[] = [];
    m.onSolo = () => calls.push('solo');
    m.onCoop = () => calls.push('coop');
    m.onPvpSolo = () => calls.push('pvpSolo');
    m.onTutorial = () => calls.push('tutorial');
    m.onBack = () => calls.push('back');

    p.soloBtn.onTap?.();
    p.coopBtn.onTap?.();
    p.pvpSoloBtn.onTap?.();
    p.tutorialBtn.onTap?.();
    p.backBtn.onTap?.();

    expect(calls).toEqual(['solo', 'coop', 'pvpSolo', 'tutorial', 'back']);
  });
});

describe('ModeSelect — show()', () => {
  it('becomes visible on show()', () => {
    const m = new ModeSelect();
    m.show(800, 600);
    expect(m.view.visible).toBe(true);
  });

  it('starts hidden', () => {
    const m = new ModeSelect();
    expect(m.view.visible).toBe(false);
  });
});

describe('ModeSelect — tutorial badge', () => {
  it('hides the "recommended" badge by default', () => {
    const m = new ModeSelect();
    m.show(800, 600);
    expect(privateOf(m).recommendedTag.visible).toBe(false);
  });

  it('shows the badge once setRecommendTutorial(true) is called before show()', () => {
    const m = new ModeSelect();
    m.setRecommendTutorial(true);
    m.show(800, 600);
    expect(privateOf(m).recommendedTag.visible).toBe(true);
  });

  it('setRecommendTutorial(false) hides it again on a later show()', () => {
    const m = new ModeSelect();
    m.setRecommendTutorial(true);
    m.show(800, 600);
    m.setRecommendTutorial(false);
    m.show(800, 600);
    expect(privateOf(m).recommendedTag.visible).toBe(false);
  });
});

describe('ModeSelect — i18n (design/17-i18n.md)', () => {
  it('defaults to English', () => {
    const m = new ModeSelect();
    const p = privateOf(m);
    expect(p.title.text).toBe('SELECT MODE');
    expect(p.soloBtn.label.text).toBe('SOLO PvE');
  });

  it('retexts its static labels from the active locale on show()', () => {
    const m = new ModeSelect();
    setLocale('zh');
    m.show(800, 600);
    const p = privateOf(m);
    expect(p.title.text).toBe('选择模式');
    expect(p.soloBtn.label.text).toBe('单人闯关');
    expect(p.coopBtn.label.text).toBe('联机合作');
    expect(p.pvpSoloBtn.label.text).toBe('大逃杀单排');
    expect(p.tutorialBtn.label.text).toBe('新手教程');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const m = new ModeSelect();
    setLocale('zh');
    m.show(800, 600);
    setLocale('en');
    m.show(800, 600);
    expect(privateOf(m).title.text).toBe('SELECT MODE');
  });
});
