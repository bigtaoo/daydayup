/**
 * `ensurePack`'s own logic, against a fake host — the parts `wechatAssetLoad.test.ts` cannot
 * see because there every pack loads successfully exactly once and the interesting branches
 * (a repeat call, a failing download, a name that is not a pack) never run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setAssetHost, resetAssetHost, webAssetHost, type AssetHost } from './assetHost';
import { SUBPACKS } from './assetManifest';
import { ensurePack, ensureAllPacks, resetPackLoader } from './packLoader';

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
