// The run-boundary art gate (design/12, "the gate, and why it is invisible almost always").
//
// Since 2026-09-01 the main package is code only and the art arrives in two phases: the `lobby`
// pack is awaited at boot, everything a RUN draws is downloaded in the background from the lobby
// (`render/preloadArt.ts`'s `beginDeferredArt`). This class is the one place that turns "the run
// art is not in yet" into a visible wait instead of a room full of placeholder rectangles.
//
// Two properties are what keep the change to `Game.ts` down to one line per gated transition:
//
//  1. **Synchronous when the art is in.** `defer()` asks `isRunArtReady()` first and answers
//     `false`, leaving the caller's transition exactly as synchronous as it was before this
//     class existed. Only a genuine wait defers.
//  2. **Inert unless something actually deferred.** `isRunArtReady()` answers `true` until
//     `beginDeferredArt()` has been called, which only the two real entry points do — so every
//     unit test that drives `Game` sees the pre-phases behaviour, and this class cannot silently
//     swallow a transition in a test that never opted into deferral.
//
// The gated transitions and the reason for each: `showForge` (weapon art — the forge is where a
// player CHOOSES with it), `showPvpPreview` (character art), `showMatchmaking` (the run on the
// other side of it), `beginTutorialRun` / `beginArenaDemoRun` / `beginReplayRun` (a run, with no
// screen in between). Everything else a player can reach — main menu, mode select, account,
// squad, settings — draws from the `lobby` pack alone and is never gated.
import type { Container, Ticker } from 'pixi.js';
import { ensureRunArt, isRunArtReady, runArtUnitCount } from '../../render/preloadArt';
import { t } from '../../i18n';
import { LoadingScreen } from '../ui/loadingScreen';

export interface ArtGateDeps {
  /** `Layers.overlay` — above every screen, unscaled. See layers.ts for why it is its own
   *  sub-layer rather than a child of `menu`. */
  overlay: Container;
  ticker: Ticker;
  /** The live viewport, read on every tick so a resize mid-wait re-lays-out. */
  screenSize(): { w: number; h: number };
}

export class ArtGate {
  private screen: LoadingScreen | null = null;

  constructor(private readonly deps: ArtGateDeps) {}

  /**
   * Ask permission to make a transition that needs run art.
   *
   * Returns `true` when the transition was DEFERRED — the caller must return immediately and do
   * nothing else, because `retry` will re-run it once the art has landed. Returns `false` when
   * the art is already in, which is the overwhelmingly common case: the background load starts
   * the moment the lobby paints and has the whole login/menu/mode-select sequence to finish.
   *
   * `retry` is normally the caller re-invoking itself (`() => this.showForge()`), which routes
   * back through this same method and sails past it the second time.
   */
  defer(retry: () => void): boolean {
    if (isRunArtReady()) return false;
    // A wait is already on screen. Swallow this transition rather than stacking a second screen
    // or queueing a second `retry`: the overlay does not stop the KEYBOARD, so the Enter that
    // opened the forge can arrive again while the spinner is up (`Game.confirm` is reachable in
    // the phase the player is still standing in). The first retry is the one that runs.
    if (this.screen) return true;
    const screen = new LoadingScreen({
      label: t('loading.art'),
      ticker: this.deps.ticker,
      sizeOf: () => this.deps.screenSize(),
    });
    const { w, h } = this.deps.screenSize();
    screen.layout(w, h);
    // Sized before the first tick arrives: `ensureRunArt` may already be most of the way done,
    // and a bar that appears at 0 and jumps is worse than one that appears where it is.
    screen.setProgress(0, runArtUnitCount());
    this.screen = screen;
    this.deps.overlay.addChild(screen.view);
    void ensureRunArt((done, total) => screen.setProgress(done, total))
      // `catch` before `then`, so the gate opens on EVERY outcome. Every loader inside
      // `ensureRunArt` is already best-effort per item, but a throw from anywhere else in that
      // chain would otherwise leave this spinner up for the rest of the session — a permanently
      // stuck wait is the worst possible reading of "gameplay is never blocked on art"
      // (design/02/12). The player gets the transition, with whatever art arrived.
      .catch((err) => {
        console.warn('run art failed to load; entering with placeholder art', err);
      })
      .then(() => {
        // Torn down BEFORE the retry, so the re-entrant `defer()` sees no screen and no
        // outstanding wait.
        this.hide();
        retry();
      });
    return true;
  }

  /** Whether a wait is currently on screen. Test/diagnostic surface. */
  get waiting(): boolean {
    return this.screen !== null;
  }

  private hide(): void {
    this.screen?.destroy();
    this.screen = null;
  }
}
