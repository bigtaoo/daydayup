// Test-only helper (imported by *.test.ts, never by shipped code).
//
// Any screen layout that flows off `Text.height` lazily asks Pixi to measure glyphs on a
// real <canvas> 2D context, which does not exist under this repo's plain-node vitest
// environment (no jsdom/canvas dependency — every UI test that avoids `.height`/`.bounds`
// on a Text avoids it for exactly this reason). This swaps in a fake canvas through Pixi's
// own DOMAdapter seam instead of pulling in a real canvas just to run a layout: the glyph
// metrics are approximate (0.6em per character), which only shifts where content flows,
// never whether a fixed bar / fit-scale / no-room-hide rule behaves right.
import { DOMAdapter } from 'pixi.js';

export function installFakeTextCanvas(): void {
  DOMAdapter.set({
    ...DOMAdapter.get(),
    createCanvas: (width?: number, height?: number) => {
      const ctx = {
        font: '',
        measureText(text: string) {
          const m = /(\d+(?:\.\d+)?)px/.exec(this.font as string);
          const fontSize = m ? parseFloat(m[1]!) : 10;
          const w = text.length * fontSize * 0.6;
          return { width: w, actualBoundingBoxAscent: fontSize * 0.8, actualBoundingBoxDescent: fontSize * 0.2 };
        },
      };
      return { width: width ?? 0, height: height ?? 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    },
    getCanvasRenderingContext2D: () => class {} as unknown as typeof CanvasRenderingContext2D,
  });
}
