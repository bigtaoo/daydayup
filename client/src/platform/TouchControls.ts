import type { InputState } from './types';

// Platform-agnostic virtual twin-stick controls.
//
// Pure geometry + state, fed normalized screen-space pointer events (CSS pixels) from
// whatever event source the platform has: DOM touch events (Web / Capacitor) or wx
// global touch events (WeChat). Both feed the same math here, so the on-screen controls
// behave identically everywhere.
//
//   left half  → movement joystick (dynamic origin at touch-down)
//   right half → aim joystick; firing while held (aim reported as a direction)
//   corner buttons → jump / block (hold) / weapon 1 / weapon 2
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
  onJump: (() => void) | null = null;

  private w = 0;
  private stickRadius = 1;

  private move: Stick | null = null;
  private aim: Stick | null = null;
  private blockId: number | null = null;

  private jumpBtn: Button = { cx: 0, cy: 0, r: 0 };
  private blockBtn: Button = { cx: 0, cy: 0, r: 0 };
  private weapon1Btn: Button = { cx: 0, cy: 0, r: 0 };
  private weapon2Btn: Button = { cx: 0, cy: 0, r: 0 };

  // Screen size in logical (CSS) pixels — the same units the pointer coords use.
  layout(width: number, height: number) {
    this.w = width;
    const unit = Math.min(width, height);
    this.stickRadius = unit * 0.18;

    const r = unit * 0.08;
    const m = r + unit * 0.04; // margin from the edge to a button centre
    const gap = r * 2.4;
    this.jumpBtn = { cx: width - m, cy: height - m, r };
    this.blockBtn = { cx: width - m, cy: height - m - gap, r };
    this.weapon1Btn = { cx: width - m, cy: m, r };
    this.weapon2Btn = { cx: width - m - gap, cy: m, r };
  }

  pointerDown(id: number, x: number, y: number) {
    // Buttons take priority over the sticks.
    if (inCircle(x, y, this.jumpBtn)) {
      this.onJump?.();
      return;
    }
    if (inCircle(x, y, this.weapon1Btn)) {
      this.onSwitchWeapon?.(1);
      return;
    }
    if (inCircle(x, y, this.weapon2Btn)) {
      this.onSwitchWeapon?.(2);
      return;
    }
    if (inCircle(x, y, this.blockBtn)) {
      this.blockId = id;
      return;
    }

    // Otherwise: left half drives movement, right half drives aim/fire.
    const stick: Stick = { id, ox: x, oy: y, dx: 0, dy: 0 };
    if (x < this.w * 0.5) this.move = stick;
    else this.aim = stick;
  }

  pointerMove(id: number, x: number, y: number) {
    if (this.move && id === this.move.id) this.updateStick(this.move, x, y);
    if (this.aim && id === this.aim.id) this.updateStick(this.aim, x, y);
  }

  pointerUp(id: number) {
    if (this.move && id === this.move.id) this.move = null;
    if (this.aim && id === this.aim.id) this.aim = null;
    if (this.blockId === id) this.blockId = null;
  }

  // True while the player is touching any control — lets a platform that also has
  // mouse/keyboard (desktop Web) decide which source is currently driving.
  hasActiveTouch(): boolean {
    return this.move !== null || this.aim !== null || this.blockId !== null;
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

    // Aim: unit direction from the right stick. Idle → (0,0) so Game keeps last facing.
    let adx = 0;
    let ady = 0;
    let firing = false;
    if (this.aim) {
      const len = Math.hypot(this.aim.dx, this.aim.dy);
      if (len > 0.001) {
        adx = this.aim.dx / len;
        ady = this.aim.dy / len;
        firing = true;
      }
    }

    return {
      moveX: move.dx,
      moveY: move.dy,
      aim: { mode: 'dir', dx: adx, dy: ady },
      firing,
      blocking: this.blockId !== null,
    };
  }
}

function inCircle(x: number, y: number, b: Button): boolean {
  return Math.hypot(x - b.cx, y - b.cy) <= b.r;
}
