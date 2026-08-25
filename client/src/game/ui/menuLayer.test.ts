/**
 * MenuLayer — the fit-scale that keeps every full-screen menu inside a viewport shorter
 * than the design space it is laid out in (the live WeChat landscape-phone bug, see
 * menuLayer.ts). Pure math plus one Container transform; no renderer needed.
 *
 * The per-screen "does it actually fit" oracle is screens/viewportFit.test.ts — this file
 * only pins the transform's own contract.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { MenuLayer, menuFitScale, MENU_DESIGN_W, MENU_DESIGN_H } from './menuLayer';

// The one viewport this exists for: wechat/game.json declares deviceOrientation
// "landscape", so an iPhone 12/13 mini-game viewport is 844x390 logical px.
const WECHAT_LANDSCAPE = { w: 844, h: 390 };

describe('menuFitScale', () => {
  it('never scales UP — a viewport at or above the design size is the identity', () => {
    expect(menuFitScale(MENU_DESIGN_W, MENU_DESIGN_H)).toBe(1);
    expect(menuFitScale(1920, 1080)).toBe(1);
    expect(menuFitScale(1280, 720)).toBe(1); // the common desktop case must be untouched
  });

  it('scales by whichever axis is tightest, not just height', () => {
    // Height-limited: half the design height, plenty of width.
    expect(menuFitScale(4000, MENU_DESIGN_H / 2)).toBeCloseTo(0.5, 6);
    // Width-limited: half the design width, plenty of height.
    expect(menuFitScale(MENU_DESIGN_W / 2, 4000)).toBeCloseTo(0.5, 6);
    // Both short — the SMALLER ratio wins (a max() here would still overflow one axis).
    expect(menuFitScale(MENU_DESIGN_W / 2, MENU_DESIGN_H / 4)).toBeCloseTo(0.25, 6);
  });

  it('shrinks the WeChat landscape phone viewport on its height', () => {
    const s = menuFitScale(WECHAT_LANDSCAPE.w, WECHAT_LANDSCAPE.h);
    expect(s).toBeCloseTo(WECHAT_LANDSCAPE.h / MENU_DESIGN_H, 6);
    expect(s).toBeLessThan(1);
  });

  it('leaves the layer alone on a degenerate viewport instead of dividing by zero', () => {
    expect(menuFitScale(0, 0)).toBe(1);
    expect(menuFitScale(844, 0)).toBe(1);
    expect(menuFitScale(Number.NaN, 390)).toBe(1);
  });
});

describe('MenuLayer.fit', () => {
  it('writes the scale onto the container and hands back the design-space size', () => {
    const layer = new MenuLayer();
    const design = layer.fit(WECHAT_LANDSCAPE);
    const s = menuFitScale(WECHAT_LANDSCAPE.w, WECHAT_LANDSCAPE.h);
    expect(layer.scale.x).toBeCloseTo(s, 6);
    expect(layer.scale.y).toBeCloseTo(s, 6);
    // The returned size is what a screen lays out against; scaled by `s` it must land
    // back exactly on the real viewport — this is the invariant that makes a screen's
    // bottom-anchored bar (`h - 60`) end up 60 real px off the real bottom edge.
    expect(design.w * s).toBeCloseTo(WECHAT_LANDSCAPE.w, 6);
    expect(design.h * s).toBeCloseTo(WECHAT_LANDSCAPE.h, 6);
    // Short viewport ⇒ design space is BIGGER than the real one, never smaller.
    expect(design.h).toBeGreaterThan(WECHAT_LANDSCAPE.h);
    expect(design.h).toBeCloseTo(MENU_DESIGN_H, 6);
  });

  it('is the identity on a desktop viewport — same numbers in, same numbers out', () => {
    const layer = new MenuLayer();
    expect(layer.fit({ w: 1280, h: 720 })).toEqual({ w: 1280, h: 720 });
    expect(layer.scale.x).toBe(1);
  });

  it('re-fitting replaces the previous scale rather than compounding it', () => {
    const layer = new MenuLayer();
    layer.fit(WECHAT_LANDSCAPE);
    layer.fit(WECHAT_LANDSCAPE);
    expect(layer.scale.x).toBeCloseTo(menuFitScale(844, 390), 6);
    layer.fit({ w: 1280, h: 720 });
    expect(layer.scale.x).toBe(1); // a resize back to a big window must undo the shrink
  });
});

describe('MenuLayer.mount', () => {
  // The rule this method exists to make un-loseable: a screen paints a full-viewport Panel
  // before its own widgets, so anything floating over "whichever screen is up" must be added
  // after ALL of them. The forge's SETTINGS button was not, and rendered under the hub
  // backdrop — invisible and untappable at every viewport, desktop included.
  it('puts every floating widget above every screen', () => {
    const layer = new MenuLayer();
    const screens = [new Container(), new Container(), new Container()];
    const floating = [new Container()];
    layer.mount(screens, floating);
    const lowestFloat = Math.min(...floating.map((f) => layer.children.indexOf(f)));
    const highestScreen = Math.max(...screens.map((s) => layer.children.indexOf(s)));
    expect(lowestFloat).toBeGreaterThan(highestScreen);
  });

  it('holds even when `floating` is listed before `screens` would naturally be added', () => {
    // The failure mode is an ARGUMENT-ORDER accident at the call site, so the ordering must
    // come from the parameter's meaning, not from when the caller happens to build each one.
    const layer = new MenuLayer();
    const float = new Container();
    const screen = new Container();
    layer.mount([screen], [float]);
    expect(layer.children).toEqual([screen, float]);
  });

  it('keeps every mounted child, in the given order within each group', () => {
    const layer = new MenuLayer();
    const a = new Container(), b = new Container(), c = new Container(), d = new Container();
    layer.mount([a, b], [c, d]);
    expect(layer.children).toEqual([a, b, c, d]);
  });

  it('accepts an empty floating list (nothing floats over a screen yet on some builds)', () => {
    const layer = new MenuLayer();
    const a = new Container();
    layer.mount([a], []);
    expect(layer.children).toEqual([a]);
  });
});
