import { CanvasTextMetrics, DOMAdapter } from 'pixi.js';
import type { ICanvasRenderingContext2D } from 'pixi.js';

/**
 * Pin Pixi's text-MEASUREMENT canvas to the same kind of canvas it PAINTS text on.
 *
 * Pixi v8 measures text on an `OffscreenCanvas` when one is available
 * (`CanvasTextMetrics._canvas`) but rasterises the glyphs on a DOM canvas obtained from
 * `DOMAdapter.get().createCanvas()` (`CanvasPool` → `CanvasTextGenerator`). Chrome does
 * NOT resolve the CSS generic font families (`monospace`, `sans-serif`, …) identically in
 * those two contexts: an OffscreenCanvas has no document/CSS context to read the user's
 * configured fixed-width font from, so it falls back to a different family. Measured live
 * on Windows Chrome 2026-08-15 with `bold 15px monospace`:
 *
 *   'ААААА' (Cyrillic)  DOM canvas 41.2px   OffscreenCanvas 85px
 *   'AAAAA' (Latin)     DOM canvas 41.2px   OffscreenCanvas 45px
 *
 * i.e. the two fonts happen to agree closely on Latin and disagree by ~2x on Cyrillic.
 * The result is a label whose `Text.width` is ~twice its painted width: `anchor 0.5`
 * centres the oversized measurement, so the glyphs land visibly LEFT of their button box
 * (reported for the Russian settings screen — "ЯЗЫК: Русский" sitting outside its button
 * background), and anything sized from Pixi's metrics is wrong by the same factor.
 *
 * Creating the measurement canvas through `DOMAdapter` — the exact call `CanvasPool` uses
 * for the paint canvas — makes measure and paint agree by construction, on every platform
 * (WeChat included, where the adapter is swapped for weapp-adapter's canvas).
 *
 * Must run before the first `Text` is constructed: the statics are lazily initialised on
 * first measurement and cached from then on.
 */
export function pinTextMeasurementToPaintCanvas(): void {
  let canvas;
  try {
    canvas = DOMAdapter.get().createCanvas();
  } catch {
    // No canvas on this host (or an adapter that cannot make one). Leave Pixi's own lazy path
    // alone — this is a measurement REFINEMENT, and it must never be the thing that fails boot.
    return;
  }
  canvas.width = canvas.height = 10;
  // `willReadFrequently` mirrors Pixi's own `contextSettings` for this canvas — font
  // metrics are derived from a `getImageData` readback.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return; // no 2D context (headless/no-canvas host) — leave Pixi's own path alone

  // `_canvas`/`_context` are getter-only; the backing statics they memoise into are the
  // documented-as-"should be private" `__canvas`/`__context` (pixi.js 8.19 CanvasTextMetrics).
  const metrics = CanvasTextMetrics as unknown as { __canvas?: unknown; __context?: unknown };
  metrics.__canvas = canvas;
  metrics.__context = withFiniteMetrics(context);
  // Drop any font metrics already cached from the previous (offscreen) canvas.
  CanvasTextMetrics.clearMetrics();
}

/** What the letter-spacing probe measures. Any string with a stable width does; three Latin
 *  capitals keep it independent of the font actually installed. */
const SPACING_PROBE = 'ABC';

/**
 * Turn off Pixi's experimental letter-spacing path on a host where touching it breaks the context.
 *
 * This is the root cause of the WeChat blank-text bug (2026-08-25), and it is one assignment.
 * Pixi feature-detects `context.letterSpacing` by looking for the property on the 2D context
 * PROTOTYPE, and the mini-game runtime carries it — so `experimentalLetterSpacingSupported` came
 * out true and Pixi set `context.letterSpacing = '0px'` before every measurement and every
 * `fillText`. On that runtime the assignment poisons the context: measured live in the simulator,
 * an identical draw painted 1058 pixels before the assignment and 0 after it, and `measureText`
 * went from 43.33 to a non-finite width. One property, both symptoms — the NaN width AND the
 * blank glyphs.
 *
 * Detected rather than keyed off "is this WeChat", because the invariant is checkable and exact:
 * setting a spacing of ZERO must not change what a measurement returns. A host that fails that is
 * broken by definition, whoever it is, and one that later fixes it silently gets the fast path
 * back. Turning the flag off costs nothing real — Pixi falls back to drawing letter-spaced text a
 * character at a time, which is what every browser did before the API existed.
 */
