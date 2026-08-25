// Platform seam for how shipped art is REACHED (design/04, design/12).
//
// The five art loaders (taoBundle / biomeTiles / uiSkins / environmentSprites / weaponSkins)
// used to hardcode two web-only assumptions: that an asset path is also a URL, and that
// `fetch` exists. Neither holds in a WeChat mini-game, and between them they were the whole
// reason the mini-game target rendered Graphics placeholders only.
//
// What each platform actually does:
//
//  - **PNGs need nothing here but a path rewrite.** Pixi v8's `loadTextures` parser falls
//    back to `DOMAdapter.get().createImage()` + `.src = url` whenever `globalThis
//    .createImageBitmap` is absent (see pixi.js/lib/assets/loader/parsers/textures/
//    loadTextures.mjs), which is exactly the WeChat case — and `WeChatAdapter.createImage`
//    (→ `wx.createImage()`) has been implemented all along. So the image path was never
//    blocked on `WeChatAdapter.fetch` at all, contrary to what design/ROADMAP's parked note
//    assumed. It only needed the URL to name a real file inside the package.
//  - **The JSON sidecars are the part that genuinely could not work.** `taoBundle` called
//    the GLOBAL `fetch`, which a mini-game does not have at all, and Pixi's own `loadJson`
//    goes through the adapter's `fetch`, which we deliberately keep unimplemented. WeChat
//    reads files bundled in the code package with `FileSystemManager.readFileSync` instead —
//    a different MECHANISM, not just a different path, which is why `readJson` is part of
//    this interface rather than something callers build out of `resolveUrl`.
//
// The default host is the web one, so nothing that does not opt in changes behaviour (and
// every existing test keeps passing untouched). `main.wechat.ts` installs the WeChat host
// before its first preload.
/** The subset of Pixi's `AssetInitOptions` this seam sets. Declared structurally so the
 *  interface does not drag a Pixi type into every consumer. */
export interface AssetsInitOptions {
  skipDetections?: boolean;
}

export interface AssetHost {
  /** Options for the one-time `Assets.init()` that `preloadCoreArt` runs before the first
   *  load. This is a platform difference with teeth, not a tuning knob: Pixi's default
   *  format detection calls `document.createElement('video')`
   *  (assets/detections/utils/testVideoFormat.mjs, reached from detectMp4/detectOgv/
   *  detectWebm), and a mini-game has no `document`. Left alone it throws
   *  `ReferenceError: document is not defined` inside `init()` — and because `Assets`
   *  sets its `_initialized` flag BEFORE running the detections, every other concurrent
   *  load sails past it. The symptom on device is therefore not a clean crash but ONE
   *  arbitrary texture missing, whichever load happened to be first. Found by
   *  wechatAssetLoad.test.ts on its first run, before any device saw it. */
  assetsInit: AssetsInitOptions;
  /** Rewrite a public-relative asset path ('/skins/orb-core/eye.png') into whatever this
   *  platform's image loader takes. */
  resolveUrl(path: string): string;
  /** Read and parse a JSON sidecar shipped alongside the art. */
  readJson<T>(path: string): Promise<T>;
  /** Make a subpackage's files reachable. Absent on web, where there are no subpackages and
   *  every file is simply served; on WeChat this is `wx.loadSubpackage`, and until it has
   *  resolved a path inside that pack's root names nothing. See `packLoader.ts`. */
  loadPack?(name: string, root: string): Promise<void>;
}

export const webAssetHost: AssetHost = {
  // Web keeps the detections: they are what let a webp/avif variant win where the browser
  // supports it, and every DOM probe they make is available here.
  assetsInit: {},
  resolveUrl: (path) => path,
  readJson: async <T>(path: string): Promise<T> => (await fetch(path)).json() as Promise<T>,
};

let host: AssetHost = webAssetHost;

export function setAssetHost(next: AssetHost): void {
  host = next;
}

export function getAssetHost(): AssetHost {
  return host;
}

/** Restores the web default. Exported for tests, which must not leak a fake host into the
 *  next file's module registry. */
export function resetAssetHost(): void {
  host = webAssetHost;
}

export function resolveAssetUrl(path: string): string {
  return host.resolveUrl(path);
}

export function readJsonAsset<T>(path: string): Promise<T> {
  return host.readJson<T>(path);
}
