import { Game } from './game/Game';
import { WebPlatform } from './platform/web/WebPlatform';

// Web entry. The WeChat entry is client/src/main.wechat.ts (loaded by client/wechat/game.js).
// Both reuse the Game core; only the Platform differs.
async function boot() {
  const platform = new WebPlatform();
  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();

  const game = new Game(app, input, audio);
  game.start();

  // Expose for debugging
  (globalThis as unknown as { __game: Game }).__game = game;
}

boot();
