// WeChat forbids eval / new Function (unsafe-eval). Pixi v8 generates uniform/UBO/
// shader upload code via new Function by default; this side-effect import swaps in
// eval-free polyfills and neuters Pixi's _unsafeEvalCheck. Must load before the
// renderer is constructed. Web keeps the faster eval path (not imported there).
import 'pixi.js/unsafe-eval';
import { Game } from './game/Game';
import { setUiAudio } from './audio/uiSound';
import { setMusicAudio } from './game/musicDirector';
import { WeChatPlatform } from './platform/wechat/WeChatPlatform';
import { weChatAssetHost } from './platform/wechat/weChatAssetHost';
import { setAssetHost } from './render/assetHost';
import { preloadCoreArt } from './render/preloadArt';
import { disableBrokenLetterSpacing, pinTextMeasurementToPaintCanvas } from './render/textMetrics';
import { reportWeChatBootFailure } from './bootError';
import { installPerf } from './perf';

// WeChat mini-game entry, loaded by client/wechat/game.js. There is no weapp-adapter (an
// older version of this comment claimed there was): the bundle installs Pixi's own
// DOMAdapter itself, in WeChatPlatform.createApp, before Application.init.
async function boot() {
  const platform = new WeChatPlatform();
  const app = await platform.createApp();
  // Same measure-canvas/paint-canvas pinning as the web entry (render/textMetrics.ts), but it
  // MUST come after createApp(), not before it as it did until 2026-08-25: the pin allocates its
  // canvas through `DOMAdapter`, and the adapter is still Pixi's BrowserAdapter until
  // `createApp()` installs ours. Called first, it therefore reached for `document.createElement`
  // — which the DevTools simulator happens to answer (so this looked fine there) and a real
  // device does not have at all, making it a ReferenceError out of boot() on device. Ordering it
  // after the platform is up is what makes both hosts take the same wx canvas.
  //
  // Still ahead of the first `Text`: Pixi memoises the measurement canvas on first use, and
  // nothing between here and the Game constructor below builds one.
  pinTextMeasurementToPaintCanvas();
  // ...and turn off Pixi's letter-spacing fast path where the host's own `letterSpacing` property
  // breaks the context it is set on (render/textMetrics.ts — it is what blanked every WeChat
  // label). A no-op on a host whose property works, so both entries run the same check.
  disableBrokenLetterSpacing();
  const input = platform.createInput(app);
  const audio = platform.createAudio();

  // Real art, same core bundle as the web entry (design/12 "load a core bundle at boot").
  // The host swap has to happen BEFORE the first load: it is what turns a public-relative
  // '/skins/...' path into a code-package path, and what routes the JSON sidecars through
  // FileSystemManager instead of a `fetch` this runtime does not have. Everything under it
  // is best-effort, so a missing or unreadable asset degrades to the Graphics placeholder
  // this entry used to render exclusively, rather than failing boot.
  setAssetHost(weChatAssetHost);
  // The SFX set (design/11), same fire-and-forget as the web entry — but note the ordering:
  // it must come AFTER the host swap, because that is what turns '/audio/impact_00.mp3' into
  // a code-package path this runtime can read at all.
  void audio.preload();
  // UI cues (design/11), same one-line wiring as the web entry — and it matters more here:
  // `WeChatAudio` registers none of the window listeners `WebAudio` uses to clear the
  // autoplay gate, so a menu tap is this runtime's first chance to resume the context.
  setUiAudio(audio);
  // ...and the third road to the bus (design/11 "Music & ambience"): the same module-sink
  // shape, for the same reason plus one — its per-frame caller is `GameLoop`, which would have
  // to be handed the device by `Game.ts`, and that file's length is pinned by the drift gate.
  // Nothing plays yet: `game/musicDirector.ts` derives the track from the situation on the
  // first frame `Game` renders.
  setMusicAudio(audio);
  await preloadCoreArt();

  const game = new Game(app, input, audio);
  game.start();

  // Same frame-timing monitor as the web entry (src/perf). No overlay here: there is no
  // `?query=` to turn one on in a mini-game, and this runtime has no PerformanceObserver,
  // so the long-task signal is absent and the sustained-low-fps path carries it alone —
  // which is exactly the fallback funny's original was built around.
  // Each closed window also feeds the quality watchdog (render/qualityWatchdog.ts). This
  // runtime is the reason that path exists at all: every perf number in design/01 was measured
  // on a desktop Chrome, and until 2026-08-25 a handset that could not hold the frame had
  // nothing to turn off.
  installPerf(app, { onSnapshot: (s) => game.observePerfWindow(s.window) });

  (GameGlobal as Record<string, unknown>).__game = game;
}

boot().catch(reportWeChatBootFailure);
