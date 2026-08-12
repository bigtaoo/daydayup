import type { Application } from 'pixi.js';

// Pure viewport math, split out of Game.ts (`screenSize()`) so the actual formula is
// unit-testable without standing up a Pixi `Application` — Game.ts itself has no test
// file (see [[daydayup-testing-conventions]]'s documented exemption), but there is no
// reason the one-line computation it delegates to needs the same exemption.
//
// `renderer.screen` is Pixi's own documented logical (CSS-pixel) render-area size —
// "safe to use as filterArea or hitArea for the whole stage" per its own doc comment —
// so it is exactly what every screen's layout should be sized against, unconditionally,
// with no `resolution` math layered on top.
//
// A prior version of this computation used `renderer.width / renderer.resolution`, on
// the assumption that `.width` is a device-pixel size that needs converting back to
// logical pixels. Empirically (this Pixi build, `autoDensity: true` in
// `platform/web/WebPlatform.ts`), `.width` is ALREADY logical and equal to
// `.screen.width` — so that division silently shrank every screen's whole layout to
// `1/devicePixelRatio` of the real viewport. Invisible at devicePixelRatio 1 (division
// by 1 is a no-op — most quick local checks run at 100% display scaling), so the bug
// kept surviving review; real on any HiDPI display (confirmed live via `claude-in-
// chrome` at devicePixelRatio 1.5, 2026-08-12 — game content rendered into only the
// top-left ~2/3 of the canvas, the rest reading as unfilled black, matching a user
// screenshot report of "the viewport still doesn't fill the page window"). The
// regression this guards against: re-introducing ANY division/multiplication by
// `resolution`/`devicePixelRatio` here.
export function computeScreenSize(app: Application): { w: number; h: number } {
  return { w: app.renderer.screen.width, h: app.renderer.screen.height };
}
