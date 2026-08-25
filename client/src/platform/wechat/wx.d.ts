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

interface WxFileSystemManager {
  /** Reads a file. A path inside the code package (`a/b/c` or `/a/b/c`, never `./a/b/c`)
   *  is readable but never writable; `wx.env.USER_DATA_PATH` is the writable area. With
   *  'utf8' the result is a string, without an encoding it is an ArrayBuffer. */
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface Wx {
  createCanvas(): WxCanvas;
  createImage(): WxImage;
  /** Package-file reads (design/04) — how the art loaders' JSON sidecars are read here,
   *  since a mini-game has no `fetch`. See platform/wechat/weChatAssetHost.ts. */
  getFileSystemManager(): WxFileSystemManager;
  /** Fetches and runs a subpackage declared in game.json's `subpackages` (design/04's
   *  package budget). Its files do not resolve before this succeeds. Resolved by NAME —
   *  the `root` lives in game.json, which build/wechatAssetSync.mjs generates. */
  loadSubpackage(opts: {
    name: string;
    success?: () => void;
    fail?: (res: { errMsg?: string }) => void;
  }): void;
  getWindowInfo(): WxWindowInfo;
  onTouchStart(cb: (e: WxTouchEvent) => void): void;
  onTouchMove(cb: (e: WxTouchEvent) => void): void;
  onTouchEnd(cb: (e: WxTouchEvent) => void): void;
  onTouchCancel(cb: (e: WxTouchEvent) => void): void;
  // Audio (design/04/11). Documented by WeChat to implement the same Web Audio API
  // surface as the browser's `AudioContext` — reused as-is (dom lib already provides
  // that type; this project's tsconfig includes it, per WebAudio.ts's existing use).
  // NOT guaranteed present on every base library (design/11 open question — "verify
  // availability on the lowest base library"); callers MUST feature-detect
  // (`typeof wx.createWebAudioContext === 'function'`) rather than assume it exists.
  createWebAudioContext?: () => AudioContext;
}

declare const wx: Wx;

// weapp-adapter exposes the main canvas created by wx.createCanvas() as a global.
declare const canvas: WxCanvas | undefined;

// The mini-game global scope object.
declare const GameGlobal: Record<string, unknown> & { canvas?: WxCanvas };
