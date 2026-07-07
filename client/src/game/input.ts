// Input abstraction. Web uses keyboard+mouse; the WeChat platform swaps the implementation
// (virtual joystick + touch), see design/04-wechat.md.
export interface InputState {
  moveX: number;
  moveY: number;
  aimX: number; // screen coords
  aimY: number;
  firing: boolean;
  blocking: boolean;
}

export class WebInput {
  private keys = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private leftDown = false;
  private rightDown = false;

  onSwitchWeapon: ((slot: number) => void) | null = null;
  onJump: (() => void) | null = null;

  attach(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (e.code === 'Digit1') this.onSwitchWeapon?.(1);
      if (e.code === 'Digit2') this.onSwitchWeapon?.(2);
      if (e.code === 'Space') this.onJump?.();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - r.left;
      this.mouseY = e.clientY - r.top;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.leftDown = true;
      if (e.button === 2) this.rightDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.leftDown = false;
      if (e.button === 2) this.rightDown = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  read(): InputState {
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
      aimX: this.mouseX,
      aimY: this.mouseY,
      firing: this.leftDown,
      blocking: this.rightDown || k.has('ShiftLeft') || k.has('ShiftRight'),
    };
  }
}
