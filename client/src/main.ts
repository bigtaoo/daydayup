import { Game } from './game/Game';
import type { Phase } from './game/phase';
import { WebPlatform } from './platform/web/WebPlatform';
import { installAutoReload } from './platform/web/autoReload';
import { preloadCoreArt } from './render/preloadArt';
import { pinTextMeasurementToPaintCanvas } from './render/textMetrics';
import { reportWebBootFailure } from './bootError';
import { installPerf } from './perf';
import { parseGameQueryParams } from './game/match/gameQueryParams';

// Web entry. The WeChat entry is client/src/main.wechat.ts (loaded by client/wechat/game.js).
// Both reuse the Game core; only the Platform differs — including the art preload, which
// is now the SHARED render/preloadArt.ts rather than a table inlined here. That inlining
// was the mechanism behind "the mini-game renders Graphics placeholders only": there was
// no preload for the other entry to call. Web needs no AssetHost of its own — the default
// in render/assetHost.ts is the web one.
async function boot() {
  // Before any Text exists — Pixi caches its measurement canvas on first use (see
  // render/textMetrics.ts for why the default offscreen one mis-measures Cyrillic).
  pinTextMeasurementToPaintCanvas();
  const platform = new WebPlatform();
  const app = await platform.createApp();
  const input = platform.createInput(app);
  const audio = platform.createAudio();

  await preloadCoreArt();

  const game = new Game(app, input, audio);
  game.start();

  // Frame-timing monitor (src/perf, ported from `funny` — see that folder's README for the
  // deviations). Installed after `start()` so its two ticker brackets sit outside every
  // listener the game added, which is what lets it split a frame into "our update" vs
  // "the renderer" without Game or GameLoop knowing it exists. The monitor runs in every
  // session (a sustained stutter leaves a `[perf]` console warning naming the expensive
  // half); `?perf=1` adds the on-screen readout and the WebGL draw-call probe on top.
  installPerf(app, { overlay: parseGameQueryParams(location.search).perf });
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
