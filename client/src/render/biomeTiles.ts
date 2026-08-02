// Tileable floor/wall swatches for the biome-specific art pass (design/13's still-open
// "other biomes' looks" — the room ground/walls were code-only palette tints until
// now, see game/config.ts's biomePalette()). Same non-blocking best-effort preload
// pattern as uiSkins.ts/weaponSkins.ts: a missing/not-yet-generated swatch just leaves
// RoomBuilder on its existing flat-colour fallback, never blocks boot.
//
// Keyed by BiomeElement (game/config.ts), not by DungeonConfig.biomeId — a biome's
// LOOK is one swatch per element, reused by every biome that shares that element
// (mirrors how biomePalette() already works). 'poison' has no swatch yet (design/13:
// poison isn't floor 1 and has no dedicated critter either) — RoomBuilder's fallback
// covers it until one is generated.
import { Assets, Texture } from 'pixi.js';
import type { BiomeElement } from '../game/theme';

const BIOME_TILE_ASSETS: Readonly<Record<string, string>> = {
  floor_fire: '/biome/floor_fire.png',
  floor_ice: '/biome/floor_ice.png',
  floor_lightning: '/biome/floor_lightning.png',
  floor_neutral: '/biome/floor_neutral.png',
  wall_fire: '/biome/wall_fire.png',
  wall_ice: '/biome/wall_ice.png',
  wall_lightning: '/biome/wall_lightning.png',
  wall_neutral: '/biome/wall_neutral.png',
};

const textures = new Map<string, Texture>();

/** Every key `getFloorTexture`/`getWallTexture` can resolve once preloaded — exposed
 * so tests can assert a key is actually registered, since the getters return
 * `undefined` identically for both a missing key and a registered key whose file
 * hasn't loaded (network-independent by design, same shape as uiSkins.ts). */
export const BIOME_TILE_ASSET_KEYS: readonly string[] = Object.keys(BIOME_TILE_ASSETS);

export async function preloadBiomeTiles(): Promise<void> {
  await Promise.all(
    Object.entries(BIOME_TILE_ASSETS).map(async ([key, path]) => {
      try {
        const tex = await Assets.load<Texture>(path);
        // Tiling textures must wrap, not clamp-to-edge (Pixi's default) — otherwise a
        // TilingSprite repeats the same clamped border pixel instead of the swatch.
        tex.source.addressMode = 'repeat';
        textures.set(key, tex);
      } catch {
        // Not generated yet (or failed to fetch) — fine, RoomBuilder's flat-colour
        // fallback covers it.
      }
    }),
  );
}

export function getFloorTexture(element: BiomeElement): Texture | undefined {
  return textures.get(`floor_${element}`);
}

export function getWallTexture(element: BiomeElement): Texture | undefined {
  return textures.get(`wall_${element}`);
}
