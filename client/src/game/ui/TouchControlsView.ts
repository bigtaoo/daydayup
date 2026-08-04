import { Container, Graphics, Text } from 'pixi.js';
import type { TouchVisual } from '../../platform/types';
import { THEME } from '../theme';

// Visual layer for the touch controls TouchControls.ts hit-tests (design/10 open
// question: touch players had no on-screen indication of the sticks/buttons). Pure
// presentation — it never reads pointer/touch events itself, only the geometry
// TouchControls already computed, so the drawing can never drift from the real hit
// zones. Hidden entirely until TouchVisual.active (the player has touched the screen
// at least once), so desktop/mouse play never sees it (WebInput's mouse+keyboard path
// is untouched either way — this only ever mirrors TouchControls' own state).
export class TouchControlsView {
  readonly view = new Container();
  private readonly moveBase = new Graphics();
  private readonly moveKnob = new Graphics();
  private readonly fireButton = new Graphics();
  private readonly weapon1 = new Graphics();
  private readonly weapon2 = new Graphics();
  private readonly weapon1Label: Text;
  private readonly weapon2Label: Text;

  constructor() {
    const labelStyle = { fill: 0xe2e8f0, fontSize: 15, fontFamily: 'monospace' as const, fontWeight: 'bold' as const, padding: 8 };
    this.weapon1Label = new Text({ text: '1', style: labelStyle });
    this.weapon2Label = new Text({ text: '2', style: labelStyle });
    this.weapon1Label.anchor.set(0.5);
    this.weapon2Label.anchor.set(0.5);

    this.view.addChild(
      this.moveBase, this.moveKnob, this.fireButton,
      this.weapon1, this.weapon2, this.weapon1Label, this.weapon2Label,
    );
    this.view.visible = false;
    // Presentation only — never intercepts the DOM/wx touch events TouchControls
    // itself listens for (those are attached to the canvas, not these Pixi nodes).
    this.view.eventMode = 'none';
  }

  update(visual: TouchVisual): void {
    this.view.visible = visual.active;
    if (!visual.active) return;

    // Movement stick — base+knob only exist once the origin is known (dynamic origin
    // on touch-down; there is nothing meaningful to draw at rest).
    drawStick(this.moveBase, this.moveKnob, visual.move, visual.stickRadius, THEME.colors.player);
    // Right-side zone: a plain hold-to-fire button (design/10 v33 — no more aim stick,
    // the engine auto-faces the nearest hostile). Fixed position, brightens while held.
    drawFireButton(this.fireButton, visual.fire);

    drawButton(this.weapon1, this.weapon1Label, visual.weapon1);
    drawButton(this.weapon2, this.weapon2Label, visual.weapon2);
  }
}

function drawStick(
  base: Graphics,
  knob: Graphics,
  stick: { ox: number; oy: number; dx: number; dy: number } | null,
  radius: number,
  color: number,
): void {
  base.visible = stick !== null;
  knob.visible = stick !== null;
  if (!stick) return;

  base.clear().circle(stick.ox, stick.oy, radius).fill({ color, alpha: 0.14 }).stroke({ color, width: 2, alpha: 0.4 });
  // Held true once the drag has moved enough to actually register (matches
  // TouchControls.read()'s own len>0.001 threshold for firing) — the knob brightens so
  // a bare tap-and-hold visibly reads as "not quite there yet".
  const held = Math.hypot(stick.dx, stick.dy) > 0.001;
  knob.clear().circle(stick.ox + stick.dx, stick.oy + stick.dy, radius * 0.4).fill({ color, alpha: held ? 0.9 : 0.5 });
}

function drawFireButton(g: Graphics, b: { cx: number; cy: number; r: number; pressed: boolean }): void {
  const color = THEME.colors.muzzle;
  g.clear()
    .circle(b.cx, b.cy, b.r)
    .fill({ color, alpha: b.pressed ? 0.32 : 0.14 })
    .stroke({ color, width: 2, alpha: b.pressed ? 0.7 : 0.4 });
}

function drawButton(g: Graphics, label: Text, b: { cx: number; cy: number; r: number }): void {
  g.clear().circle(b.cx, b.cy, b.r).fill({ color: 0x2a3140, alpha: 0.78 }).stroke({ color: 0xe2e8f0, width: 2, alpha: 0.35 });
  label.position.set(b.cx, b.cy);
}
