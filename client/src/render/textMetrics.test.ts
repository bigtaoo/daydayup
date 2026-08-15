/**
 * `pinTextMeasurementToPaintCanvas` guards a defect that is invisible to every other test
 * in this repo: Pixi MEASURES text on an `OffscreenCanvas` but PAINTS it on a DOM canvas,
 * and Chrome resolves the CSS generic font families differently between the two, so
 * `Text.width` can come back ~2x the painted width (see textMetrics.ts).
 *
 * Neither canvas kind exists in this Node-only test env, so both are faked — and faked
 * with the ACTUAL advance widths measured in Chrome/Windows on 2026-08-15 for
 * `bold 15px monospace`, which is what makes the second describe block a real regression
 * test rather than a tautology: the "offscreen" fake is ~2x wider for Cyrillic and the
 * "DOM" fake is not, exactly the discrepancy the user's Russian settings screen hit.
 * `document.createElement` is stubbed because that is what Pixi's `BrowserAdapter`
 * (`DOMAdapter.get().createCanvas()`) calls, and `CanvasRenderingContext2D` because
 * Pixi probes its prototype for letter-spacing support on the first measurement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// `?raw` (see src/vite-env.d.ts): the entries' TEXT, since importing them runs `boot()`.
import webEntrySource from '../main.ts?raw';
import wechatEntrySource from '../main.wechat.ts?raw';
import { CanvasTextMetrics, DOMAdapter, TextStyle, Text } from 'pixi.js';
import { Button } from '../game/ui/widgets';
import { Settings } from '../game/screens/Settings';
import { defaultSettingsState } from '../settings';
import { LOCALES, setLocale, resetLocaleForTests } from '../i18n';
import { pinTextMeasurementToPaintCanvas } from './textMetrics';

// Per-character advance at 15px, as Chrome reported for `bold 15px monospace`:
// 'AAAAA' → 41.2px / 'ААААА' → 41.2px on a DOM canvas, 45px / 85px on an OffscreenCanvas.
const DOM_ADVANCE = { latin: 8.25, cyrillic: 8.25 };
const OFFSCREEN_ADVANCE = { latin: 9, cyrillic: 17 };

const FONT_SIZE = 15;
const RU_LABEL = 'ЯЗЫК: Русский'; // the reported string, Settings.ts's language button
const EN_LABEL = 'LANGUAGE: English';

type Advance = { latin: number; cyrillic: number };
type FakeContext = ReturnType<typeof fakeContext>;

function isCyrillic(cp: number): boolean {
  return cp >= 0x0400 && cp <= 0x04ff;
}

/** A 2D context stub that measures with a per-script fixed advance and paints nothing.
 * `getImageData` returns a blank buffer — Pixi derives ascent/descent from a readback of
 * it, which leaves the reported height at 0; every assertion here is about width. */
function fakeContext(advance: Advance) {
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    textBaseline: '',
    lineWidth: 0,
    letterSpacing: '',
    canvas: { width: 10, height: 10 },
    getContextCalls: [] as unknown[][],
    measureText(text: string) {
      let w = 0;
      for (const ch of text) w += isCyrillic(ch.codePointAt(0) ?? 0) ? advance.cyrillic : advance.latin;
      return { width: w };
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    fillText: () => {},
    strokeText: () => {},
    clearRect: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
  };
  return ctx;
}

/** A canvas stub whose `getContext` hands back `context` (or null, to model a host with
 * no 2D support) and records the args Pixi asked for. */
function fakeCanvas(context: FakeContext | null) {
  const calls: unknown[][] = [];
  return {
    canvas: {
      width: 0,
      height: 0,
      getContext: (...args: unknown[]) => {
        calls.push(args);
        return context;
      },
    },
    calls,
  };
}

type Statics = { __canvas?: unknown; __context?: unknown };
const statics = CanvasTextMetrics as unknown as Statics;

const saved = {
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  offscreen: Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'),
  ctx2d: Object.getOwnPropertyDescriptor(globalThis, 'CanvasRenderingContext2D'),
};

function defineGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

/** Pixi memoises the measurement canvas on first use; each test must start from scratch. */
function resetPixiTextMetrics() {
  statics.__canvas = undefined;
  statics.__context = undefined;
  CanvasTextMetrics.clearMetrics();
}

