/**
 * Screens (the victory/defeat outcome overlay). Pixi Container/Text/Graphics construct
 * and mutate fine under plain vitest with no renderer attached (same finding
 * TouchControlsView.test.ts / PartyScreen.test.ts made) — asserted here via
 * `.position`/`.visible`, not pixel output.
 *
 * `resize()` is the fix for a real bug: the canvas already tracks the browser viewport
 * (WebPlatform's `resizeTo: window`), but this screen's Panel/text positions were only
 * ever computed once, at whatever size was current when show() was called — so a
 * window resize left them pinned to the old size (reported as a boxed-in-the-corner
 * layout with black bars filling the rest of the canvas). `resize()` re-runs the same
 * layout math against a fresh size; it must also stay a no-op while the screen isn't
 * showing, since Game.ts calls it unconditionally on every window resize regardless of
 * the current phase.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Screens } from './Screens';
import { setLocale, resetLocaleForTests } from '../../i18n';

function privateOf(s: Screens) {
  return s as unknown as {
    title: { position: { x: number; y: number }; text: string };
    sub: { position: { x: number; y: number } };
    hint: { position: { x: number; y: number } };
    menuBtn: { label: { text: string } };
  };
}

afterEach(() => resetLocaleForTests());

describe('Screens — show()', () => {
  it('centers its content on the given viewport size and becomes visible', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one'], 'press fire');
    const p = privateOf(s);
    expect(s.view.visible).toBe(true);
    expect(p.title.position.x).toBe(400); // w/2
    expect(p.title.position.y).toBe(180); // h/2 - 120
  });
});

describe('Screens — resize()', () => {
  it('re-centers content on a new viewport size while visible', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one'], 'press fire');
    s.resize(400, 300);
    const p = privateOf(s);
    expect(p.title.position.x).toBe(200); // new w/2
    expect(p.title.position.y).toBe(30); // new h/2 - 120
  });

  it('is a no-op before the screen has ever been shown', () => {
    const s = new Screens();
    const before = { ...privateOf(s).title.position };
    s.resize(1000, 1000);
    expect(s.view.visible).toBe(false);
    expect(privateOf(s).title.position).toEqual(before);
  });

  it('is a no-op after hide() — a resize while some other screen is up must not move this one', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one'], 'press fire');
    s.hide();
    const before = { ...privateOf(s).title.position };
    s.resize(200, 200);
    expect(s.view.visible).toBe(false);
    expect(privateOf(s).title.position).toEqual(before);
  });
});

describe('Screens — won flag (design/17-i18n.md)', () => {
  it('title/lines/hint are shown verbatim regardless of `won` — the caller supplies the copy', () => {
    const s = new Screens();
    s.show(800, 600, false, '战败', ['line one'], 'hint');
    expect(privateOf(s).title.text).toBe('战败');
  });
});

describe('Screens — i18n (design/17-i18n.md)', () => {
  it('retexts the MAIN MENU button on show() under zh', () => {
    const s = new Screens();
    setLocale('zh');
    s.show(800, 600, true, 'EXTRACTED', ['line one'], 'press fire');
    expect(privateOf(s).menuBtn.label.text).toBe('主菜单');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const s = new Screens();
    setLocale('zh');
    s.show(800, 600, true, 'EXTRACTED', ['line one'], 'press fire');
    setLocale('en');
    s.show(800, 600, true, 'EXTRACTED', ['line one'], 'press fire');
    expect(privateOf(s).menuBtn.label.text).toBe('MAIN MENU');
  });
});
