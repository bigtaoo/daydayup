import { Container, Graphics, Text, Rectangle } from 'pixi.js';

// A minimal Pixi widget kit (design/10 "build vs. a tiny in-house layer" — kept small,
// no framework). Every widget is pure presentation: it takes plain values in `set()`/
// constructor opts and draws — none of them read the engine directly (Game.ts is the
// only place that reads `state`/`events` and feeds these).

/** Rounded-rect background chrome shared by every overlay (menu/forge/settings/HUD
 * groupings) — one look, one place to retune, instead of each screen hand-rolling its
 * own `Graphics().rect().fill()`. */
export class Panel {
  readonly view = new Graphics();
  private w = 0;
  private h = 0;
  private radius: number;
  private color: number;
  private alpha: number;

  constructor(opts: { radius?: number; color?: number; alpha?: number } = {}) {
    this.radius = opts.radius ?? 0;
    this.color = opts.color ?? 0x0b0e14;
    this.alpha = opts.alpha ?? 0.82;
  }

  layout(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.view.clear();
    if (this.radius > 0) this.view.roundRect(0, 0, w, h, this.radius).fill({ color: this.color, alpha: this.alpha });
    else this.view.rect(0, 0, w, h).fill({ color: this.color, alpha: this.alpha });
  }
}

/** A labeled value/max bar (HP, shield, weapon cooldown) with a brief bright flash the
 * frame its value drops — the "flash/shake on hp_changed" cue design/10's HUD table
 * asks for, done once here instead of per-caller. */
export class Bar {
  readonly view = new Container();
  private track = new Graphics();
  private fill = new Graphics();
  private flashOverlay = new Graphics();
  private label: Text | null = null;
  private w: number;
  private h: number;
  private fillColor: number;
  private curFrac = 0;
  private lastValue = -1;
  private flashMs = 0;
  private static readonly FLASH_LIFE_MS = 160;

  constructor(opts: { w: number; h: number; fillColor: number; trackColor?: number; label?: boolean }) {
    this.w = opts.w;
    this.h = opts.h;
    this.fillColor = opts.fillColor;
    this.track.roundRect(0, 0, this.w, this.h, this.h / 2).fill({ color: opts.trackColor ?? 0x1f2532 });
    this.view.addChild(this.track, this.fill, this.flashOverlay);
    if (opts.label) {
      this.label = new Text({ text: '', style: { fill: 0xe2e8f0, fontSize: 11, fontFamily: 'monospace' } });
      this.label.anchor.set(0.5);
      this.label.position.set(this.w / 2, this.h / 2);
      this.view.addChild(this.label);
    }
  }

  /** value/max in [0, max]. `labelText` overrides the default `value/max` readout. */
  set(value: number, max: number, labelText?: string) {
    this.curFrac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    this.fill.clear();
    if (this.curFrac > 0) this.fill.roundRect(0, 0, this.w * this.curFrac, this.h, this.h / 2).fill({ color: this.fillColor });
    if (this.lastValue >= 0 && value < this.lastValue) this.flashMs = Bar.FLASH_LIFE_MS;
    this.lastValue = value;
    if (this.label) this.label.text = labelText ?? `${Math.max(0, Math.round(value))}/${Math.round(max)}`;
  }

  /** Advance the decrease-flash fade. Call once per render frame (dt in ms). */
  update(dt: number) {
    if (this.flashMs <= 0) {
      if (this.flashOverlay.visible) this.flashOverlay.clear();
      this.flashOverlay.visible = false;
      return;
    }
    this.flashMs = Math.max(0, this.flashMs - dt);
    const a = (this.flashMs / Bar.FLASH_LIFE_MS) * 0.55;
    this.flashOverlay.visible = true;
    this.flashOverlay.clear();
    if (this.curFrac > 0) this.flashOverlay.roundRect(0, 0, this.w * this.curFrac, this.h, this.h / 2).fill({ color: 0xffffff, alpha: a });
  }
}

/** A transient fading message queue (pickup/buff feedback, design/10 "pickup/buff
 * toast"). Newest message appears at the bottom; each message fades over its life and
 * is removed, and the stack re-settles upward. */
export class ToastQueue {
  readonly view = new Container();
  private items: { text: Text; life: number }[] = [];
  private w: number;
  private lifeMs: number;
  private lineH: number;

  constructor(opts: { w: number; lifeMs?: number; lineH?: number }) {
    this.w = opts.w;
    this.lifeMs = opts.lifeMs ?? 1400;
    this.lineH = opts.lineH ?? 22;
  }

