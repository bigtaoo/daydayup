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
  readFileSync(path: string): ArrayBuffer;
}

/**
 * A long-lived streaming audio player (design/04, design/11 "Music & ambience"). This — NOT
 * `createWebAudioContext` — is what music runs on here: a 69 s stereo loop decoded into an
 * `AudioBuffer` would be ~26 MB of RAM, and this runtime's own docs describe
 * `InnerAudioContext` as the streaming path.
 *
 * Only the surface `platform/wechat/weChatMusicDeck.ts` uses is declared. `volume` is the
 * whole level control: there is no audio graph here, so the music bus volume and the deck's
 * crossfade level have to be multiplied together into this one number.
 */
interface WxInnerAudioContext {
  /** A code-package path (`packs/music/audio/music/menu.mp3`) or an http(s) url. Assigning it
   *  starts loading; there is no separate `load()`. */
  src: string;
  /** Left false: the player closes the loop with a crossfade, because MP3 frame padding denies
   *  the sample-exact wrap any native looping API performs. */
  loop: boolean;
  /** 0..1. */
  volume: number;
  /** Whether the phone's mute switch silences this stream. Music: true (a player who muted
   *  their phone means it); the default is already true, set explicitly for the record. */
  obeyMuteSwitch: boolean;
  /** Seconds into the stream. Read-only, and the loop wrap is decided from it. */
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): void;
  pause(): void;
  stop(): void;
  destroy(): void;
  onError(cb: (res: { errMsg?: string; errCode?: number }) => void): void;
}

/**
 * What `wx.loadSubpackage` hands back (design/12, "Progress is per-pack, not per-byte").
 *
 * The API is real on this runtime — MEASURED 2026-09-01 in the DevTools simulator, base
 * library 3.17.1: the return value is an object, `typeof task.onProgressUpdate === 'function'`,
 * registering a handler does not throw, and the handler fires. That is why it is typed here at
 * all, and why `onProgressUpdate` is NOT optional the way `createWebAudioContext` is.
 *
 * **It is deliberately not wired to the progress bar, and the measurement is the reason.** In
 * the simulator each pack fires exactly ONE event, always `progress: 50`, with
 * `totalBytesExpectedToWrite` between 3,750 and 3,833 for every pack — for payloads that range
 * from 118 kB (`boss`) to 2.39 MB (`run`), whose generated stubs are 403 bytes. So the numbers
 * describe neither the pack nor anything else in it, never reach 100, and a bar fed them would
 * fill to half of 3.7 kB and stop. `render/packLoader.ts` therefore still counts completed
 * packs and loaders, which is honest on both platforms.
 *
 * The simulator has no real download, so this says nothing about a handset. What a device would
 * have to show for the byte-accurate bar to be worth wiring: more than one event per pack, and a
 * `totalBytesExpectedToWrite` that tracks the pack's actual size.
 */
interface WxLoadSubpackageTask {
  onProgressUpdate(
    cb: (res: {
      /** Percent complete, 0..100. */
      progress: number;
      totalBytesWritten: number;
      totalBytesExpectedToWrite: number;
    }) => void,
  ): void;
}

interface Wx {
  createCanvas(): WxCanvas;
  createImage(): WxImage;
  /** Package-file reads (design/04) — how the art loaders' JSON sidecars are read here,
   *  since a mini-game has no `fetch`. See platform/wechat/weChatAssetHost.ts. */
  getFileSystemManager(): WxFileSystemManager;
  /** Fetches and runs a subpackage declared in game.json's `subpackages` (design/04's
   *  package budget). Its files do not resolve before this succeeds. Resolved by NAME —
   *  the `root` lives in game.json, which build/wechatAssetSync.mjs generates.
   *
   *  Returns a `WxLoadSubpackageTask`. The declaration used to say `void`, because nothing
   *  here used the task and its `onProgressUpdate` had never been exercised — see that type
   *  for what it actually reports, which is why `packLoader.ts` still counts whole packs. */
  loadSubpackage(opts: {
    name: string;
    success?: () => void;
    fail?: (res: { errMsg?: string }) => void;
  }): WxLoadSubpackageTask;
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
  /** The music path (design/11). Documented on every base library this project targets, but
   *  optional here for the same reason `createWebAudioContext` is: a caller that assumes an
   *  audio API exists turns a quiet game into a boot failure. */
  createInnerAudioContext?: () => WxInnerAudioContext;
  /** System-level audio interruption — an incoming call, another app taking the session
   *  (design/11 "Focus/blur & interruption"). The web counterpart is `visibilitychange`; there
   *  is no DOM here, so this is the only signal. Optional for the same reason as above. */
  onAudioInterruptionBegin?: (cb: () => void) => void;
  onAudioInterruptionEnd?: (cb: () => void) => void;
}

declare const wx: Wx;

// weapp-adapter exposes the main canvas created by wx.createCanvas() as a global.
declare const canvas: WxCanvas | undefined;

// The mini-game global scope object.
declare const GameGlobal: Record<string, unknown> & { canvas?: WxCanvas };
