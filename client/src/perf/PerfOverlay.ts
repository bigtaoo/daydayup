// On-screen readout for the perf system (`?perf=1`).
//
// This is the piece funny does not have and daydayup needs most: funny ships its perf
// findings to a log backend and reads them there, which works when the question is "did
// any client in the field get slow". The question here is "why is THIS frame slow, right
// now, while I move the character around" — that has to be answered on the glass, in the
// same frame it describes.
//
// Deliberately dumb: one Text, rebuilt from a snapshot at a fixed cadence. No graphs, no
// per-frame allocation, nothing that would show up in the numbers it is reporting.

import { Container, Graphics, Text, type Ticker } from 'pixi.js';
import type { PerfSnapshot } from './PerfMonitor';

const PAD = 8;
const REFRESH_MS = 400; // fast enough to feel live, slow enough that the Text re-upload is noise

export class PerfOverlay {
  readonly view = new Container();
  private readonly bg = new Graphics();
  private readonly label: Text;
  private sinceRefreshMs = 0;
  private snapshot: PerfSnapshot | null = null;
  private liveFps = 0;

  constructor() {
    this.label = new Text({
      text: '',
      style: {
        fontFamily: 'monospace',
        fontSize: 12,
        fill: 0xd8f4ff,
        lineHeight: 15,
      },
    });
    this.label.x = PAD;
    this.label.y = PAD;
    this.view.addChild(this.bg, this.label);
    this.view.eventMode = 'none'; // never swallow a tap meant for the game underneath
    this.view.zIndex = 10_000;
    this.view.visible = false;
  }

  /** Latest closed window. Held, not drawn immediately — the redraw is on the refresh
   *  cadence so a short sampling window can't turn the overlay into its own workload. */
  setSnapshot(s: PerfSnapshot): void {
    this.snapshot = s;
  }

  toggle(on = !this.view.visible): void {
    this.view.visible = on;
  }

  /** Drive from the app ticker. Cheap: an accumulator compare on most frames. The screen
   *  size is re-read on every redraw rather than wired to a resize event — the overlay has
   *  to survive a resize whether or not the host remembered to tell it about one. */
  update(ticker: Ticker, screenWidth: number, screenHeight: number): void {
    if (!this.view.visible) return;
    this.liveFps = ticker.FPS;
    this.sinceRefreshMs += ticker.deltaMS;
    if (this.sinceRefreshMs < REFRESH_MS) return;
    this.sinceRefreshMs = 0;
    this.redraw();
    this.layout(screenWidth, screenHeight);
  }

  /** Bottom-right — the only corner the HUD leaves free. Top-left is the player card,
   *  top-right is the pause button and the minimap, bottom-left is the touch stick. */
  layout(screenWidth: number, screenHeight: number): void {
    this.view.x = Math.max(0, screenWidth - this.view.width - PAD);
    this.view.y = Math.max(0, screenHeight - this.view.height - PAD);
  }

  private redraw(): void {
    this.label.text = this.snapshot ? formatSnapshot(this.snapshot, this.liveFps) : `fps ${this.liveFps.toFixed(0)}\nsampling…`;
    this.bg
      .clear()
      .roundRect(0, 0, this.label.width + PAD * 2, this.label.height + PAD * 2, 4)
      .fill({ color: 0x000000, alpha: 0.55 });
  }
}

/** The snapshot as the block of text the overlay shows. Pulled out of the class so a test
 *  can assert what the numbers say without constructing a Pixi Text. */
export function formatSnapshot(s: PerfSnapshot, liveFps: number): string {
  const { window: w, gl, scene } = s;
  const ms = (n: number): string => n.toFixed(1);
  const lines = [
    `fps ${liveFps.toFixed(0)}  (win ${w.fps.toFixed(0)}${w.discarded ? ' hidden' : ''})`,
    `frame ${ms(w.frame.p50)} / p95 ${ms(w.frame.p95)} / max ${ms(w.frame.max)}`,
    `update ${ms(w.update.p50)}   render ${ms(w.render.p50)}`,
  ];
  if (w.busyRatio > 0) lines.push(`longtask ${(w.busyRatio * 100).toFixed(0)}%`);
  if (gl.draws > 0) {
    lines.push(`draws ${gl.draws}  prog ${gl.programs}  tex ${gl.textures}`);
    lines.push(`filter passes ~${s.filterPasses}`);
  }
  lines.push(`nodes ${scene.nodes}${scene.capped ? '+' : ''}  filtered ${scene.filtered}`);
  lines.push(`gpu tex ${s.gpuTextures}  listeners ${s.tickerListeners}`);
  if (s.heapMB != null) lines.push(`heap ${s.heapMB}MB`);
  return lines.join('\n');
}
