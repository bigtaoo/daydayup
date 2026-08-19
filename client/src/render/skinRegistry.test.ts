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

import { preloadRigSkin, getRigSkin, BODY_FILL, BODY_FILL_DEFAULT } from './skinRegistry';

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

// `bodyFill` on the loaded entry (2026-08-19 volume pass). This is the seam that carries the
// measured "how much of its declared radius does this bundle's art actually paint" number from
// the table to `Skin`/`RigSkin`/`Actor`. `rigComposition.test.ts` is what pins the table itself
// against the real pixels; this pins the plumbing, which is where a silent 1.0 would come from.
describe('preloadRigSkin — the measured body fill travels with the bundle', () => {
  it('registers the skin\'s own BODY_FILL entry, not one shared per rig', async () => {
    // The three orb-core characters share a Rig but NOT a fill: their shells paint 0.81, 0.69 and
    // 0.87 of the same declared radius. A per-rig lookup would give all three the same shadow.
    mocks.loadRigSkinBundle.mockResolvedValue({ bindings: new Map(), clips: new Map(), textures: new Map() });
    await preloadRigSkin('char_vanguard', '/skins/orb-core');
    await preloadRigSkin('char_skirmisher', '/skins/skirmisher-core');
    expect(getRigSkin('char_vanguard')!.bodyFill).toBe(BODY_FILL.char_vanguard);
    expect(getRigSkin('char_skirmisher')!.bodyFill).toBe(BODY_FILL.char_skirmisher);
    expect(getRigSkin('char_vanguard')!.bodyFill).not.toBe(getRigSkin('char_skirmisher')!.bodyFill);
  });

  it('falls back to the conservative default for a registered rig with no measured entry', async () => {
    // A shadow slightly too big is a look note; a missing one is a character that floats. So the
    // fallback direction is deliberate, and this is the guard on it staying that way.
    const table = BODY_FILL as Record<string, number | undefined>;
    const saved = table['boss-core'];
    try {
      delete table['boss-core'];
      mocks.loadRigSkinBundle.mockResolvedValue({ bindings: new Map(), clips: new Map(), textures: new Map() });
      await preloadRigSkin('boss-core', '/skins/boss-core');
      expect(getRigSkin('boss-core')!.bodyFill).toBe(BODY_FILL_DEFAULT);
    } finally {
      table['boss-core'] = saved;
    }
  });

  it('never carries a fill above 1 — art wider than its own bodyR is a rig bug, not a fill', async () => {
    mocks.loadRigSkinBundle.mockResolvedValue({ bindings: new Map(), clips: new Map(), textures: new Map() });
    for (const name of Object.keys(BODY_FILL)) {
      await preloadRigSkin(name, `/skins/${name}`);
      const fill = getRigSkin(name)!.bodyFill;
      expect(fill).toBeGreaterThan(0);
      expect(fill).toBeLessThanOrEqual(1);
    }
  });
});
