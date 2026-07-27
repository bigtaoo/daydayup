import { Game } from './game/Game';
import { WebPlatform } from './platform/web/WebPlatform';
import { preloadRigSkin } from './render/skinRegistry';

// Web entry. The WeChat entry is client/src/main.wechat.ts (loaded by client/wechat/game.js).
// Both reuse the Game core; only the Platform differs. The real `.tao` rig skin
// preload (design/12) is web-only for now — WeChat's fetch/Image path for real
// assets is explicitly unverified (design/12's open questions), so that entry
// stays on the Graphics placeholder until it's tested on-device.
async function boot() {
  const platform = new WebPlatform();
  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();

  // Best-effort: a failed/slow preload just leaves the orb-core skin on its
  // Graphics placeholder (design/02/12 — art never blocks gameplay).
  try {
    await preloadRigSkin('orb-core', '/skins/orb-core');
  } catch (err) {
    console.warn('orb-core skin preload failed, falling back to placeholder', err);
  }

  const game = new Game(app, input, audio);
  game.start();

  // Expose for debugging
  (globalThis as unknown as { __game: Game }).__game = game;
}

boot();
