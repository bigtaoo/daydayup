/**
 * environmentSprites.ts's door-fixture registry (design/05 "Room & door model",
 * 2026-08-04). Same "no asset server in this test environment" convention as
 * biomeTiles.test.ts: every `Assets.load` call genuinely rejects here, which is exactly
 * what proves `preloadEnvironmentSprites()` is best-effort (RoomBuilder's flat-tint
 * fallback covers an unloaded door the same way it already covers an unloaded floor/wall
 * swatch) rather than one failed load aborting the whole preload.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  preloadEnvironmentSprites,
  getDoorTexture,
  getPickupTexture,
  getPortalArchTexture,
  ENV_SPRITE_ASSET_KEYS,
} from './environmentSprites';

describe('environmentSprites — getDoorTexture before any preload', () => {
  it('returns undefined for both lock states (RoomBuilder falls back to a flat tint)', () => {
    expect(getDoorTexture(true)).toBeUndefined();
    expect(getDoorTexture(false)).toBeUndefined();
  });
});

describe('environmentSprites — preloadEnvironmentSprites never throws (missing/unreachable art must not block boot)', () => {
  it('resolves cleanly even though no asset server exists in this test environment', async () => {
    await expect(preloadEnvironmentSprites()).resolves.toBeUndefined();
    expect(getDoorTexture(true)).toBeUndefined();
    expect(getDoorTexture(false)).toBeUndefined();
  });
});

describe('environmentSprites — every key a caller can ask for is actually registered', () => {
  // The getters return `undefined` identically for "not loaded yet" and "no such key", so a
  // typo in the asset table is invisible at run time: the drop just keeps drawing its
  // Graphics fallback forever, which looks like art that was never generated. Same guard
  // biomeTiles.test.ts keeps over BIOME_TILE_ASSET_KEYS.
  it.each(['material', 'heal', 'buff', 'crate', 'bandage'])('pickup_%s has a file', (kind) => {
    expect(ENV_SPRITE_ASSET_KEYS).toContain(`pickup_${kind}`);
  });

  it('registers the two door states and the portal arch', () => {
    expect(ENV_SPRITE_ASSET_KEYS).toContain('door_locked');
    expect(ENV_SPRITE_ASSET_KEYS).toContain('door_open');
    expect(ENV_SPRITE_ASSET_KEYS).toContain('portal_arch');
  });

  it('deliberately has NO pickup_weapon', () => {
    // A weapon drop draws that weapon's own business-end art (render/weaponSkins.ts) so it
    // reads as "that specific gun". A generic file here would quietly shadow it.
    expect(ENV_SPRITE_ASSET_KEYS).not.toContain('pickup_weapon');
  });

  it('every registered key points at a distinct real path under /environment/', () => {
    const paths = new Set(ENV_SPRITE_ASSET_KEYS);
    expect(paths.size).toBe(ENV_SPRITE_ASSET_KEYS.length);
  });
});

describe('environmentSprites — the getters before any preload', () => {
  it('returns undefined for every drop kind and for the arch', () => {
    for (const kind of ['material', 'heal', 'buff', 'crate', 'bandage', 'weapon']) {
      expect(getPickupTexture(kind)).toBeUndefined();
    }
    expect(getPortalArchTexture()).toBeUndefined();
  });
});

describe('environmentSprites — every texture is loaded WITH a mip chain', () => {
  it('asks for autoGenerateMipmaps on all of them, and never for repeat addressing', async () => {
    // A drop's 192px source lands at ~18px on screen — a 10:1 minification, worse than the
    // 4:1 that made the pillar sprite need this and worse than the ~96:1 that produced the
    // 2026-08-12 rig-art colour-noise bug. The flag has to be passed at LOAD time: setting
    // it on an already-uploaded GPU texture provably does nothing. `repeat` would be wrong
    // for every file here (a lone object's edge would sample its own far side), so its
    // absence is asserted too rather than left to chance.
    const calls: unknown[] = [];
    const pixi = await import('pixi.js');
    const spy = vi.spyOn(pixi.Assets, 'load').mockImplementation(async (opts: unknown) => {
      calls.push(opts);
      throw new Error('no asset server in this test environment');
    });
    try {
      await preloadEnvironmentSprites();
    } finally {
      spy.mockRestore();
    }
    expect(calls.length).toBe(ENV_SPRITE_ASSET_KEYS.length);
    for (const call of calls) {
      const opt = call as { src?: string; data?: Record<string, unknown> };
      expect(opt.src).toMatch(/^\/environment\/.+\.png$/);
      expect(opt.data?.autoGenerateMipmaps).toBe(true);
      expect(opt.data?.addressMode).toBeUndefined();
    }
  });
});
