import type { InputCanvas, InputSource, InputState, TouchVisual } from '../types';
import { TouchControls } from '../TouchControls';

// Web input. Desktop uses keyboard + mouse; touch devices (mobile browser, Capacitor
// webview) use the shared virtual twin-stick. Both are attached; read() returns the
// touch state whenever a control is being touched, otherwise keyboard/mouse.
export class WebInput implements InputSource {
  private keys = new Set<string>();
  private leftDown = false;

  private controls = new TouchControls();

  onSwitchWeapon: ((slot: number) => void) | null = null;

  attach(canvasLike: InputCanvas) {
    const canvas = canvasLike as unknown as HTMLCanvasElement;

    // ---- keyboard + mouse ----
    window.addEventListener('keydown', (e) => {
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (e.code === 'Digit1') this.onSwitchWeapon?.(1);
      if (e.code === 'Digit2') this.onSwitchWeapon?.(2);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.leftDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.leftDown = false;
    });

    // ---- touch (mobile / Capacitor) ----
    this.controls.onSwitchWeapon = (slot) => this.onSwitchWeapon?.(slot);

    const relayout = () => {
      const r = canvas.getBoundingClientRect();
      this.controls.layout(r.width, r.height);
    };
    relayout();
    window.addEventListener('resize', relayout);

    const feed = (e: TouchEvent, fn: (id: number, x: number, y: number) => void) => {
      const r = canvas.getBoundingClientRect();
      for (const t of Array.from(e.changedTouches)) {
        fn(t.identifier, t.clientX - r.left, t.clientY - r.top);
      }
    };
    canvas.addEventListener('touchstart', (e) => { e.preventDefault(); feed(e, (id, x, y) => this.controls.pointerDown(id, x, y)); }, { passive: false });
    canvas.addEventListener('touchmove', (e) => { e.preventDefault(); feed(e, (id, x, y) => this.controls.pointerMove(id, x, y)); }, { passive: false });
    const end = (e: TouchEvent) => { e.preventDefault(); for (const t of Array.from(e.changedTouches)) this.controls.pointerUp(t.identifier); };
    canvas.addEventListener('touchend', end, { passive: false });
    canvas.addEventListener('touchcancel', end, { passive: false });
  }

  getTouchVisual(): TouchVisual {
    return this.controls.getVisual();
  }

  setControlMirror(mirrored: boolean): void {
    this.controls.setMirrored(mirrored);
  }

  read(): InputState {
    if (this.controls.hasActiveTouch()) return this.controls.read();

    const k = this.keys;
    let mx = 0;
    let my = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) my -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    const len = Math.hypot(mx, my) || 1;
    return {
      moveX: mx / len,
      moveY: my / len,
      firing: this.leftDown,
      // E or Space held = INTERACT (extraction checkpoint hold/tap, ROADMAP 1.4).
      interacting: k.has('KeyE') || k.has('Space'),
    };
  }
}