export function disableBrokenLetterSpacing(): void {
  let canvas;
  try {
    canvas = DOMAdapter.get().createCanvas();
  } catch {
    return; // no canvas here — nothing to probe, and Pixi's own path is unreachable anyway
  }
  canvas.width = canvas.height = 10;
  const context = canvas.getContext('2d') as (ICanvasRenderingContext2D & Record<string, unknown>) | null;
  if (!context) return;

  context.font = '20px sans-serif';
  const before = context.measureText(SPACING_PROBE).width;
  // An unmeasurable baseline means the probe can prove nothing; leave Pixi's own detection alone
  // rather than disable a path on no evidence.
  if (!Number.isFinite(before) || before <= 0) return;

  let assignmentFailed = false;
  try {
    context.letterSpacing = '0px';
    context.textLetterSpacing = '0px';
  } catch {
    // A getter-only property: Pixi's own assignment would throw here too, mid-render.
    assignmentFailed = true;
  }
  const after = context.measureText(SPACING_PROBE).width;
  const intact = !assignmentFailed && Number.isFinite(after) && Math.abs(after - before) < 0.5;
  if (intact) return;

  // Same "documented as should-be-private" backing static as `__canvas`/`__context` above; the
  // public getter memoises into it and has no setter.
  (CanvasTextMetrics as unknown as { _experimentalLetterSpacingSupported?: boolean })._experimentalLetterSpacingSupported = false;
}

/** The `TextMetrics` fields Pixi reads off a measurement. Anything not here is passed through
 *  untouched, so this list only has to cover what a NaN could actually poison. */
const METRIC_FIELDS = [
  'width',
  'actualBoundingBoxLeft',
  'actualBoundingBoxRight',
  'actualBoundingBoxAscent',
  'actualBoundingBoxDescent',
] as const;

/**
 * Wrap a 2D context so `measureText` can only ever return finite numbers.
 *
 * The bug this exists for (WeChat, 2026-08-25): every label in the mini-game rendered blank.
 * `Text.width` was `NaN`, so the glyph canvas was allocated 1px wide and the uploaded texture
 * held nothing — while the very same wx canvas painted 'ABC' perfectly when asked directly.
 *
 * The runtime's `TextMetrics` carries the `actualBoundingBox*` fields but leaves some of them
 * `NaN` rather than absent, and Pixi's width is
 *
 *     Math.max(metrics.width, (actualBoundingBoxRight ?? 0) - -(actualBoundingBoxLeft ?? 0))
 *
 * `??` catches a missing field but not a `NaN` one, and `Math.max(43.3, NaN)` is `NaN` — so one
 * unset bounding-box field silently zeroes every piece of text in the game. Sanitising here, on
 * the context Pixi measures with, fixes it for every caller at once and costs a browser nothing
 * (its values are already finite, so the copy is returned unchanged in substance).
 *
 * A `Proxy` rather than a hand-written stand-in: Pixi sets `font`/`letterSpacing` on this object
 * and reads them back, and a future version may touch more. Only `measureText` is intercepted;
 * everything else forwards to the real context, methods bound to it.
 */
function withFiniteMetrics(context: ICanvasRenderingContext2D): ICanvasRenderingContext2D {
  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'measureText') {
        return (text: string): TextMetrics => finite(target.measureText(text));
      }
      const value = Reflect.get(target, prop, target) as unknown;
      // Bound to `target`, not to the proxy: a native method invoked on a Proxy receiver throws
      // "illegal invocation" on some engines.
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
    set(target, prop, value) {
      Reflect.set(target, prop, value, target);
      return true;
    },
  }) as unknown as ICanvasRenderingContext2D;
}

/**
 * A copy of `m` with every metric field Pixi reads forced to a finite number.
 *
 * A PLAIN object, deliberately — not `Object.create(m)`. A real `TextMetrics` exposes its numbers
 * as getter-only accessors on its prototype, so an object inheriting from it rejects every write
 * ("Cannot set property width of [object TextMetrics] which has only a getter") and, since this
 * runs on the path every single label takes, takes the whole game down with it. The own-property
 * spread first is for a runtime whose metrics are a plain object with extra fields worth keeping.
 */
function finite(m: TextMetrics): TextMetrics {
  const source = m as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const field of METRIC_FIELDS) {
    const value = source[field];
    out[field] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
  return out as unknown as TextMetrics;
}
