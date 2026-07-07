// Minimal ambient typings for the WeChat mini-game runtime.
//
// Only the surface this project actually uses is declared here. The full API is
// provided at runtime by the WeChat base library; for complete types install
// `minigame-api-typings` in the WeChat project. Pixi's DOM needs are met by our own
// WeChatAdapter (Pixi DOMAdapter), not weapp-adapter — see design/04-wechat.md.

interface WxTouch {
  clientX: number;
  clientY: number;
  identifier: number;
}

interface WxTouchEvent {
  touches: WxTouch[];
  changedTouches: WxTouch[];
}

interface WxWindowInfo {
  windowWidth: number;
  windowHeight: number;
  pixelRatio: number;
}

interface WxCanvas {
  width: number;
  height: number;
  getContext(type: string, attrs?: unknown): unknown;
}

interface WxImage {
  src: string;
  width: number;
  height: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface Wx {
  createCanvas(): WxCanvas;
  createImage(): WxImage;
  getWindowInfo(): WxWindowInfo;
  onTouchStart(cb: (e: WxTouchEvent) => void): void;
  onTouchMove(cb: (e: WxTouchEvent) => void): void;
  onTouchEnd(cb: (e: WxTouchEvent) => void): void;
  onTouchCancel(cb: (e: WxTouchEvent) => void): void;
}

declare const wx: Wx;

// weapp-adapter exposes the main canvas created by wx.createCanvas() as a global.
declare const canvas: WxCanvas | undefined;

// The mini-game global scope object.
declare const GameGlobal: Record<string, unknown> & { canvas?: WxCanvas };
