// design/12's "load a core bundle at boot", as one function both entries call.
//
// This used to live inline in `main.ts`, which is why the WeChat entry had no preload at
// all: there was nothing to call. Sharing it is the point — a new rig bundle or a new
// loader added here reaches BOTH targets, instead of reaching web and silently skipping
// the mini-game (the shape of the gap this closes, design/ROADMAP's parked WeChat item).
//
// Every load is best-effort and per-item: a failed or slow asset leaves that consumer on
// its Graphics fallback and boot continues ("gameplay is never blocked on art",
// design/02/12). That is a stronger requirement on WeChat than on web, not a weaker one —
// a mini-game has no reload button.
import { Assets } from 'pixi.js';
import { getAssetHost } from './assetHost';
import { ensureAllPacks } from './packLoader';
import { preloadRigSkin } from './skinRegistry';
import { preloadWeaponSkins } from './weaponSkins';
import { preloadUiArt } from './uiSkins';
import { preloadBiomeTiles } from './biomeTiles';
import { preloadEnvironmentSprites } from './environmentSprites';

/** Registry keys are `SkinDef.atlasKey` values (content/skins.ts) — the three launch
 *  characters (design/13), all on the shared orb-core rig — plus the enemy bodies
 *  ('critter-core' and its two variants, design/13's "one neutral-grey critter, re-tinted
 *  per variant") and the boss. */
export const CHAR_BUNDLES: ReadonlyArray<[string, string]> = [
  ['char_vanguard', '/skins/orb-core'],
  ['char_skirmisher', '/skins/skirmisher-core'],
  ['char_juggernaut', '/skins/juggernaut-core'],
  ['critter-core', '/skins/critter-core'],
  ['brute-core', '/skins/brute-core'],
  ['floater-core', '/skins/floater-core'],
  ['boss-core', '/skins/boss-core'],
];

export async function preloadCoreArt(): Promise<void> {
  // Explicit, and BEFORE the first load. `Assets.load` self-initialises otherwise, which on
  // WeChat throws inside the format detection and silently costs whichever texture happened
  // to race there first — see AssetHost.assetsInit for the full account.
  await Assets.init(getAssetHost().assetsInit);

  // Subpackages BEFORE the loads that read out of them: on WeChat a path inside a pack that
  // has not been fetched names no file, and every loader below would take that for
  // "not generated yet" and fall back silently. See packLoader.ts for why all of them are
  // fetched here rather than lazily at the point of use.
  await ensureAllPacks();

  await Promise.all([
    ...CHAR_BUNDLES.map(async ([name, baseUrl]) => {
      try {
        await preloadRigSkin(name, baseUrl);
      } catch (err) {
        console.warn(`${name} skin preload failed, falling back to placeholder`, err);
      }
    }),
    preloadWeaponSkins().catch((err) => {
      console.warn('weapon skins preload failed, socket stays unarmed-looking', err);
    }),
    preloadUiArt(),
    preloadBiomeTiles(),
    preloadEnvironmentSprites(),
  ]);
}
