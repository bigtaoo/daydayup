/**
 * Rasterising text on a WeChat-SHAPED host, end to end through Pixi's real generator.
 *
 * Why this file exists: on 2026-08-25 every label in the shipped mini-game was blank, and the
 * whole suite stayed green throughout. The cause was one property assignment — Pixi feature-detects
 * `context.letterSpacing` on the 2D context PROTOTYPE, that runtime carries it, and assigning it
 * poisons the context there (measured in the simulator: an identical draw painted 1058 pixels with
 * the assignment omitted and 0 with it included, and `measureText` went from 43.33px to a
 * non-finite width). Nothing in this repo modelled a host that behaves that way, so nothing could
 * catch it, and every step of the diagnosis had to be a probe inside a running mini-game.
 *
 * What this replaces that with: a 2D context faked to the behaviours actually MEASURED on that
 * runtime — the prototype carries `letterSpacing`, assigning it breaks measurement and drawing,
 * and `measureText` reports a real advance width with finite bounding boxes — and then the REAL
 * `CanvasTextGenerator.getCanvasAndContext()` run against it. Nothing about Pixi is stubbed: the
 * measurement, the wrapping, the canvas sizing and the draw calls are the shipped ones.
 *
 * What it therefore pins, none of which any other test covers:
 *   - the glyph draw actually HAPPENS, on a context boot never let anything poison;
 *   - the canvas it happens on is sized from a real measurement, not collapsed to 1px by a NaN;
 *   - Pixi's per-character letter-spacing fallback — the path the fix leaves this platform on —
 *     draws every character, spaced apart.
 *
 * What it cannot pin: that a real base library's canvas paints the glyphs it is told to paint.
 * That needs the simulator, and design/04's checklist still owns it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CanvasPool, CanvasTextGenerator, CanvasTextMetrics, DOMAdapter, TextStyle } from 'pixi.js';
import type { Adapter } from 'pixi.js';
import { disableBrokenLetterSpacing, pinTextMeasurementToPaintCanvas } from './textMetrics';

/** Per-character advance the fake reports. Only its stability matters, not the number. */
const ADVANCE = 8.25;
const FONT_SIZE = 20;

interface Draw {
  text: string;
  x: number;
  y: number;
  poisoned: boolean;
}

/**
 * A 2D context with the WeChat runtime's measured behaviour: writing `letterSpacing` breaks it,
 * after which measurement returns a non-finite width and a draw paints nothing. Every draw is
 * recorded WITH the poisoned flag as it stood at that moment, so a test can tell "drew" from
 * "drew onto a dead context" — which is exactly the distinction the blank labels turned on, and
 * the one that every call-count assertion in the world is blind to.
 */
function weChatContext() {
  let poisoned = false;
  const draws: Draw[] = [];
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    lineWidth: 0,
    miterLimit: 0,
    lineJoin: '',
    lineCap: '',
    canvas: { width: 0, height: 0 },
    get draws(): Draw[] {
      return draws;
    },
    get poisoned(): boolean {
      return poisoned;
    },
    measureText(text: string) {
      // Finite bounding boxes, as the runtime really reports them — the NaN came from the
      // poisoning, not from the fields themselves.
      return {
        width: poisoned ? NaN : text.length * ADVANCE,
        actualBoundingBoxLeft: poisoned ? NaN : 1,
        actualBoundingBoxRight: poisoned ? NaN : Math.max(0, text.length * ADVANCE - 1),
        actualBoundingBoxAscent: poisoned ? NaN : 15,
        actualBoundingBoxDescent: poisoned ? NaN : 5,
      };
    },
    fillText(text: string, x: number, y: number) {
      draws.push({ text, x, y, poisoned });
    },
    strokeText(text: string, x: number, y: number) {
      draws.push({ text, x, y, poisoned });
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    resetTransform: () => {},
    scale: () => {},
    clearRect: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    createPattern: () => null,
  };
  // On the PROTOTYPE, not the instance: Pixi's check is `'letterSpacing' in proto`, so an own
  // property would leave this fake on the healthy path and quietly prove nothing.
  const proto = Object.create(Object.getPrototypeOf(ctx) as object) as Record<string, unknown>;
  Object.defineProperty(proto, 'letterSpacing', {
    get: () => '0px',
    set: () => {
      poisoned = true;
    },
    configurable: true,
  });
  Object.setPrototypeOf(ctx, proto);
  return ctx;
}

