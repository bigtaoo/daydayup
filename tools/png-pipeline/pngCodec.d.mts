// Types for the pure-Node PNG codec (`pngCodec.mjs`), which is plain JS by design — it runs as a
// CLI from `compress.mjs`/`alpha-audit.mjs`/`lumaCurve.mjs` with no build step. Declared here so a
// TypeScript workspace can import it too: `client/src/game/scene/pillarArt.test.ts` decodes the
// shipped pillar sprite and measures it (2026-08-20).
export interface PngImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array;
}

export function decodePNG(buf: Uint8Array): PngImage;
export function encodePNG(img: PngImage): Buffer;
export function trimAlphaBoundingBox(img: PngImage): PngImage;
export function boxDownsample(img: PngImage, targetLongAxis: number): PngImage;
export function processPNG(
  inputBuf: Uint8Array,
  opts?: { targetLongAxis?: number; trim?: boolean },
): PngImage & { buffer: Buffer; originalWidth: number; originalHeight: number };
