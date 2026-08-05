/**
 * taoBundle.loadRigSkinBundle fetches animation.json + frames.json (raw `fetch`,
 * not Pixi's Assets) and then Assets.load's one texture per (slot, variant) pair.
 * Both are stubbed here: `fetch` via `vi.stubGlobal` (this repo's existing
 * convention for a browser-only global — WebAudio.test.ts/WebInput.test.ts), and
 * `pixi.js`'s `Assets.load` via a partial `vi.mock('pixi.js', importOriginal)` so
 * the loader resolves deterministically instead of racing a real (always-failing,
 * per weaponSkins.test.ts/uiSkins.test.ts) network call. `deserializeClip` isn't
 * exported, so its Map-conversion is pinned indirectly through the returned
 * bundle's `clips`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ assetsLoad: vi.fn() }));
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  return { ...actual, Assets: { ...actual.Assets, load: mocks.assetsLoad } };
});

import { loadRigSkinBundle } from './taoBundle';

const ANIMATION_JSON = {
  version: 1,
  bindings: {
    shell: { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    eye: { anchorX: 0.5, anchorY: 0.5, flipX: false, zOrder: 1, rotation: 0, scaleX: 1, scaleY: 1 },
  },
  animations: {
    idle: {
      duration: 1.5,
      loop: true,
      keyframes: [
        { time: 0, bones: { shell: { rotation: 0 } } },
        { time: 1, bones: { shell: { rotation: 10 }, eye: { alpha: 0.5 } } },
      ],
    },
  },
};

const FRAMES_JSON: Record<string, string[]> = {
  shell: ['default'],
  eye: ['default', 'back'], // slot with a front/back variant swap
};

function fakeFetch() {
  return vi.fn(async (input: string) => ({
    json: async () => {
      if (input.endsWith('/animation.json')) return ANIMATION_JSON;
      if (input.endsWith('/frames.json')) return FRAMES_JSON;
      throw new Error(`unexpected fetch: ${input}`);
    },
  }));
}

beforeEach(() => {
  mocks.assetsLoad.mockReset();
  mocks.assetsLoad.mockImplementation(async (url: string) => ({ __url: url }));
});

describe('loadRigSkinBundle', () => {
  it('fetches animation.json + frames.json from baseUrl', async () => {
    const fetchMock = fakeFetch();
    vi.stubGlobal('fetch', fetchMock);
    await loadRigSkinBundle('/skins/orb-core');
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toContain('/skins/orb-core/animation.json');
    expect(urls).toContain('/skins/orb-core/frames.json');
  });

  it('converts bindings to a Map keyed by bone id, verbatim from the JSON', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    const bundle = await loadRigSkinBundle('/skins/orb-core');
    expect(bundle.bindings).toEqual(new Map(Object.entries(ANIMATION_JSON.bindings)));
  });

  it('deserializeClip: converts each keyframe\'s bones object into a Map, keeping duration/loop/time', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    const bundle = await loadRigSkinBundle('/skins/orb-core');
    const idle = bundle.clips.get('idle')!;
    expect(idle.duration).toBe(1.5);
    expect(idle.loop).toBe(true);
    expect(idle.keyframes).toHaveLength(2);
    expect(idle.keyframes[0]!.time).toBe(0);
    expect(idle.keyframes[0]!.bones).toEqual(new Map([['shell', { rotation: 0 }]]));
    expect(idle.keyframes[1]!.bones).toEqual(
      new Map([
        ['shell', { rotation: 10 }],
        ['eye', { alpha: 0.5 }],
      ]),
    );
  });

  it('loads one texture per default frame, keyed by slotId alone', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    const bundle = await loadRigSkinBundle('/skins/orb-core');
    expect(mocks.assetsLoad).toHaveBeenCalledWith('/skins/orb-core/shell.png');
    expect(bundle.textures.get('shell')).toEqual({ __url: '/skins/orb-core/shell.png' });
  });

  it('loads a non-default variant keyed as "<slotId>__<variantId>" (e.g. eye\'s back swap)', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    const bundle = await loadRigSkinBundle('/skins/orb-core');
    expect(mocks.assetsLoad).toHaveBeenCalledWith('/skins/orb-core/eye.png'); // default
    expect(mocks.assetsLoad).toHaveBeenCalledWith('/skins/orb-core/eye__back.png'); // variant
    expect(bundle.textures.get('eye')).toEqual({ __url: '/skins/orb-core/eye.png' });
    expect(bundle.textures.get('eye__back')).toEqual({ __url: '/skins/orb-core/eye__back.png' });
  });

  it('a fetch rejection propagates (no best-effort fallback — an art bundle either loads or the caller sees the error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    await expect(loadRigSkinBundle('/skins/broken')).rejects.toThrow('fetch failed');
  });
});
