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
 *
 * `confirmBtn`/`menuBtn` are real Buttons (2026-08-17, see Screens.ts's own doc
 * comment for why tap-anywhere-on-the-panel was removed) — `emitTap` below drives
 * their real `pointertap` event, the same "Press is not activate" contract
 * widgets.test.ts covers for Button in general.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Screens } from './Screens';
import { setLocale, resetLocaleForTests } from '../../i18n';

function privateOf(s: Screens) {
  return s as unknown as {
    title: { position: { x: number; y: number }; text: string };
    sub: { position: { x: number; y: number } };
    confirmBtn: { view: { emit: (event: string) => void; position: { x: number; y: number } }; label: { text: string } };
    menuBtn: { view: { emit: (event: string) => void; position: { x: number; y: number } }; label: { text: string } };
  };
}

function emitTap(view: { emit: (event: string) => void }) {
  view.emit('pointertap');
}

afterEach(() => resetLocaleForTests());

describe('Screens — show()', () => {
  it('centers its content on the given viewport size and becomes visible', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    const p = privateOf(s);
    expect(s.view.visible).toBe(true);
    expect(p.title.position.x).toBe(400); // w/2
    expect(p.title.position.y).toBe(180); // h/2 - 120
  });
});

describe('Screens — resize()', () => {
  it('re-centers content on a new viewport size while visible', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    s.resize(400, 300);
    const p = privateOf(s);
    expect(p.title.position.x).toBe(200); // new w/2
    expect(p.title.position.y).toBe(30); // new h/2 - 120
  });

  it('re-centers confirmBtn/menuBtn on a new viewport size too, confirmBtn staying above menuBtn', () => {
    const s = new Screens();
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    s.resize(400, 300);
    const p = privateOf(s);
    // cx=200, cy=150 at the new size (Screens.ts's layout(): confirmBtn at cx-110,
    // cy+92; menuBtn at cx-75, cy+152) — a regression guard on the actual offsets,
    // not just "some position changed".
    expect(p.confirmBtn.view.position.x).toBe(90);
    expect(p.confirmBtn.view.position.y).toBe(242);
    expect(p.menuBtn.view.position.x).toBe(125);
    expect(p.menuBtn.view.position.y).toBe(302);
    expect(p.menuBtn.view.position.y).toBeGreaterThan(p.confirmBtn.view.position.y); // stays below
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
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    s.hide();
    const before = { ...privateOf(s).title.position };
    s.resize(200, 200);
    expect(s.view.visible).toBe(false);
    expect(privateOf(s).title.position).toEqual(before);
  });
});

describe('Screens — won flag (design/17-i18n.md)', () => {
  it('title/lines are shown verbatim regardless of `won` — the caller supplies the copy', () => {
    const s = new Screens();
    s.show(800, 600, false, '战败', ['line one']);
    expect(privateOf(s).title.text).toBe('战败');
  });
});

describe('Screens — confirm is a real button, not tap-anywhere (2026-08-17)', () => {
  it('a pointerdown anywhere on the panel does nothing — no full-panel handler left', () => {
    const s = new Screens();
    s.show(800, 600, false, 'DEFEAT', ['line one']);
    let confirmed = false;
    s.onConfirm = () => { confirmed = true; };
    emitTap(s.view as unknown as { emit: (event: string) => void }); // 'pointertap' on the root view itself
    (s.view as unknown as { emit: (event: string) => void }).emit('pointerdown');
    expect(confirmed).toBe(false);
  });

  it('tapping confirmBtn calls onConfirm exactly once per tap', () => {
    const s = new Screens();
    s.show(800, 600, false, 'DEFEAT', ['line one']);
    let calls = 0;
    s.onConfirm = () => { calls += 1; };
    emitTap(privateOf(s).confirmBtn.view);
    expect(calls).toBe(1);
  });

  it('tapping menuBtn calls onMenu, not onConfirm', () => {
    const s = new Screens();
    s.show(800, 600, false, 'DEFEAT', ['line one']);
    let confirmed = false;
    let wentToMenu = false;
    s.onConfirm = () => { confirmed = true; };
    s.onMenu = () => { wentToMenu = true; };
    emitTap(privateOf(s).menuBtn.view);
    expect(wentToMenu).toBe(true);
    expect(confirmed).toBe(false);
  });
});

describe('Screens — i18n (design/17-i18n.md)', () => {
  it('retexts CONFIRM and MAIN MENU on show() under zh', () => {
    const s = new Screens();
    setLocale('zh');
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    expect(privateOf(s).menuBtn.label.text).toBe('主菜单');
    expect(privateOf(s).confirmBtn.label.text).not.toBe('CONFIRM');
  });

  it('switching back to English on a later show() fully reverts', () => {
    const s = new Screens();
    setLocale('zh');
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    setLocale('en');
    s.show(800, 600, true, 'EXTRACTED', ['line one']);
    expect(privateOf(s).menuBtn.label.text).toBe('MAIN MENU');
    expect(privateOf(s).confirmBtn.label.text).toBe('CONFIRM');
  });
});
