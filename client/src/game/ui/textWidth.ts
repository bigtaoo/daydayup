/** Approximate a monospace string's rendered pixel width without touching Pixi's
 * canvas-based text measurement (`Text.width`/`Container.getBounds()` need a real 2D
 * canvas context to measure glyphs — expensive to redo every frame in the browser, and
 * unavailable at all in this project's Node-only unit-test environment, which has
 * neither jsdom/happy-dom nor a native canvas polyfill installed). Every HUD text style
 * this is used for is `fontFamily: 'monospace'`, so a fixed per-character advance is
 * accurate enough for sizing a backing panel; 0.6 matches common monospace
 * advance-width ratios. */
export function estimateMonoWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}
