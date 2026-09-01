// A WeChat-SHAPED runtime for tests, backed by the real shipped files (design/04, design/12).
//
// Extracted from `wechatAssetLoad.test.ts` when a second file needed the same runtime: that one
// drives the all-at-once `preloadCoreArt()`, `wechatPhasedBoot.test.ts` drives the two-phase
// boot the entry point actually uses. Same precedent as `game/screens/fakeTextCanvas.ts` — a
// shared shim in `src/`, not a test file, because two `.test.ts` files cannot borrow each
// other's `beforeAll`.
//
// The ONLY fake is `wx`. Everything above it is the real thing: the real Pixi `Assets`, the real
// `WeChatAdapter`, the real `weChatAssetHost`, the real loaders. The browser globals a mini-game
// does not have are REMOVED rather than merely unused — `fetch` in particular exists in Node, so
// a loader that still called it would pass a naive version of this harness while crashing on a
// device.
//
// Two rules the fake enforces because they are what the tests are about:
//
//  1. **A file inside a subpackage does not exist until that subpackage has been loaded.**
//     Without this the pack ordering would be untested — every asset would resolve either way
//     and `ensurePacks` could be deleted with the suite still green.
//  2. **Image dimensions come from the real file's IHDR**, so a re-encoded texture cannot drift
//     past a scale calculation that was calibrated against the old size.
//
// What it CANNOT pin, and what still needs the simulator or a device (design/04's checklist):
// that the real base library's `wx.createImage()` populates `width`/`height` before `onload` the
// way this does, that `FileSystemManager.readFileSync` behaves the same on the lowest base
// library, and anything about the GL upload of a wx Image.
import { existsSync, readFileSync } from 'node:fs';
import { DOMAdapter } from 'pixi.js';
import { WeChatAdapter } from '../platform/wechat/WeChatAdapter';
import { weChatAssetHost } from '../platform/wechat/weChatAssetHost';
import { resetAssetHost, setAssetHost } from './assetHost';
import { PACKS, SUBPACKS } from './assetManifest';
import { resetPackLoader } from './packLoader';

/** The shipped art tree, as a URL base — the same directory the byte gate weighs. */
export const PUBLIC = new URL('../../public/', import.meta.url);

/** Browser globals a mini-game does not have. Removed for the duration of the fake. */
const ABSENT_GLOBALS = ['fetch', 'createImageBitmap', 'document', 'window', 'Image', 'XMLHttpRequest'] as const;

/** Undo `packedPathFor`: map a code-package path back to the file on disk it must name.
 *  Derived from the same pack table the runtime uses, so a new subpackage root is followed
 *  automatically rather than hardcoded. */
export function diskPathFor(packed: string): URL {
  const roots = PACKS.map((p) => p.root).filter((r) => r !== '').sort((a, b) => b.length - a.length);
  const root = roots.find((r) => packed.startsWith(`${r}/`));
  return new URL(root ? packed.slice(root.length + 1) : packed, PUBLIC);
}

export interface WeChatRuntimeFake {
  /** Paths handed to `wx.createImage().src`, in order, duplicates kept. */
  readonly imageRequests: string[];
  /** Paths read through `FileSystemManager.readFileSync`, in order. */
  readonly jsonRequests: string[];
  /** Subpackages `wx.loadSubpackage` was called for, in order, with duplicates kept — the
   *  memoisation in packLoader.ts is only meaningful if a repeat would show up here. */
  readonly packLoads: string[];
  /** Restore the real globals, drop the fake, reset the host and the pack memo. */
  restore(): void;
}

interface FakeImage {
  src: string;
  width: number;
  height: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

export function installWeChatRuntimeFake(): WeChatRuntimeFake {
  const imageRequests: string[] = [];
  const jsonRequests: string[] = [];
  const packLoads: string[] = [];

  const unloadedPackFor = (packed: string): string | undefined =>
    SUBPACKS.find((p) => packed.startsWith(`${p.root}/`) && !packLoads.includes(p.name))?.name;

  const makeFakeImage = (): FakeImage => {
    const img: FakeImage = { src: '', width: 0, height: 0, onload: null, onerror: null };
    return new Proxy(img, {
      set(target, prop, value) {
        if (prop !== 'src') return Reflect.set(target, prop, value);
        const packed = String(value);
        imageRequests.push(packed);
        const disk = diskPathFor(packed);
        if (unloadedPackFor(packed) || !existsSync(disk)) {
          // Same shape as the device: a missing package file is an onerror, not a throw.
          queueMicrotask(() => target.onerror?.());
          target.src = packed;
          return true;
        }
        const buf = readFileSync(disk);
        target.width = buf.readUInt32BE(16);
        target.height = buf.readUInt32BE(20);
        target.src = packed;
        queueMicrotask(() => target.onload?.());
        return true;
      },
    });
  };

  const originals: Record<string, unknown> = {};
  for (const name of ABSENT_GLOBALS) {
    originals[name] = (globalThis as Record<string, unknown>)[name];
    delete (globalThis as Record<string, unknown>)[name];
  }

  (globalThis as Record<string, unknown>).wx = {
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({}) }),
    createImage: () => makeFakeImage(),
    getFileSystemManager: () => ({
      readFileSync: (path: string, encoding?: string) => {
        // Thrown rather than asserted: this shim must not depend on a test framework.
        if (encoding !== 'utf8') throw new Error(`readFileSync('${path}') without utf8 encoding`);
        jsonRequests.push(path);
        const pending = unloadedPackFor(path);
        if (pending) throw new Error(`readFileSync before wx.loadSubpackage('${pending}')`);
        return readFileSync(diskPathFor(path), 'utf8');
      },
    }),
    loadSubpackage: ({ name, success }: { name: string; success?: () => void }) => {
      packLoads.push(name);
      queueMicrotask(() => success?.());
    },
  };

  DOMAdapter.set(WeChatAdapter);
  setAssetHost(weChatAssetHost);

  return {
    imageRequests,
    jsonRequests,
    packLoads,
    restore() {
      for (const [name, value] of Object.entries(originals)) {
        if (value !== undefined) (globalThis as Record<string, unknown>)[name] = value;
      }
      delete (globalThis as Record<string, unknown>).wx;
      resetAssetHost();
      resetPackLoader();
    },
  };
}
