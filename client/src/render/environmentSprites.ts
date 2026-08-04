// Standalone environment fixtures (design/05 "Room & door model", 2026-08-04) — today
// just the door pair. Same non-blocking best-effort preload pattern as biomeTiles.ts/
// weaponSkins.ts: a missing/not-yet-generated sprite just leaves RoomBuilder on its
// existing flat-colour fallback, never blocks boot.
import { Assets, Texture } from 'pixi.js';

const ENV_SPRITE_ASSETS: Readonly<Record<string, string>> = {
  door_locked: '/environment/door_locked_raw.png',
  door_open: '/environment/door_open_raw.png',
};

const textures = new Map<string, Texture>();

export async function preloadEnvironmentSprites(): Promise<void> {
  await Promise.all(
    Object.entries(ENV_SPRITE_ASSETS).map(async ([key, path]) => {
      try {
        const tex = await Assets.load<Texture>(path);
        textures.set(key, tex);
      } catch {
        // Not generated yet (or failed to fetch) — fine, RoomBuilder's flat-colour
        // fallback covers it.
      }
    }),
  );
}

/** A dungeon door's fixture texture (design/05: "always-present, exactly two visual
 *  states, locked/open — never a bare gap"). Undefined until preloaded — RoomBuilder
 *  falls back to a flat tinted rect. */
export function getDoorTexture(locked: boolean): Texture | undefined {
  return textures.get(locked ? 'door_locked' : 'door_open');
}
