import { Game } from './game/Game';
import type { Phase } from './game/phase';
import { WebPlatform } from './platform/web/WebPlatform';
import { installAutoReload } from './platform/web/autoReload';
import { preloadRigSkin } from './render/skinRegistry';
import { preloadWeaponSkins } from './render/weaponSkins';
import { preloadUiArt } from './render/uiSkins';
import { preloadBiomeTiles } from './render/biomeTiles';
import { preloadEnvironmentSprites } from './render/environmentSprites';
import { pinTextMeasurementToPaintCanvas } from './render/textMetrics';
import { reportWebBootFailure } from './bootError';

// Web entry. The WeChat entry is client/src/main.wechat.ts (loaded by client/wechat/game.js).
// Both reuse the Game core; only the Platform differs. The real `.tao` rig skin
// preload (design/12) is web-only for now — WeChat's fetch/Image path for real
// assets is explicitly unverified (design/12's open questions), so that entry
// stays on the Graphics placeholder until it's tested on-device.
async function boot() {
  // Before any Text exists — Pixi caches its measurement canvas on first use (see
  // render/textMetrics.ts for why the default offscreen one mis-measures Cyrillic).
  pinTextMeasurementToPaintCanvas();
  const platform = new WebPlatform();
  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();

  // Best-effort: a failed/slow preload just leaves that character's skin on its
  // Graphics placeholder (design/02/12 — art never blocks gameplay). Registry keys
  // are SkinDef.atlasKey values (content/skins.ts) — the three launch characters
  // (design/13), all on the shared orb-core rig — plus 'critter-core', the shared
  // enemy body (design/13's "one neutral-grey critter, re-tinted per variant").
  const CHAR_BUNDLES: ReadonlyArray<[string, string]> = [
    ['char_vanguard', '/skins/orb-core'],
    ['char_skirmisher', '/skins/skirmisher-core'],
    ['char_juggernaut', '/skins/juggernaut-core'],
    ['critter-core', '/skins/critter-core'],
    ['brute-core', '/skins/brute-core'],
    ['floater-core', '/skins/floater-core'],
    ['boss-core', '/skins/boss-core'],
  ];
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

  const game = new Game(app, input, audio);
  game.start();
  document.getElementById('boot-loading')?.remove();

  // Pick up a new deploy when the player tabs back in (production builds only). Held back
  // while a run or a network session is live — those phases hold state a reload would throw
  // away; the check simply runs again on the next foreground return.
  const RELOAD_UNSAFE_PHASES: ReadonlySet<Phase> = new Set<Phase>(['playing', 'paused', 'matchmaking']);
  installAutoReload(() => !RELOAD_UNSAFE_PHASES.has(game.getPhase()) && !game.isOnline());

  // Expose for debugging
  (globalThis as unknown as { __game: Game }).__game = game;
}

boot().catch(reportWebBootFailure);
