import type { InputState, TouchVisual } from './types';

// Platform-agnostic virtual twin-stick controls.
//
// Pure geometry + state, fed normalized screen-space pointer events (CSS pixels) from
// whatever event source the platform has: DOM touch events (Web / Capacitor) or wx
// global touch events (WeChat). Both feed the same math here, so the on-screen controls
// behave identically everywhere.
//
//   left half  → movement joystick (dynamic origin at touch-down)
//   right half → hold-to-fire (design/10 v33: no more aim stick — the engine auto-faces,
//                see ApplyInputSystem; a melee swing is also the parry)
//   corner buttons → weapon 1 / weapon 2  (no jump/block — parry is the swing arc)
interface Stick {
  id: number;
  ox: number;
  oy: number;
  dx: number; // normalized offset from origin, magnitude clamped to 1
  dy: number;
}

interface Button {
  cx: number;
  cy: number;
  r: number;
}

export class TouchControls {
  onSwitchWeapon: ((slot: number) => void) | null = null;

  private w = 0;
  private h = 0;
  private stickRadius = 1;
  // design/10 open question ("control layout … left-handed mirror") — swaps which half
  // of the screen drives movement vs. fire, and moves the weapon buttons to the
  // opposite corner. Persisted in SettingsState.controlLayout, applied via setMirrored.
  private mirrored = false;

  private move: Stick | null = null;
  private fireTouchId: number | null = null;

  // Set on the first pointerDown ever and never cleared — this is "is this session a
  // touch session" (drives TouchVisual.active), distinct from hasActiveTouch() below,
  // which is momentary and drives which input source read() prefers right now.
  private everTouched = false;

  private weapon1Btn: Button = { cx: 0, cy: 0, r: 0 };
  private weapon2Btn: Button = { cx: 0, cy: 0, r: 0 };
  private fireBtn: Button = { cx: 0, cy: 0, r: 0 };

  // Screen size in logical (CSS) pixels — the same units the pointer coords use.
  layout(width: number, height: number) {
    this.w = width;
    this.h = height;
    const unit = Math.min(width, height);
    this.stickRadius = unit * 0.18;

    const r = unit * 0.08;
    const m = r + unit * 0.04; // margin from the edge to a button centre
    const gap = r * 2.4;
    // Standard: buttons sit top-right (thumb-natural for a right-handed grip holding
    // the movement stick on the left). Mirrored: top-left instead.
    if (this.mirrored) {
      this.weapon1Btn = { cx: m, cy: m, r };
      this.weapon2Btn = { cx: m + gap, cy: m, r };
    } else {
      this.weapon1Btn = { cx: width - m, cy: m, r };
      this.weapon2Btn = { cx: width - m - gap, cy: m, r };
    }
    // Fire button: centred in the fire-side half (mirrored: left, else right), same
    // radius as the move stick so it's an equally generous thumb target. Fixed position
    // (unlike the old dynamic-origin aim stick), so it stays put across presses instead
    // of appearing wherever the player last tapped.
    const fireCx = this.mirrored ? unit * 0.25 : width - unit * 0.25;
    this.fireBtn = { cx: fireCx, cy: height * 0.5, r: this.stickRadius };
  }

  /** Left-handed control-layout toggle (design/10, `Settings.ts`) — swaps which half of
   *  the screen drives movement vs. fire and re-anchors the weapon buttons to the
   *  opposite corner. Re-lays out immediately against the last known screen size (if
   *  any) rather than waiting for the next resize, so a mid-session toggle takes effect
   *  right away. A no-op if the value hasn't actually changed. */
  setMirrored(mirrored: boolean) {
    if (this.mirrored === mirrored) return;
    this.mirrored = mirrored;
    if (this.w > 0 && this.h > 0) this.layout(this.w, this.h);
  }

  pointerDown(id: number, x: number, y: number) {
    this.everTouched = true;

    // Buttons take priority over the sticks.
    if (inCircle(x, y, this.weapon1Btn)) {
      this.onSwitchWeapon?.(1);
      return;
    }
    if (inCircle(x, y, this.weapon2Btn)) {
      this.onSwitchWeapon?.(2);
      return;
    }

    // Otherwise: left half drives movement, right half fires (hold anywhere in that
    // half — no precision tap needed) — swapped when `mirrored` (setMirrored/design/10's
    // left-handed layout option).
    const leftHalf = x < this.w * 0.5;
    if (leftHalf !== this.mirrored) this.move = { id, ox: x, oy: y, dx: 0, dy: 0 };
    else this.fireTouchId = id;
  }

  pointerMove(id: number, x: number, y: number) {
    if (this.move && id === this.move.id) this.updateStick(this.move, x, y);
  }

  pointerUp(id: number) {
    if (this.move && id === this.move.id) this.move = null;
    if (this.fireTouchId === id) this.fireTouchId = null;
  }

  // True while the player is touching any control — lets a platform that also has
  // mouse/keyboard (desktop Web) decide which source is currently driving.
  hasActiveTouch(): boolean {
    return this.move !== null || this.fireTouchId !== null;
  }

  // Render-facing snapshot for the on-screen overlay (TouchControlsView) — see
  // TouchVisual's doc comment (platform/types.ts). dx/dy are converted back from the
  // normalized [-1,1] `read()` uses into the raw pixel offset a render layer wants.
  getVisual(): TouchVisual {
    return {
      active: this.everTouched,
      stickRadius: this.stickRadius,
      move: this.move
        ? { ox: this.move.ox, oy: this.move.oy, dx: this.move.dx * this.stickRadius, dy: this.move.dy * this.stickRadius }
        : null,
      fire: { ...this.fireBtn, pressed: this.fireTouchId !== null },
      weapon1: { ...this.weapon1Btn },
      weapon2: { ...this.weapon2Btn },
    };
  }

  private updateStick(s: Stick, x: number, y: number) {
    let dx = x - s.ox;
    let dy = y - s.oy;
    const len = Math.hypot(dx, dy);
    if (len > this.stickRadius) {
      dx = (dx / len) * this.stickRadius;
      dy = (dy / len) * this.stickRadius;
    }
    s.dx = dx / this.stickRadius; // [-1, 1]
    s.dy = dy / this.stickRadius;
  }

  read(): InputState {
    const move = this.move ?? { dx: 0, dy: 0 };

    return {
      moveX: move.dx,
      moveY: move.dy,
      firing: this.fireTouchId !== null,
      // No on-screen INTERACT button yet — a touch extraction control is a follow-up
      // (design/05). Touch players reach a checkpoint but can't resolve it for now.
      interacting: false,
    };
  }
}

function inCircle(x: number, y: number, b: Button): boolean {
  return Math.hypot(x - b.cx, y - b.cy) <= b.r;
}
