/**
 * biomeTiles.ts's best-effort tileable-swatch registry (design/13's "other biomes'
 * looks" pass). Same network-independent shape as uiSkins.test.ts: `getFloorTexture`/
 * `getWallTexture` return `undefined` identically for an unregistered element and a
 * registered-but-unloaded one, so `BIOME_TILE_ASSET_KEYS` is what actually proves a
 * given floor/wall swatch is wired in.
 */
import { describe, it, expect } from 'vitest';
import { preloadBiomeTiles, getFloorTexture, getWallTexture, BIOME_TILE_ASSET_KEYS } from './biomeTiles';

/** Every `BiomeElement`, i.e. design/13's locked five. Was four until 2026-08-25: poison had
 *  no registry entry at all, so there was no path from a poison biome to a swatch even in
 *  principle. */
const ELEMENTS = ['fire', 'ice', 'lightning', 'neutral', 'poison'] as const;
/** The four whose swatch files actually ship today. */
const WITH_ART = ['fire', 'ice', 'lightning', 'neutral'] as const;

describe('biomeTiles — asset registry', () => {
  it('has a floor, wall and wall-face key for EVERY element the colour law closes over', () => {
    for (const el of ELEMENTS) {
      expect(BIOME_TILE_ASSET_KEYS).toContain(`floor_${el}`);
      expect(BIOME_TILE_ASSET_KEYS).toContain(`wall_${el}`);
      expect(BIOME_TILE_ASSET_KEYS).toContain(`wallface_${el}`);
    }
  });

  it('covers exactly the five, with no sixth element smuggled in', () => {
    const swatchElements = new Set(
      BIOME_TILE_ASSET_KEYS.filter((k) => k.startsWith('floor_')).map((k) => k.slice('floor_'.length)),
    );
    expect([...swatchElements].sort()).toEqual([...ELEMENTS].sort());
  });

  it('has the pillar SPRITE key — one file for every biome, the hue arriving as a tint', () => {
    // Not one per element like the swatches above: a pillar is a fixed-size object drawn from
    // art authored at pillar scale, and `pillarRender.pillarTint` is what makes an ember room's
    // pillar differ from a neutral one. A per-element file drops in by adding a key.
    expect(BIOME_TILE_ASSET_KEYS).toContain('pillar_neutral');
    for (const el of ELEMENTS.filter((e) => e !== 'neutral')) {
      expect(BIOME_TILE_ASSET_KEYS).not.toContain(`pillar_${el}`);
    }
  });

  it('a registered key whose file does not exist yet still resolves to undefined, not a throw', () => {
    // The whole reason poison could be REGISTERED before its art was generated (2026-08-25):
    // registration and availability are separate, and the unavailable case is the same
    // flat-palette fallback `RoomBuilder` has always had. Previously this file asserted the
    // opposite — that no poison key existed — which pinned the gap as an invariant and would
    // have failed the moment the gap was closed.
    expect(getFloorTexture('poison')).toBeUndefined();
    expect(getWallTexture('poison')).toBeUndefined();
  });
});

describe('biomeTiles — preloadBiomeTiles never throws (missing/unreachable art must not block boot)', () => {
  it('resolves cleanly even though no asset server exists in this test environment', async () => {
    await expect(preloadBiomeTiles()).resolves.toBeUndefined();
    for (const el of WITH_ART) {
      expect(getFloorTexture(el)).toBeUndefined();
      expect(getWallTexture(el)).toBeUndefined();
    }
  });
});