// Pixi reads `CanvasRenderingContext2D.prototype` to feature-detect letter spacing.
defineGlobal('CanvasRenderingContext2D', class {});

// Both canvas kinds, installed for every test, so an unpinned Pixi picks the offscreen
// one exactly as it does in a browser — that is what makes "pinned" vs "not pinned" a
// real difference here rather than two names for the same fake.
beforeEach(() => {
  defineGlobal('OffscreenCanvas', class {
    getContext() {
      return fakeContext(OFFSCREEN_ADVANCE);
    }
  });
  defineGlobal('document', { createElement: () => fakeCanvas(fakeContext(DOM_ADVANCE)).canvas });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPixiTextMetrics();
  restoreGlobal('document', saved.document);
  restoreGlobal('OffscreenCanvas', saved.offscreen);
});

describe('pinTextMeasurementToPaintCanvas', () => {
  it('pins Pixi’s measurement canvas/context to a DOMAdapter-created canvas', () => {
    const context = fakeContext(DOM_ADVANCE);
    const { canvas, calls } = fakeCanvas(context);
    defineGlobal('document', { createElement: () => canvas });

    pinTextMeasurementToPaintCanvas();

    expect(statics.__canvas).toBe(canvas);
    expect(statics.__context).toBe(context);
    // Pixi's own contextSettings for this canvas — font metrics come from a readback.
    expect(calls).toEqual([['2d', { willReadFrequently: true }]]);
  });

  it('actually routes Pixi’s own measurement through the pinned context', () => {
    // The assertion that keeps this fix honest: it fails if a Pixi upgrade renames the
    // `__canvas`/`__context` statics, instead of silently reverting to the offscreen path
    // (which is installed here too, and would report 17px/char for Cyrillic).
    pinTextMeasurementToPaintCanvas();

    const style = new TextStyle({ fontSize: FONT_SIZE, fontFamily: 'monospace', fontWeight: 'bold' });
    expect(CanvasTextMetrics.measureText('ААААА', style).width).toBeCloseTo(5 * DOM_ADVANCE.cyrillic, 3);
  });

  it('creates the canvas through DOMAdapter, so a swapped adapter (WeChat) is honored', () => {
    // main.wechat.ts calls this too, where DOMAdapter is weapp-adapter's, not the browser's.
    const context = fakeContext(DOM_ADVANCE);
    const { canvas } = fakeCanvas(context);
    const browserAdapter = DOMAdapter.get();
    DOMAdapter.set({ ...browserAdapter, createCanvas: () => canvas as unknown as HTMLCanvasElement });
    try {
      pinTextMeasurementToPaintCanvas();
      expect(statics.__canvas).toBe(canvas);
    } finally {
      DOMAdapter.set(browserAdapter);
    }
  });

  it('replaces an offscreen canvas Pixi already memoised, rather than deferring to it', () => {
    // Models being called after something already measured — the pinned context must win.
    const stale = fakeContext(OFFSCREEN_ADVANCE);
    statics.__canvas = stale.canvas;
    statics.__context = stale;

    pinTextMeasurementToPaintCanvas();

    const style = new TextStyle({ fontSize: FONT_SIZE, fontFamily: 'monospace', fontWeight: 'bold' });
    expect(CanvasTextMetrics.measureText('ААААА', style).width).toBeCloseTo(5 * DOM_ADVANCE.cyrillic, 3);
  });

  it('drops font metrics cached from the previous canvas', () => {
    const spy = vi.spyOn(CanvasTextMetrics, 'clearMetrics');

    pinTextMeasurementToPaintCanvas();

    expect(spy).toHaveBeenCalled();
  });

  it('is safe to call twice — the last pinned context is the one Pixi measures with', () => {
    const first = fakeContext(OFFSCREEN_ADVANCE);
    const second = fakeContext(DOM_ADVANCE);
    const contexts = [first, second];
    defineGlobal('document', { createElement: () => fakeCanvas(contexts.shift() ?? second).canvas });

    pinTextMeasurementToPaintCanvas();
    pinTextMeasurementToPaintCanvas();

    expect(statics.__context).toBe(second);
  });

  it('leaves Pixi’s own lazy path alone when there is no 2D context', () => {
    defineGlobal('document', { createElement: () => fakeCanvas(null).canvas });

    pinTextMeasurementToPaintCanvas();

    expect(statics.__canvas).toBeUndefined();
    expect(statics.__context).toBeUndefined();
  });
});

