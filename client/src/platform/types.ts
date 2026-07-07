// Platform isolation layer.
//
// The Game core (src/game) is platform-agnostic. Everything that differs between
// Web and the WeChat mini-game — canvas acquisition, the Pixi Application setup,
// input devices, lifecycle — lives behind these interfaces. See design/04-wechat.md.
import type { Application } from 'pixi.js';

// Aim is expressed two ways so both mouse and virtual-joystick controls fit the
// same Game code:
//  - 'point': a screen-space position (mouse cursor). Game converts it to world space.
//  - 'dir':   a normalized aim direction (right joystick). Game uses it as facing directly.
export type Aim =
  | { mode: 'point'; x: number; y: number }
  | { mode: 'dir'; dx: number; dy: number };

export interface InputState {
  moveX: number; // normalized movement, [-1, 1]
  moveY: number;
  aim: Aim;
  firing: boolean;
  blocking: boolean;
}

// Minimal structural view of the canvas the input source attaches to.
// On Web this is an HTMLCanvasElement; on WeChat it is the wx canvas — both expose
// width/height, and only the Web input touches the DOM event APIs (guarded).
export interface InputCanvas {
  width: number;
  height: number;
  addEventListener?: HTMLCanvasElement['addEventListener'];
  getBoundingClientRect?: () => { left: number; top: number };
}

// A swappable input device. Web = keyboard + mouse; WeChat = virtual joystick + touch.
export interface InputSource {
  onSwitchWeapon: ((slot: number) => void) | null;
  onJump: (() => void) | null;
  attach(canvas: InputCanvas): void;
  read(): InputState;
}

// A platform provides the Pixi Application (bound to its canvas) and the input device.
export interface Platform {
  createApp(): Promise<Application>;
  createInput(app: Application): InputSource;
}
