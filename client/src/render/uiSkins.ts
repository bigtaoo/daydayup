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
  // Remaining button icons (2026-08 pass) — LoginScreen/PauseMenu/PartyScreen/Forge.
  // icon_play/icon_account/icon_settings above are REUSED (RESUME/START MATCHING/
  // START RUN, LOGIN, PauseMenu's SETTINGS) rather than duplicated.
  icon_register: '/ui/icon_register.png',
  icon_password: '/ui/icon_password.png',
  icon_logout: '/ui/icon_logout.png',
  icon_back: '/ui/icon_back.png',
  icon_quit: '/ui/icon_quit.png',
  icon_party_create: '/ui/icon_party_create.png',
  icon_party_join: '/ui/icon_party_join.png',
  icon_party_leave: '/ui/icon_party_leave.png',
  icon_clear: '/ui/icon_clear.png',
  // The Forge outpost NPC (design/13's "Outpost/hub" NPC gap — a forger character
  // standing in the loadout screen). Sprite, not a button icon — Forge.ts positions
  // it directly rather than going through Button.setIcon.
  npc_forger: '/ui/npc_forger.png',
};

const textures = new Map<string, Texture>();

/** Every key `getUiTexture` can resolve once preloaded — exposed so tests can assert
 * a key (e.g. a new icon or `npc_forger`) is actually registered here, since
 * `getUiTexture` itself returns `undefined` identically for both a missing key and a
 * registered key whose file hasn't loaded (network-independent by design). */
export const UI_ASSET_KEYS: readonly string[] = Object.keys(UI_ASSETS);

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
