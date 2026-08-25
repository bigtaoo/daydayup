/**
 * WeChatInput — the WeChat mini-game touch InputSource, a thin wrapper over the shared
 * `TouchControls` (design/04) that feeds `wx.onTouchStart/Move/End/Cancel` events into
 * it instead of DOM touch events — mirrors `WebInput.test.ts`'s own pattern (plain-node
 * vitest, no jsdom; a hand-rolled fake global that captures registered callbacks so a
 * test can fire them directly), just for the `wx` global instead of `window`/a canvas.
 * The bridge-dispatch describe block covers the OTHER half (2026-08-25): feeding Pixi's
 * own interaction system via an injected `WeChatEventBridge` — see weChatDomEvents.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Application } from 'pixi.js';
import { WeChatInput } from './WeChatInput';
import type { WeChatEventBridge, WeChatSyntheticPointerType } from './weChatDomEvents';

type WxHandler = (e: WxTouchEvent) => void;

function fakeWx() {
  const handlers: Record<string, WxHandler[]> = {};
  return {
    onTouchStart(fn: WxHandler) {
      (handlers.touchstart ??= []).push(fn);
    },
    onTouchMove(fn: WxHandler) {
      (handlers.touchmove ??= []).push(fn);
    },
    onTouchEnd(fn: WxHandler) {
      (handlers.touchend ??= []).push(fn);
    },
    onTouchCancel(fn: WxHandler) {
      (handlers.touchcancel ??= []).push(fn);
    },
    fire(type: string, e: WxTouchEvent) {
      for (const fn of handlers[type] ?? []) fn(e);
    },
  };
}

function touch(id: number, x: number, y: number): WxTouch {
  return { identifier: id, clientX: x, clientY: y };
}

let wxFake: ReturnType<typeof fakeWx>;
let input: WeChatInput;

beforeEach(() => {
  wxFake = fakeWx();
  vi.stubGlobal('wx', wxFake);
  const app = { screen: { width: 800, height: 600 } } as unknown as Application;
  input = new WeChatInput(app);
  input.attach();
});

describe('WeChatInput — layout', () => {
  it('lays out TouchControls against app.screen immediately on attach', () => {
    // Same corner-cluster math WebInput.test.ts's own layout test pins down for an
    // 800x600 screen, standard (non-mirrored) layout — if layout() were never called
    // at attach time this would still be {cx:0,cy:0,r:0}.
    const v = input.getTouchVisual();
    expect(v.weapon1.cx).toBeGreaterThan(400);
    expect(v.weapon1.r).toBeGreaterThan(0);
  });
});

describe('WeChatInput — idle', () => {
  it('is idle with no touches', () => {
    const inp = input.read();
    expect(inp.moveX).toBe(0);
    expect(inp.moveY).toBe(0);
    expect(inp.firing).toBe(false);
    expect(inp.interacting).toBe(false);
  });
});

describe('WeChatInput — movement stick', () => {
  it('touchstart on the left half opens a move stick; touchmove drags it; reflected in read()/getTouchVisual()', () => {
    wxFake.fire('touchstart', { touches: [], changedTouches: [touch(1, 100, 100)] });
    wxFake.fire('touchmove', { touches: [], changedTouches: [touch(1, 150, 100)] });

    const inp = input.read();
    expect(inp.moveX).toBeGreaterThan(0);
    expect(inp.moveY).toBe(0);
    expect(input.getTouchVisual().move).toEqual({ ox: 100, oy: 100, dx: 50, dy: 0 });
  });

  it('touchend closes the stick', () => {
    wxFake.fire('touchstart', { touches: [], changedTouches: [touch(1, 100, 100)] });
    wxFake.fire('touchend', { touches: [], changedTouches: [touch(1, 100, 100)] });
    expect(input.getTouchVisual().move).toBeNull();
    expect(input.read().moveX).toBe(0);
  });

  it('touchcancel ALSO closes the stick — same `end` handler as touchend', () => {
    wxFake.fire('touchstart', { touches: [], changedTouches: [touch(1, 100, 100)] });
    wxFake.fire('touchcancel', { touches: [], changedTouches: [touch(1, 100, 100)] });
    expect(input.getTouchVisual().move).toBeNull();
  });
});

describe('WeChatInput — fire (right half hold)', () => {
  it('touchstart on the right half fires; touchend releases it', () => {
    expect(input.read().firing).toBe(false);
    wxFake.fire('touchstart', { touches: [], changedTouches: [touch(2, 700, 300)] });
    expect(input.read().firing).toBe(true);
    wxFake.fire('touchend', { touches: [], changedTouches: [touch(2, 700, 300)] });
    expect(input.read().firing).toBe(false);
  });
});

describe('WeChatInput — INTERACT button (hold)', () => {
  it('a touch on the on-screen INTERACT button sets interacting=true; releasing clears it', () => {
    // Interact button center for an 800x600 screen, standard layout: unit=600, r=48,
    // m=72, gap=115.2 → interact cx=497.6, cy=72 (WebInput.test.ts's own pinned math —
    // shared TouchControls geometry, identical here).
    expect(input.read().interacting).toBe(false);
    wxFake.fire('touchstart', { touches: [], changedTouches: [touch(5, 497.6, 72)] });
    expect(input.read().interacting).toBe(true);
    expect(input.getTouchVisual().interact.pressed).toBe(true);

    wxFake.fire('touchend', { touches: [], changedTouches: [touch(5, 497.6, 72)] });
    expect(input.read().interacting).toBe(false);
    expect(input.getTouchVisual().interact.pressed).toBe(false);
  });
});

describe('WeChatInput — weapon-switch buttons', () => {
  it('a touch on weapon1/weapon2 fires onSwitchWeapon with the right slot, via the onSwitchWeapon getter/setter proxy', () => {
    const switched: number[] = [];
    input.onSwitchWeapon = (slot) => switched.push(slot);
    expect(input.onSwitchWeapon).toBeTypeOf('function');

    const { weapon1, weapon2 } = input.getTouchVisual();
    wxFake.fire('touchstart', { touches: [], changedTouches: [touch(1, weapon1.cx, weapon1.cy)] });
    expect(switched).toEqual([1]);
    wxFake.fire('touchstart', { touches: [], changedTouches: [touch(2, weapon2.cx, weapon2.cy)] });
    expect(switched).toEqual([1, 2]);
  });
});

describe('WeChatInput — multiple simultaneous touches in one event', () => {
  it('iterates every entry in changedTouches, not just the first', () => {
    // One touchstart batch carrying two fingers at once (left half + right half) —
    // both must register, proving the `for (const t of e.changedTouches)` loop in
    // attach() isn't accidentally only reading touches[0].
    wxFake.fire('touchstart', {
      touches: [],
      changedTouches: [touch(1, 100, 100), touch(2, 700, 300)],
    });
    const inp = input.read();
    expect(inp.moveX).toBe(0); // stick just opened, no drag yet, but it IS open
    expect(input.getTouchVisual().move).not.toBeNull();
    expect(inp.firing).toBe(true);
  });
});

describe('WeChatInput — setControlMirror', () => {
  it('delegates to the underlying TouchControls, swapping the weapon-button corner', () => {
    const before = input.getTouchVisual().weapon1.cx;
    input.setControlMirror(true);
    expect(input.getTouchVisual().weapon1.cx).toBeLessThan(before);
  });
});

describe('WeChatInput — event bridge (feeds Pixi Button/Slider, see weChatDomEvents.ts)', () => {
  // Each test here stubs its OWN fresh `wx` fake rather than reusing the outer
  // `beforeEach`'s `input`/`wxFake` — that pair stays alive with its own (bridge-less)
  // WeChatInput attached to the SAME global, and double-attaching a second InputSource
  // to it would register two independent handler sets on one fake with no benefit.
  function setUp(bridge?: WeChatEventBridge) {
    const wxLocal = fakeWx();
    vi.stubGlobal('wx', wxLocal);
    const app = { screen: { width: 800, height: 600 } } as unknown as Application;
    const local = new WeChatInput(app, bridge);
    local.attach();
    return { wxLocal, local };
  }

  function fakeBridge() {
    const calls: { type: WeChatSyntheticPointerType; x: number; y: number }[] = [];
    const bridge: WeChatEventBridge = {
      dispatch: (type, x, y) => { calls.push({ type, x, y }); },
    };
    return { bridge, calls };
  }

  it('a plain construction with no bridge (existing call sites/tests) never throws', () => {
    // No `bridge` arg at all — the default-parameter path every OTHER describe block
    // in this file already exercises implicitly; asserted explicitly here once so a
    // future signature change can't silently drop the default.
    const { wxLocal } = setUp();
    expect(() => wxLocal.fire('touchstart', { touches: [], changedTouches: [touch(1, 100, 100)] })).not.toThrow();
  });

  it('the first touch to start dispatches mousedown at its coordinates', () => {
    const { bridge, calls } = fakeBridge();
    const { wxLocal } = setUp(bridge);

    wxLocal.fire('touchstart', { touches: [], changedTouches: [touch(1, 123, 45)] });

    expect(calls).toEqual([{ type: 'mousedown', x: 123, y: 45 }]);
  });

  it('move/up for that SAME touch id dispatch mousemove/mouseup; up clears the owner', () => {
    const { bridge, calls } = fakeBridge();
    const { wxLocal } = setUp(bridge);

    wxLocal.fire('touchstart', { touches: [], changedTouches: [touch(1, 100, 100)] });
    wxLocal.fire('touchmove', { touches: [], changedTouches: [touch(1, 150, 120)] });
    wxLocal.fire('touchend', { touches: [], changedTouches: [touch(1, 150, 120)] });

    expect(calls).toEqual([
      { type: 'mousedown', x: 100, y: 100 },
      { type: 'mousemove', x: 150, y: 120 },
      { type: 'mouseup', x: 150, y: 120 },
    ]);
  });

  it('a SECOND simultaneous touch (e.g. the fire button held while dragging the move stick) does not also drive the bridge', () => {
    const { bridge, calls } = fakeBridge();
    const { wxLocal } = setUp(bridge);

    wxLocal.fire('touchstart', { touches: [], changedTouches: [touch(1, 100, 100)] });
    wxLocal.fire('touchstart', { touches: [], changedTouches: [touch(2, 700, 300)] });
    wxLocal.fire('touchmove', { touches: [], changedTouches: [touch(2, 720, 320)] });

    // Only touch 1 (the FIRST to start) ever reaches the bridge — touch 2's start/move
    // must not appear, even though both reach TouchControls (proven by the existing
    // "multiple simultaneous touches" describe block above).
    expect(calls).toEqual([{ type: 'mousedown', x: 100, y: 100 }]);
  });

  it('after the owning touch ends, the NEXT touch to start becomes the new owner', () => {
    const { bridge, calls } = fakeBridge();
    const { wxLocal } = setUp(bridge);

    wxLocal.fire('touchstart', { touches: [], changedTouches: [touch(1, 10, 10)] });
    wxLocal.fire('touchend', { touches: [], changedTouches: [touch(1, 10, 10)] });
    wxLocal.fire('touchstart', { touches: [], changedTouches: [touch(2, 20, 20)] });

    expect(calls).toEqual([
      { type: 'mousedown', x: 10, y: 10 },
      { type: 'mouseup', x: 10, y: 10 },
      { type: 'mousedown', x: 20, y: 20 },
    ]);
  });

  it('touchcancel on the owning touch also dispatches mouseup and clears the owner (same `end` handler as touchend)', () => {
    const { bridge, calls } = fakeBridge();
    const { wxLocal } = setUp(bridge);

    wxLocal.fire('touchstart', { touches: [], changedTouches: [touch(1, 5, 5)] });
    wxLocal.fire('touchcancel', { touches: [], changedTouches: [touch(1, 5, 5)] });

    expect(calls).toEqual([
      { type: 'mousedown', x: 5, y: 5 },
      { type: 'mouseup', x: 5, y: 5 },
    ]);
  });
});
