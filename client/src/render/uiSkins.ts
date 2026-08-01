// Shared UI chrome art (design/13's still-open "outpost/hub" look) — one background
// image reused behind every menu-shaped screen (MainMenu/LoginScreen/PauseMenu/
// Settings/Screens/Forge/PartyScreen, all built on the same `ui/widgets.ts`
// Panel/Button), plus a handful of button/result icon glyphs. Preloaded best-effort
// like skinRegistry/weaponSkins: a missing or not-yet-generated file just leaves that
// screen on its flat-colour/plain-text fallback (Panel's flat fill, Button's centered
// label) — art never blocks boot or play. See the GPT Image 2 prompts on file for the
// asset list this key set expects.
import { Assets, Texture } from 'pixi.js';

const UI_ASSETS: Readonly<Record<string, string>> = {
  hub: '/ui/hub_bg.png',
  icon_play: '/ui/icon_play.png',
  icon_squad: '/ui/icon_squad.png',
  icon_account: '/ui/icon_account.png',
  icon_settings: '/ui/icon_settings.png',
  icon_result_extract: '/ui/icon_result_extract.png',
  icon_result_wiped: '/ui/icon_result_wiped.png',
};

const textures = new Map<string, Texture>();

export async function preloadUiArt(): Promise<void> {
  await Promise.all(
    Object.entries(UI_ASSETS).map(async ([key, path]) => {
      try {
        textures.set(key, await Assets.load<Texture>(path));
      } catch {
        // Not generated yet (or failed to fetch) — fine, every consumer already
        // renders correctly without it.
      }
    }),
  );
}

export function getUiTexture(key: string): Texture | undefined {
  return textures.get(key);
}
