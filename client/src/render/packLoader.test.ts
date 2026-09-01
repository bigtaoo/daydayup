/**
 * `ensurePack`'s own logic, against a fake host — the parts `wechatAssetLoad.test.ts` cannot
 * see because there every pack loads successfully exactly once and the interesting branches
 * (a repeat call, a failing download, a name that is not a pack) never run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setAssetHost, resetAssetHost, webAssetHost, type AssetHost } from './assetHost';
import { SUBPACKS } from './assetManifest';
import { ensurePack, ensurePacks, ensureAllPacks, resetPackLoader } from './packLoader';
import { packsForPhase } from './assetManifest';

function hostWith(loadPack: AssetHost['loadPack']): AssetHost {
  return { ...webAssetHost, loadPack };
}

beforeEach(() => resetPackLoader());
afterEach(() => {
  resetAssetHost();
  resetPackLoader();
});

describe('ensurePack', () => {
  it('asks the host once per pack however many callers there are', async () => {
    const calls: string[] = [];
    setAssetHost(hostWith(async (name) => { calls.push(name); }));
    const name = SUBPACKS[0]!.name;
    // Concurrent AND sequential: the memo has to be the promise, not a done-flag set after
    // the await, or two rooms entering on the same frame each start a download.
    await Promise.all([ensurePack(name), ensurePack(name), ensurePack(name)]);
    await ensurePack(name);
    expect(calls).toEqual([name]);
  });

  it('passes the pack root through, so the host and the manifest describe one directory', async () => {
    const seen: Array<[string, string]> = [];
    setAssetHost(hostWith(async (name, root) => { seen.push([name, root]); }));
    await ensurePack(SUBPACKS[0]!.name);
    expect(seen).toEqual([[SUBPACKS[0]!.name, SUBPACKS[0]!.root]]);
  });

  it('resolves without asking the host at all for a name that is not a subpackage', async () => {
    const loadPack = vi.fn(async () => {});
    setAssetHost(hostWith(loadPack));
    // 'main' is a real pack but never a subpackage; 'typo' is neither. Both are main-package
    // content as far as this is concerned, and neither may throw — on WeChat a boot failure
    // has no reload button behind it.
    await expect(ensurePack('main')).resolves.toBeUndefined();
    await expect(ensurePack('no-such-pack')).resolves.toBeUndefined();
    expect(loadPack).not.toHaveBeenCalled();
  });

  it('resolves when the host has no loadPack at all (the web case)', async () => {
    setAssetHost(webAssetHost);
    expect(webAssetHost.loadPack).toBeUndefined();
    await expect(ensurePack(SUBPACKS[0]!.name)).resolves.toBeUndefined();
  });

  it('swallows a failed download and warns, rather than failing boot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setAssetHost(hostWith(async () => { throw new Error('network is down'); }));
    await expect(ensurePack(SUBPACKS[0]!.name)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(SUBPACKS[0]!.name);
    warn.mockRestore();
  });

  it('does not retry a pack that already failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadPack = vi.fn(async () => { throw new Error('nope'); });
    setAssetHost(hostWith(loadPack));
    await ensurePack(SUBPACKS[0]!.name);
    await ensurePack(SUBPACKS[0]!.name);
    // A rejected download is cached like a successful one. Deliberate: the consumers all have
    // a working fallback, and a retry loop on every room entry would be worse than the gap.
    expect(loadPack).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('ensurePacks', () => {
  it('ticks once per pack, including for one that failed to download', async () => {
    // The progress screen's bar is driven by these ticks (design/12). A failed download must
    // still tick, or a dead subpackage leaves the bar short of the end forever while the gate
    // it belongs to has in fact already opened.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const packs = packsForPhase('run');
    setAssetHost(hostWith(async (name) => {
      if (name === packs[0]!.name) throw new Error('network is down');
    }));
    let ticks = 0;
    await ensurePacks(packs, () => { ticks++; });
    expect(packs.length).toBeGreaterThan(1); // otherwise "including one that failed" is the only case
    expect(ticks).toBe(packs.length);
    warn.mockRestore();
  });

  it('ticks nothing extra for a pack that was already in flight', async () => {
    // The background kick and the gate ask for the same packs; the memo is on the promise, so
    // the second caller gets one tick per pack and not one per REQUEST.
    setAssetHost(hostWith(async () => {}));
    const packs = packsForPhase('run');
    await ensurePacks(packs);
    let ticks = 0;
    await ensurePacks(packs, () => { ticks++; });
    expect(ticks).toBe(packs.length);
  });

  it('accepts an empty list without waiting on anything', async () => {
    const loadPack = vi.fn(async () => {});
    setAssetHost(hostWith(loadPack));
    await expect(ensurePacks([])).resolves.toBeUndefined();
    expect(loadPack).not.toHaveBeenCalled();
  });
});

describe('ensureAllPacks', () => {
  it('covers every declared subpackage', async () => {
    const calls: string[] = [];
    setAssetHost(hostWith(async (name) => { calls.push(name); }));
    await ensureAllPacks();
    expect(calls.sort()).toEqual(SUBPACKS.map((p) => p.name).sort());
  });

  it('found subpackages to load at all', () => {
    // Guards every assertion above: with an empty SUBPACKS list they would all pass vacuously,
    // which is exactly what a botched assetPacks.json edit would produce.
    expect(SUBPACKS.length).toBeGreaterThanOrEqual(4);
  });
});