type WeChatContext = ReturnType<typeof weChatContext>;

let browserAdapter: Adapter;
const savedGlobals = {
  document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  offscreen: Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'),
};

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete (globalThis as Record<string, unknown>)[name];
}

/** Pixi memoises the measurement canvas, the font metrics, the measurement cache AND the
 *  letter-spacing flag; a case that inherits any of them is not testing what it says it is. */
function resetPixiTextState(): void {
  const statics = CanvasTextMetrics as unknown as {
    __canvas?: unknown;
    __context?: unknown;
    _experimentalLetterSpacingSupported?: boolean;
    _measurementCache?: { clear: () => void };
  };
  statics.__canvas = undefined;
  statics.__context = undefined;
  statics._experimentalLetterSpacingSupported = undefined;
  statics._measurementCache?.clear();
  CanvasTextMetrics.clearMetrics();
  // `CanvasPool` is a module-global singleton and `getCanvasAndContext` hands its canvas back to
  // it, so two cases whose text rounds to the same power-of-two size share one fake context and
  // its recorded draws. Found the honest way: the stroke case counted 4 draws instead of 2.
  CanvasPool.clear();
}

beforeEach(() => {
  // The globals a mini-game does not have, removed rather than left unused — a stray
  // `document.createElement` has to fail here the way it fails there.
  defineGlobal('document', undefined);
  defineGlobal('OffscreenCanvas', undefined);
  browserAdapter = DOMAdapter.get();
  DOMAdapter.set({
    ...browserAdapter,
    createCanvas: (w = 0, h = 0) => {
      const context = weChatContext();
      context.canvas.width = w;
      context.canvas.height = h;
      return {
        get width() {
          return context.canvas.width;
        },
        set width(v: number) {
          context.canvas.width = v;
        },
        get height() {
          return context.canvas.height;
        },
        set height(v: number) {
          context.canvas.height = v;
        },
        getContext: () => context,
      } as unknown as HTMLCanvasElement;
    },
    // Pixi reads this prototype to feature-detect letter spacing; hand it one of ours.
    getCanvasRenderingContext2D: () =>
      ({ prototype: Object.getPrototypeOf(weChatContext()) }) as unknown as ReturnType<Adapter['getCanvasRenderingContext2D']>,
  });
  resetPixiTextState();
});

afterEach(() => {
  DOMAdapter.set(browserAdapter);
  restoreGlobal('document', savedGlobals.document);
  restoreGlobal('OffscreenCanvas', savedGlobals.offscreen);
  resetPixiTextState();
});

/** What `main.wechat.ts` does before the first label, in the same order. */
function bootTextSetup(): void {
  pinTextMeasurementToPaintCanvas();
  disableBrokenLetterSpacing();
}

/** Rasterise through Pixi's real generator and hand back the context it actually drew on. */
function rasterise(text: string, style: TextStyle) {
  const generator = CanvasTextGenerator as unknown as {
    getCanvasAndContext: (o: { text: string; style: TextStyle; resolution: number }) => {
      canvasAndContext: { canvas: { width: number; height: number }; context: WeChatContext };
      frame: { width: number; height: number };
    };
    returnCanvasAndContext: (c: unknown) => void;
  };
  const { canvasAndContext, frame } = generator.getCanvasAndContext({ text, style, resolution: 2 });
  const result = {
    context: canvasAndContext.context,
    canvas: { width: canvasAndContext.canvas.width, height: canvasAndContext.canvas.height },
    frame: { width: frame.width, height: frame.height },
  };
  generator.returnCanvasAndContext(canvasAndContext);
  return result;
}

const plain = (): TextStyle => new TextStyle({ fill: 0xffffff, fontSize: FONT_SIZE });

