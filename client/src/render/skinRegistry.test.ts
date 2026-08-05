/**
 * skinRegistry — preload-at-boot, hand-out-synchronously-forever-after (design/12).
 * Unlike weaponSkins.ts/uiSkins.ts's best-effort convention (per-item try/catch,
 * never rejects), this module is NOT best-effort: `preloadRigSkin` rejects outright
 * for an unregistered RigDef name (never even calling `loadRigSkinBundle`), and does
 * NOT swallow a `loadRigSkinBundle` rejection either — pinning both explicitly here.
 * `loadRigSkinBundle` is mocked (same `vi.hoisted` + `vi.mock` convention as
 * Pickup.test.ts) so this file never needs a real network fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ loadRigSkinBundle: vi.fn() }));
vi.mock('./taoBundle', () => ({ loadRigSkinBundle: mocks.loadRigSkinBundle }));

import { preloadRigSkin, getRigSkin } from './skinRegistry';

beforeEach(() => {
  mocks.loadRigSkinBundle.mockReset();
});

describe('getRigSkin', () => {
  it('returns undefined for a name that was never preloaded', () => {
    expect(getRigSkin('never-preloaded-xyz')).toBeUndefined();
  });
});

describe('preloadRigSkin — unregistered RigDef name', () => {
  it('rejects immediately with a diagnostic message, WITHOUT calling loadRigSkinBundle at all', async () => {
    await expect(preloadRigSkin('not-a-real-skin', '/skins/x')).rejects.toThrow(
      "No RigDef registered for skin 'not-a-real-skin'",
    );
    expect(mocks.loadRigSkinBundle).not.toHaveBeenCalled();
  });

  it('never registers anything for the bad name — getRigSkin keeps returning undefined', async () => {
    await expect(preloadRigSkin('also-not-real', '/skins/x')).rejects.toThrow();
    expect(getRigSkin('also-not-real')).toBeUndefined();
  });
});

describe('preloadRigSkin — loadRigSkinBundle rejection is NOT swallowed', () => {
  it('propagates the underlying rejection unchanged (no best-effort fallback like weaponSkins/uiSkins)', async () => {
    mocks.loadRigSkinBundle.mockRejectedValueOnce(new Error('network down'));
    await expect(preloadRigSkin('char_vanguard', '/skins/vanguard')).rejects.toThrow('network down');
    // And it never registered a half-loaded entry.
    expect(getRigSkin('char_vanguard')).toBeUndefined();
  });
});

describe('preloadRigSkin — success path', () => {
  it('resolves the RigDef, calls loadRigSkinBundle with baseUrl, and registers rig+bundle+referenceRadius', async () => {
    const bundle = { bindings: new Map(), clips: new Map(), textures: new Map() };
    mocks.loadRigSkinBundle.mockResolvedValueOnce(bundle);

    await preloadRigSkin('char_skirmisher', '/skins/skirmisher');

    expect(mocks.loadRigSkinBundle).toHaveBeenCalledWith('/skins/skirmisher');
    const loaded = getRigSkin('char_skirmisher');
    expect(loaded).toBeDefined();
    expect(loaded!.bundle).toBe(bundle);
    expect(loaded!.referenceRadius).toBe(40); // ORB_CORE_REFERENCE_RADIUS
  });

  it('two orb-core characters (char_vanguard/char_juggernaut) share the SAME Rig instance, one rig per body archetype', async () => {
    mocks.loadRigSkinBundle.mockResolvedValue({ bindings: new Map(), clips: new Map(), textures: new Map() });
    await preloadRigSkin('char_vanguard', '/skins/a');
    await preloadRigSkin('char_juggernaut', '/skins/b');
    expect(getRigSkin('char_vanguard')!.rig).toBe(getRigSkin('char_juggernaut')!.rig);
  });
});