  push(text: string, color = 0xe2e8f0) {
    const t = new Text({ text, style: { fill: color, fontSize: 15, fontFamily: 'monospace', fontWeight: 'bold' } });
    t.anchor.set(0.5, 0);
    t.position.x = this.w / 2;
    this.view.addChild(t);
    this.items.push({ text: t, life: this.lifeMs });
    this.relayout();
  }

  update(dt: number) {
    let removed = false;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      it.life -= dt;
      // Fade over the tail third of its life, full opacity before that.
      it.text.alpha = Math.max(0, Math.min(1, it.life / (this.lifeMs / 3)));
      if (it.life <= 0) {
        it.text.destroy();
        this.items.splice(i, 1);
        removed = true;
      }
    }
    if (removed) this.relayout();
  }

  private relayout() {
    this.items.forEach((it, i) => { it.text.position.y = i * this.lineH; });
  }
}

/** A tappable Pixi button — hit-area + label, no DOM (design/10 "no DOM widgets"). */
export class Button {
  readonly view = new Container();
  private bg = new Graphics();
  private label: Text;
  onTap: (() => void) | null = null;

  constructor(text: string, opts: { w: number; h: number; color?: number; textColor?: number; fontSize?: number }) {
    const { w, h, color = 0x2a3140, textColor = 0xe2e8f0, fontSize = 15 } = opts;
    this.bg.roundRect(0, 0, w, h, Math.min(8, h / 2)).fill({ color, alpha: 0.9 });
    // `padding` works around a real font-metrics mismatch observed in headless/sandboxed
    // Chromium: Pixi's own text measurement can come in narrower than the canvas's actual
    // paint-time glyph width for bold text, clipping the last character(s) — Pixi's own
    // documented mitigation ("occasionally some fonts are cropped").
    this.label = new Text({ text, style: { fill: textColor, fontSize, fontFamily: 'monospace', fontWeight: 'bold', padding: 14 } });
    this.label.anchor.set(0.5);
    this.label.position.set(w / 2, h / 2);
    this.view.addChild(this.bg, this.label);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.on('pointertap', () => this.onTap?.());
    // A button nested inside a screen that ALSO has its own full-panel `pointerdown`
    // handler (e.g. Screens.ts's tap-anywhere-to-confirm) would otherwise double-fire —
    // pointerdown bubbles to ancestors regardless of what consumes the later tap. Stop
    // it here once so every button is safe to drop onto such a screen.
    this.view.on('pointerdown', (e) => e.stopPropagation());
  }

  setText(text: string) {
    this.label.text = text;
  }
}

/** A draggable [0,1] slider (settings volume, design/10). Drag tracking is done on a
 * `dragSurface` (a full-screen container already in `eventMode:'static'`, e.g. the
 * owning screen's `view`) via `globalpointermove`, so the knob keeps tracking even once
 * the pointer moves off the thin track — the standard Pixi v8 drag pattern. */
export class Slider {
  readonly view = new Container();
  private track = new Graphics();
  private knob = new Graphics();
  private w: number;
  private value = 0;
  private dragging = false;
  onChange: ((v: number) => void) | null = null;

  constructor(opts: { w: number; dragSurface?: Container }) {
    this.w = opts.w;
    const h = 6;
    const knobR = 9;
    this.track.roundRect(0, -h / 2, this.w, h, h / 2).fill({ color: 0x1f2532 });
    this.knob.circle(0, 0, knobR).fill({ color: 0x63b3ed });
    this.view.addChild(this.track, this.knob);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.hitArea = new Rectangle(-knobR, -20, this.w + knobR * 2, 40);

    const surface = opts.dragSurface ?? this.view;
    this.view.on('pointerdown', (e) => {
      this.dragging = true;
      this.seekFromGlobal(e.global.x, e.global.y);
    });
    surface.on('globalpointermove', (e) => {
      if (this.dragging) this.seekFromGlobal(e.global.x, e.global.y);
    });
    surface.on('pointerup', () => { this.dragging = false; });
    surface.on('pointerupoutside', () => { this.dragging = false; });
  }

  private seekFromGlobal(gx: number, gy: number) {
    const local = this.view.toLocal({ x: gx, y: gy });
    this.set(local.x / this.w);
    this.onChange?.(this.value);
  }

  set(v: number) {
    this.value = Math.max(0, Math.min(1, v));
    this.knob.position.x = this.value * this.w;
  }

  get(): number {
    return this.value;
  }
}