describe('text rasterisation on a WeChat-shaped host', () => {
  it('is on the poisoned path to begin with — the premise the rest of this file rests on', () => {
    // Without this, every assertion below could pass on a host that was never at risk. That is not
    // hypothetical: the first version of this fix's unit tests passed with the fix deleted, for
    // exactly that reason.
    expect(CanvasTextMetrics.experimentalLetterSpacingSupported).toBe(true);
  });

  it('draws the glyphs, on a context boot never let anything poison', () => {
    bootTextSetup();
    const { context } = rasterise('ABC', plain());
    const drawn = context.draws.filter((d) => d.text === 'ABC');
    expect(drawn).toHaveLength(1);
    // The whole bug in one assertion: the draw DID happen in the shipped build too — onto a dead
    // context, painting nothing, while every count and coordinate looked perfectly healthy.
    expect(drawn[0]!.poisoned).toBe(false);
    expect(context.poisoned).toBe(false);
  });

  it('sizes the glyph canvas from a real measurement, not the 1px a NaN collapses to', () => {
    // `nextPow2(NaN)` is 1, so the shipped symptom was a 1x64 texture holding nothing. Anything
    // that makes the width non-finite lands back here.
    bootTextSetup();
    const { canvas, frame } = rasterise('ABC', plain());
    expect(Number.isFinite(frame.width)).toBe(true);
    expect(frame.width).toBeGreaterThan(3 * ADVANCE); // the bare advance, before padding/resolution
    expect(canvas.width).toBeGreaterThan(1);
    expect(canvas.height).toBeGreaterThan(1);
  });

  it('draws every character when the style asks for letter spacing', () => {
    // Turning the flag off puts Pixi on its per-character fallback, which is now the only path
    // letter-spaced text has on this platform and was never exercised anywhere in this repo.
    bootTextSetup();
    const { context } = rasterise('ABC', new TextStyle({ fill: 0xffffff, fontSize: FONT_SIZE, letterSpacing: 4 }));
    const drawn = context.draws.filter((d) => d.text.length === 1);
    expect(drawn.map((d) => d.text)).toEqual(['A', 'B', 'C']);
    expect(drawn.every((d) => !d.poisoned)).toBe(true);
    // ...and spaced apart rather than stacked on one x — a fallback that drew all three at the
    // same position would satisfy every count above.
    expect(drawn[1]!.x).toBeGreaterThan(drawn[0]!.x);
    expect(drawn[2]!.x).toBeGreaterThan(drawn[1]!.x);
  });

  it('draws each line of a multi-line label, lower one lower', () => {
    bootTextSetup();
    const { context } = rasterise('AB\nCD', plain());
    const drawn = context.draws.filter((d) => d.text === 'AB' || d.text === 'CD');
    expect(drawn.map((d) => d.text)).toEqual(['AB', 'CD']);
    expect(drawn[1]!.y).toBeGreaterThan(drawn[0]!.y);
    expect(drawn.every((d) => !d.poisoned)).toBe(true);
  });

  it('draws a stroked label twice — stroke then fill — and neither on a poisoned context', () => {
    // The shipped UI strokes its labels (game/ui/widgets.ts), and the stroke pass sets more
    // context state before drawing than the fill pass does.
    bootTextSetup();
    const style = new TextStyle({ fill: 0xffffff, fontSize: FONT_SIZE, stroke: { color: 0x000000, width: 3 } });
    const { context } = rasterise('ABC', style);
    const drawn = context.draws.filter((d) => d.text === 'ABC');
    expect(drawn).toHaveLength(2);
    expect(drawn.every((d) => !d.poisoned)).toBe(true);
  });

  it('WITHOUT the boot repair, the same rasterisation draws onto a poisoned context', () => {
    // The counter-case, and the reason every assertion above earns its line: skip
    // `disableBrokenLetterSpacing()` and Pixi sets `letterSpacing` before the draw, exactly as the
    // shipped bundle did. The draw count is IDENTICAL — which is how this shipped.
    pinTextMeasurementToPaintCanvas();
    const { context } = rasterise('ABC', plain());
    const drawn = context.draws.filter((d) => d.text === 'ABC');
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.poisoned).toBe(true);
  });
});
