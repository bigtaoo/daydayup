/**
 * PortalPrompt (design/10 legibility fix, 2026-08-02) — the exit/continue popup that
 * replaces the old "HOLD [E] to EXTRACT / TAP [E] to DESCEND" text banner (formerly
 * HudView's checkpointPanel/checkpointText, see HudView.test.ts history). `show` is
 * computed by the caller (GameLoop.ts: at an eligible checkpoint AND standing near the
 * portal) — this class only renders it and reads `s` for the pending/floor text.
 * `isLastFloor` (2026-08-12 follow-up, defaults false) hides the Descend button — the
 * last floor's boss room has no next floor to descend to, but still shows this same
 * popup instead of auto-resolving EXTRACT with no gesture at all (see ExtractionSystem).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createGameState } from '@dd/engine/state/GameState';
import type { EngineConfig } from '@dd/engine/state/GameState';
import { PortalPrompt } from './PortalPrompt';
import { setLocale, resetLocaleForTests } from '../../i18n';

afterEach(() => resetLocaleForTests());

function privateOf(p: PortalPrompt) {
  return p as unknown as {
    titleText: { text: string; style: { wordWrap: boolean; breakWords: boolean } };
    extractBtn: { onTap: (() => void) | null; view: { visible: boolean } };
    descendBtn: { onTap: (() => void) | null; view: { visible: boolean } };
  };
}

const PVE_CFG: EngineConfig = { seed: 1, worldW: 800, worldH: 600, waves: [] };

describe('PortalPrompt — visibility follows the caller-computed `show` flag', () => {
  it('is hidden when show is false, regardless of state content', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, false);
    expect(prompt.view.visible).toBe(false);
    expect(prompt.isOpen).toBe(false);
  });

  it('becomes visible with the real pending count and next floor number when show is true', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    s.floorIndex = 0; // floor 1 of 3
    s.floorMaterials = { mat_fire: 5, mat_ice: 2 }; // pending = 7

    prompt.update(s, true);

    expect(prompt.view.visible).toBe(true);
    expect(prompt.isOpen).toBe(true);
    const p = privateOf(prompt);
    expect(p.titleText.text.length).toBeGreaterThan(0);
  });

  it('hides again the next update() once show flips back to false', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true);
    expect(prompt.view.visible).toBe(true);
    prompt.update(s, false);
    expect(prompt.view.visible).toBe(false);
  });
});

describe('PortalPrompt — last floor hides Descend (2026-08-12, live bug report follow-up)', () => {
  it('shows both buttons when isLastFloor is omitted/false', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true);
    expect(privateOf(prompt).descendBtn.view.visible).toBe(true);
  });

  it('hides the Descend button when isLastFloor is true, keeping Extract visible', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true, true);
    const p = privateOf(prompt);
    expect(p.descendBtn.view.visible).toBe(false);
    expect(p.extractBtn.view.visible).toBe(true);
  });

  it('re-shows Descend on a later update() once isLastFloor flips back to false', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true, true);
    prompt.update(s, true, false);
    expect(privateOf(prompt).descendBtn.view.visible).toBe(true);
  });
});

describe('PortalPrompt — text wrapping (design/17-i18n.md)', () => {
  it('reposition() sets wordWrap AND breakWords — CJK text has no spaces to wrap at, so a plain wordWrap alone would overflow the panel instead of wrapping (confirmed live, 2026-08-03)', () => {
    const prompt = new PortalPrompt();
    prompt.reposition({ w: 320, h: 800 });
    const style = privateOf(prompt).titleText.style;
    expect(style.wordWrap).toBe(true);
    expect(style.breakWords).toBe(true);
  });
});

describe('PortalPrompt — callbacks', () => {
  it('tapping each button fires its own callback, not the other one', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true);
    const calls: string[] = [];
    prompt.onExtract = () => calls.push('extract');
    prompt.onDescend = () => calls.push('descend');

    const p = privateOf(prompt);
    p.extractBtn.onTap?.();
    p.descendBtn.onTap?.();

    expect(calls).toEqual(['extract', 'descend']);
  });
});

describe('PortalPrompt — i18n (design/17-i18n.md)', () => {
  it('defaults to English copy', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    prompt.update(s, true);
    expect(privateOf(prompt).titleText.text).not.toBe('');
  });

  it('translates under zh and reverts under en on a later update()', () => {
    const prompt = new PortalPrompt();
    const s = createGameState(PVE_CFG);
    setLocale('zh');
    prompt.update(s, true);
    const zhTitle = privateOf(prompt).titleText.text;
    setLocale('en');
    prompt.update(s, true);
    const enTitle = privateOf(prompt).titleText.text;
    expect(zhTitle).not.toBe(enTitle);
  });
});
