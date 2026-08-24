// WeChat forbids eval / new Function (unsafe-eval). Pixi v8 generates uniform/UBO/
// shader upload code via new Function by default; this side-effect import swaps in
// eval-free polyfills and neuters Pixi's _unsafeEvalCheck. Must load before the
// renderer is constructed. Web keeps the faster eval path (not imported there).
import 'pixi.js/unsafe-eval';
import { Game } from './game/Game';
import { WeChatPlatform } from './platform/wechat/WeChatPlatform';
import { pinTextMeasurementToPaintCanvas } from './render/textMetrics';
import { reportWeChatBootFailure } from './bootError';
import { installPerf } from './perf';

// WeChat mini-game entry. It is loaded by client/wechat/game.js, which MUST have
// already required weapp-adapter so window/document/Image exist before Pixi imports.
async function boot() {
  // Same measure-canvas/paint-canvas pinning as the web entry (render/textMetrics.ts) —
  // a no-op-equivalent here if weapp-adapter exposes no OffscreenCanvas, but the two
  // entries should not diverge on how text is measured.
  pinTextMeasurementToPaintCanvas();
  const platform = new WeChatPlatform();
  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();

  const game = new Game(app, input, audio);
  game.start();

  // Same frame-timing monitor as the web entry (src/perf). No overlay here: there is no
  // `?query=` to turn one on in a mini-game, and this runtime has no PerformanceObserver,
  // so the long-task signal is absent and the sustained-low-fps path carries it alone —
  // which is exactly the fallback funny's original was built around.
  installPerf(app);

  (GameGlobal as Record<string, unknown>).__game = game;
}

boot().catch(reportWeChatBootFailure);
