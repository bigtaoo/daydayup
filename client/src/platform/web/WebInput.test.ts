/**
 * WebInput — the desktop keyboard+mouse InputSource, also hosting the shared
 * TouchControls for mobile/Capacitor browsers (design/04). No real DOM here (plain-node
 * vitest, no jsdom, per daydayup-testing-conventions memory) — `window`/the canvas are
 * hand-rolled fakes that capture registered listeners so a test can fire them directly,
 * the same `vi.stubGlobal('window', {...})` pattern already used for other browser-only
 * files in this repo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebInput } from './WebInput';
import type { InputCanvas } from '../types';

type Handler = (e: unknown) => void;

function fakeEventTarget() {
  const listeners: Record<string, Handler[]> = {};
  return {
    addEventListener(type: string, fn: Handler) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener() {},
    fire(type: string, e: unknown = {}) {
      for (const fn of listeners[type] ?? []) fn(e);
    },
  };
}

function fakeCanvas(width = 800, height = 600) {
  return {
    ...fakeEventTarget(),
    width,
    height,
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.width, height: this.height };
    },
  };
}

let win: ReturnType<typeof fakeEventTarget>;
let canvas: ReturnType<typeof fakeCanvas>;
let input: WebInput;

beforeEach(() => {
  win = fakeEventTarget();
  vi.stubGlobal('window', win);
  canvas = fakeCanvas();
  input = new WebInput();
  input.attach(canvas as unknown as InputCanvas);
});

describe('WebInput — keyboard movement', () => {
  it('is idle with no keys held', () => {
    const inp = input.read();
    expect(inp.moveX).toBe(0);
    expect(inp.moveY).toBe(0);
    expect(inp.firing).toBe(false);
  });

  it('WASD/arrow keys drive a normalized move vector', () => {
    win.fire('keydown', { code: 'KeyW' });
    expect(input.read().moveY).toBeCloseTo(-1);
    win.fire('keyup', { code: 'KeyW' });

    win.fire('keydown', { code: 'ArrowDown' });
    expect(input.read().moveY).toBeCloseTo(1);
  });

  it('diagonal movement is normalized (not faster than a cardinal direction)', () => {
    win.fire('keydown', { code: 'KeyW' });
    win.fire('keydown', { code: 'KeyD' });
    const inp = input.read();
    expect(Math.hypot(inp.moveX, inp.moveY)).toBeCloseTo(1);
    expect(inp.moveX).toBeGreaterThan(0);
    expect(inp.moveY).toBeLessThan(0);
  });

  it('releasing a key stops driving that axis', () => {
    win.fire('keydown', { code: 'KeyA' });
    expect(input.read().moveX).toBeCloseTo(-1);
    win.fire('keyup', { code: 'KeyA' });
    expect(input.read().moveX).toBe(0);
  });

  it('E or Space held maps to interacting', () => {
    expect(input.read().interacting).toBe(false);
    win.fire('keydown', { code: 'KeyE' });
    expect(input.read().interacting).toBe(true);
    win.fire('keyup', { code: 'KeyE' });
    win.fire('keydown', { code: 'Space' });
    expect(input.read().interacting).toBe(true);
  });
});

describe('WebInput — weapon-swap keys (edge-detected)', () => {
  it('Digit1/Digit2 fire onSwitchWeapon once per fresh press, not while held', () => {
    const switched: number[] = [];
    input.onSwitchWeapon = (slot) => switched.push(slot);

    win.fire('keydown', { code: 'Digit1' });
    win.fire('keydown', { code: 'Digit1' }); // held/repeat — must not re-fire
    expect(switched).toEqual([1]);

    win.fire('keyup', { code: 'Digit1' });
    win.fire('keydown', { code: 'Digit1' }); // fresh press again
    expect(switched).toEqual([1, 1]);

    win.fire('keydown', { code: 'Digit2' });
    expect(switched).toEqual([1, 1, 2]);
  });
});

describe('WebInput — mouse fire', () => {
  it('left mousedown on the canvas fires; mouseup on the window releases it', () => {
    expect(input.read().firing).toBe(false);
    canvas.fire('mousedown', { button: 0 });
    expect(input.read().firing).toBe(true);
    win.fire('mouseup', { button: 0 });
    expect(input.read().firing).toBe(false);
  });

  it('ignores non-left mouse buttons', () => {
    canvas.fire('mousedown', { button: 2 }); // right-click
    expect(input.read().firing).toBe(false);
  });
});

describe('WebInput — touch overrides keyboard/mouse while active', () => {
  it('a touch on the canvas takes over read(), even with keys/mouse also active', () => {
    win.fire('keydown', { code: 'KeyD' });
    canvas.fire('mousedown', { button: 0 });
    expect(input.read().moveX).toBeGreaterThan(0); // keyboard driving, pre-touch

    canvas.fire('touchstart', {
      preventDefault() {},
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    });
    const inp = input.read();
    // Touch state now wins — a move stick opened at (100,100) reports zero deflection
    // until dragged, not the keyboard's moveX.
    expect(inp.moveX).toBe(0);
    expect(inp.moveY).toBe(0);
  });

  it('touchmove/touchend drive the underlying TouchControls, reflected in getTouchVisual()', () => {
    canvas.fire('touchstart', {
      preventDefault() {},
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 100 }],
    });
    canvas.fire('touchmove', {
      preventDefault() {},
      changedTouches: [{ identifier: 1, clientX: 150, clientY: 100 }],
    });
    expect(input.getTouchVisual().move).toEqual({ ox: 100, oy: 100, dx: 50, dy: 0 });

    canvas.fire('touchend', {
      preventDefault() {},
      changedTouches: [{ identifier: 1, clientX: 150, clientY: 100 }],
    });
    expect(input.getTouchVisual().move).toBeNull();
  });
});

describe('WebInput — layout', () => {
  it('lays out TouchControls against the canvas size immediately on attach', () => {
    // weapon1 sits near the top-right corner for an 800x600 canvas (standard layout) —
    // if layout() were never called at attach time this would still be {cx:0,cy:0,r:0}.
    const v = input.getTouchVisual();
    expect(v.weapon1.cx).toBeGreaterThan(400);
    expect(v.weapon1.r).toBeGreaterThan(0);
  });

  it('re-lays out on window resize using the canvas size at that moment', () => {
    const before = input.getTouchVisual().weapon1.cx;
    canvas.width = 400;
    canvas.height = 300;
    win.fire('resize');
    expect(input.getTouchVisual().weapon1.cx).not.toBe(before);
  });
});

describe('WebInput — setControlMirror', () => {
  it('delegates to the underlying TouchControls, swapping the weapon-button corner', () => {
    const before = input.getTouchVisual().weapon1.cx;
    input.setControlMirror(true);
    expect(input.getTouchVisual().weapon1.cx).toBeLessThan(before);
  });
});
