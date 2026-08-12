import { Graphics } from 'pixi.js';
import type { Layers } from './layers';
import type { BiomePalette } from '../theme';

/**
 * Full-viewport backdrop (design/10 legibility fix, 2026-08-02) — a plain black rect
 * behind the room since nothing painted there before. FxController.updateCamera's
 * cover-fit zoom (2026-08-12 follow-up) means the room now covers the viewport on
 * every axis for the vast majority of rooms, so this is mostly a safety net for a
 * MAX_ZOOM-capped degenerate/tiny room that still can't fully cover it. This is screen
 * space (mounted on `layers.backdrop`, a sibling of `world`, not a child of it), so it
 * just needs to track the viewport's own pixel size — it never has to account for the
 * camera's zoom/pan. Recolored per-biome (`BiomePalette.void`) so it doesn't look like
 * a different game bolted on behind the room.
 */
export class Backdrop {
  private readonly gfx = new Graphics();
  private w = 0;
  private h = 0;
  private color = 0x000000;

  constructor(layers: Layers) {
    layers.backdrop.addChild(this.gfx);
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.redraw();
  }

  setPalette(palette: BiomePalette): void {
    this.color = palette.void;
    this.redraw();
  }

  private redraw(): void {
    this.gfx.clear();
    if (this.w <= 0 || this.h <= 0) return;
    this.gfx.rect(0, 0, this.w, this.h).fill({ color: this.color });
  }
}
