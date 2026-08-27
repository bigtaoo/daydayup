// The WeChat half of render/assetHost.ts — see that file for why the seam exists and why
// images and JSON take different routes here.
//
// Images: nothing to do but rewrite the path. Pixi hands the URL to
// `DOMAdapter.get().createImage()` (→ `wx.createImage()`), whose `src` accepts a path
// relative to the code-package root, so the only change from the web form is dropping the
// leading slash — `packedPathFor` does that, and will also prepend a subpackage root if a
// pack is ever split out (render/assetPacks.json).
//
// Subpackages: `wx.loadSubpackage` is callback-shaped, so it is wrapped into a promise here.
// The `root` is not passed to it — WeChat resolves a subpackage by NAME, from the
// `subpackages` entry the build writes into game.json — but it stays in the signature
// because it is what `packedPathFor` uses, and the two must describe the same directory.
//
// JSON: a mini-game has no `fetch`. Files bundled in the code package are read with
// `FileSystemManager.readFileSync`, which the docs allow for package paths (and only for
// package paths — they are read-only at runtime). It is synchronous; the async signature is
// the interface's, so that the web side can stay a real network call.
import { packedPathFor } from '../../render/assetManifest';
import type { AssetHost } from '../../render/assetHost';

export const weChatAssetHost: AssetHost = {
  // Skip Pixi's format detection — it probes for video support through
  // `document.createElement`, which does not exist here. See AssetHost.assetsInit.
  assetsInit: { skipDetections: true },
  resolveUrl: (path) => packedPathFor(path),
  readJson: async <T>(path: string): Promise<T> => {
    const packed = packedPathFor(path);
    const text = wx.getFileSystemManager().readFileSync(packed, 'utf8');
    if (typeof text !== 'string') {
      // readFileSync returns an ArrayBuffer when no encoding is honoured. Failing loudly
      // beats JSON.parse's less legible error, and this is the one branch that would
      // differ between base-library versions.
      throw new Error(`readFileSync('${packed}', 'utf8') did not return a string`);
    }
    return JSON.parse(text) as T;
  },
  // Same call, no encoding — the docs' other documented return type. Synchronous like
  // `readJson`, and for the same reason: the async signature belongs to the interface so the
  // web side can stay a real network call.
  readBinary: async (path: string): Promise<ArrayBuffer> => {
    const packed = packedPathFor(path);
    const bytes = wx.getFileSystemManager().readFileSync(packed);
    if (typeof bytes === 'string') {
      throw new Error(`readFileSync('${packed}') returned a string, not an ArrayBuffer`);
    }
    return bytes;
  },
  loadPack: (name: string, _root: string): Promise<void> =>
    new Promise((resolve, reject) => {
      wx.loadSubpackage({
        name,
        success: () => resolve(),
        fail: (res) => reject(new Error(`wx.loadSubpackage('${name}') failed: ${res?.errMsg ?? 'unknown'}`)),
      });
    }),
};
