/**
 * biomeTiles.ts's best-effort tileable-swatch registry (design/13's "other biomes'
 * looks" pass). Same network-independent shape as uiSkins.test.ts: `getFloorTexture`/
 * `getWallTexture` return `undefined` identically for an unregistered element and a
 * registered-but-unloaded one, so `BIOME_TILE_ASSET_KEYS` is what actually proves a
 * given floor/wall swatch is wired in.
 */
import { describe, it, expect } from 'vitest';
import { preloadBiomeTiles, getFloorTexture, getWallTexture, BIOME_TILE_ASSET_KEYS } from './biomeTiles';

const ELEMENTS = ['fire', 'ice', 'lightning', 'neutral'] as const;

describe('biomeTiles — asset registry', () => {
  it('has a floor and a wall key for every non-poison element', () => {
    for (const el of ELEMENTS) {
      expect(BIOME_TILE_ASSET_KEYS).toContain(`floor_${el}`);
      expect(BIOME_TILE_ASSET_KEYS).toContain(`wall_${el}`);
    }
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

  it('deliberately has no poison swatch yet (design/13: poison is not floor 1)', () => {
    expect(BIOME_TILE_ASSET_KEYS).not.toContain('floor_poison');
    expect(BIOME_TILE_ASSET_KEYS).not.toContain('wall_poison');
  });

  it('getFloorTexture/getWallTexture return undefined for an element with no swatch (poison)', () => {
    expect(getFloorTexture('poison')).toBeUndefined();
    expect(getWallTexture('poison')).toBeUndefined();
  });
});

describe('biomeTiles — preloadBiomeTiles never throws (missing/unreachable art must not block boot)', () => {
  it('resolves cleanly even though no asset server exists in this test environment', async () => {
    await expect(preloadBiomeTiles()).resolves.toBeUndefined();
    for (const el of ELEMENTS) {
      expect(getFloorTexture(el)).toBeUndefined();
      expect(getWallTexture(el)).toBeUndefined();
    }
  });
});
