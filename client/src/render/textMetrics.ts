import { CanvasTextMetrics, DOMAdapter } from 'pixi.js';

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
  const canvas = DOMAdapter.get().createCanvas();
  canvas.width = canvas.height = 10;
  // `willReadFrequently` mirrors Pixi's own `contextSettings` for this canvas — font
  // metrics are derived from a `getImageData` readback.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return; // no 2D context (headless/no-canvas host) — leave Pixi's own path alone

  // `_canvas`/`_context` are getter-only; the backing statics they memoise into are the
  // documented-as-"should be private" `__canvas`/`__context` (pixi.js 8.19 CanvasTextMetrics).
  const metrics = CanvasTextMetrics as unknown as { __canvas?: unknown; __context?: unknown };
  metrics.__canvas = canvas;
  metrics.__context = context;
  // Drop any font metrics already cached from the previous (offscreen) canvas.
  CanvasTextMetrics.clearMetrics();
}
