/** True for code points a monospace font renders at roughly double the Latin advance
 * (CJK ideographs + kana + hangul + fullwidth forms) — the ranges the Unicode East
 * Asian Width property calls Wide/Fullwidth, trimmed to the blocks this project's
 * locales actually use (`zh.ts`). Without this, a translated HUD string measures at
 * 60% of its real width and every backing panel sized from it comes up short. */
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // hangul jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, kangxi, CJK symbols/punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, hangul compat jamo, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff01 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  );
}

/** Approximate a monospace string's rendered pixel width without touching Pixi's
 * canvas-based text measurement (`Text.width`/`Container.getBounds()` need a real 2D
 * canvas context to measure glyphs — expensive to redo every frame in the browser, and
 * unavailable at all in this project's Node-only unit-test environment, which has
 * neither jsdom/happy-dom nor a native canvas polyfill installed). Every HUD text style
 * this is used for is `fontFamily: 'monospace'`, so a fixed per-character advance is
 * accurate enough for sizing a backing panel; 0.6 matches common monospace
 * advance-width ratios, and a wide (CJK/fullwidth) code point counts as a full em. */
export function estimateMonoWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) units += isWideChar(ch.codePointAt(0) ?? 0) ? 1 : 0.6;
  return units * fontSize;
}
