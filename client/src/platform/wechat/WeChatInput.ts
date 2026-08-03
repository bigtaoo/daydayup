import type { Application } from 'pixi.js';
import type { InputSource, InputState, TouchVisual } from '../types';
import { TouchControls } from '../TouchControls';

// WeChat touch input: feeds wx global touch events into the shared TouchControls.
// All the stick/button behaviour lives in TouchControls so it matches the Web build.
export class WeChatInput implements InputSource {
  private app: Application;
  private controls = new TouchControls();

  get onSwitchWeapon() {
    return this.controls.onSwitchWeapon;
  }
  set onSwitchWeapon(cb: ((slot: number) => void) | null) {
    this.controls.onSwitchWeapon = cb;
  }

  constructor(app: Application) {
    this.app = app;
  }

  attach() {
    // app.screen is logical (CSS) pixels — the same units wx touch coords use.
    this.controls.layout(this.app.screen.width, this.app.screen.height);

    wx.onTouchStart((e) => {
      for (const t of e.changedTouches) this.controls.pointerDown(t.identifier, t.clientX, t.clientY);
    });
    wx.onTouchMove((e) => {
      for (const t of e.changedTouches) this.controls.pointerMove(t.identifier, t.clientX, t.clientY);
    });
    const end = (e: WxTouchEvent) => {
      for (const t of e.changedTouches) this.controls.pointerUp(t.identifier);
    };
    wx.onTouchEnd(end);
    wx.onTouchCancel(end);
  }

  read(): InputState {
    return this.controls.read();
  }

  getTouchVisual(): TouchVisual {
    return this.controls.getVisual();
  }

  setControlMirror(mirrored: boolean): void {
    this.controls.setMirrored(mirrored);
  }
}
