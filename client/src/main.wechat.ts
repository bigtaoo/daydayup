// WeChat forbids eval / new Function (unsafe-eval). Pixi v8 generates uniform/UBO/
// shader upload code via new Function by default; this side-effect import swaps in
// eval-free polyfills and neuters Pixi's _unsafeEvalCheck. Must load before the
// renderer is constructed. Web keeps the faster eval path (not imported there).
import 'pixi.js/unsafe-eval';
import { Game } from './game/Game';
import { WeChatPlatform } from './platform/wechat/WeChatPlatform';
import { reportWeChatBootFailure } from './bootError';

// WeChat mini-game entry. It is loaded by client/wechat/game.js, which MUST have
// already required weapp-adapter so window/document/Image exist before Pixi imports.
async function boot() {
  const platform = new WeChatPlatform();
  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();

  const game = new Game(app, input, audio);
  game.start();

  (GameGlobal as Record<string, unknown>).__game = game;
}

boot().catch(reportWeChatBootFailure);