// End-to-end on the widget that actually broke: a settings Button whose label is a
// translated string. `Button` sizes its box from `estimateMonoWidth` (no canvas needed)
// but centres the label via Pixi's `anchor 0.5`, i.e. from Pixi's MEASURED width — so a
// measurement that disagrees with the paint canvas pushes the glyphs outside the box.
describe('Button label vs. box — the Russian settings-screen regression', () => {
  /** Left/right edges of the label as Pixi will place them inside the box. */
  function labelEdges(button: Button) {
    const label = button.view.children[1] as Text;
    return { left: label.position.x - label.width / 2, right: label.position.x + label.width / 2 };
  }

  /** Both canvas kinds are already installed (see `beforeEach`); `pin` is the fix itself. */
  function buildButton(text: string, opts: { pin: boolean }) {
    if (opts.pin) pinTextMeasurementToPaintCanvas();
    return new Button(text, { w: 160, h: 34, autoWidth: true });
  }

  it('WITHOUT the fix, a Cyrillic label is measured wide enough to spill out of its box', () => {
    // The reported bug: text rendered visibly left of (and outside) the button background.
    const button = buildButton(RU_LABEL, { pin: false });
    const { left, right } = labelEdges(button);
    expect(left).toBeLessThan(0);
    expect(right).toBeGreaterThan(button.width);
  });

  it('WITH the fix, the same label sits inside the box and is centred on it', () => {
    const button = buildButton(RU_LABEL, { pin: true });
    const { left, right } = labelEdges(button);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(button.width);
    expect(left).toBeCloseTo(button.width - right, 3);
  });

  it('every locale’s real settings labels fit inside their boxes under truthful metrics', () => {
    // Settings.test.ts already covers each BOX's width and where it sits; what it cannot
    // check without a canvas is the LABEL inside it. Sizing comes from
    // `estimateMonoWidth`'s 0.6em assumption while the font's real advance is 0.55em, so
    // this also catches a future translation long enough to close that headroom.
    pinTextMeasurementToPaintCanvas();

    const screen = new Settings();
    const buttons = screen as unknown as Record<string, Button>;
    for (const locale of LOCALES) {
      setLocale(locale);
      screen.show(800, 600, { ...defaultSettingsState(), locale });
      for (const key of ['languageBtn', 'controlLayoutBtn', 'muteBtn', 'backBtn']) {
        const button = buttons[key]!;
        const { left, right } = labelEdges(button);
        expect({ locale, key, left: left >= 0 }).toEqual({ locale, key, left: true });
        expect({ locale, key, right: right <= button.width }).toEqual({ locale, key, right: true });
      }
    }
    resetLocaleForTests();
  });

  it('is wired into both entry points, ahead of the first Text', () => {
    // Neither entry has (or can easily have) a test of its own — importing one runs
    // `boot()`. A source check is the cheap way to keep the call from being dropped:
    // everything above still passes if `main.ts` simply stops calling it.
    for (const [entry, source] of [['main.ts', webEntrySource], ['main.wechat.ts', wechatEntrySource]] as const) {
      const call = source.indexOf('pinTextMeasurementToPaintCanvas()');
      expect({ entry, called: call >= 0 }).toEqual({ entry, called: true });
      // Pixi memoises the measurement canvas on first use, so this has to come first.
      expect({ entry, beforeGame: call < source.indexOf('new Game(') }).toEqual({ entry, beforeGame: true });
    }
  });

  it('a Latin label fits either way — why the Italian/English screens looked fine', () => {
    // The two fonts differ by ~9% on Latin and ~106% on Cyrillic, so only Cyrillic
    // overflowed; this pins down that the fix did not just move the failure elsewhere.
    for (const pin of [false, true]) {
      const button = buildButton(EN_LABEL, { pin });
      const { left, right } = labelEdges(button);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(button.width);
      resetPixiTextMetrics();
    }
  });
});
