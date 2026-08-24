// The installed perf system: hangs the sampler, the GL probe and the scene counters off a
// live Pixi app and produces one snapshot per sampling window.
//
// Structure is funny's (`install(ticker)` on an app-wide singleton, a windowed tick, a
// cooldown so warnings can't flood, thresholds overridable from localStorage). What
// changed for daydayup:
//   * funny forwards every breach to a log backend (`reportAnomaly` -> Loki). This repo has
//     no such channel, so a breach goes to `console.warn` and, when the overlay is on, to
//     the screen. `onWarn`/`onSnapshot` are the seams to add a backend later.
//   * The frame is SPLIT into update vs render without touching Game/GameLoop: two ticker
//     listeners bracket the frame (one above every other listener, one below Pixi's own
//     render) and `renderer.render` is wrapped to time itself. Nothing in the game layer
//     needs to know this exists.

import { UPDATE_PRIORITY, type Application, type Container, type Ticker } from 'pixi.js';
import { FrameSampler, type FrameWindow, type FrameSamplerOptions } from './frameSampler';
import { GlProbe, type GlCounts, filterPasses } from './glProbe';
import { countScene, gpuTextureCount, heapMB, type CountableRenderer, type SceneCounts, type WalkableNode } from './sceneCounters';

/** Everything one closed window knows. This is what the overlay draws and what a future
 *  telemetry backend would post. */
export interface PerfSnapshot {
  window: FrameWindow;
  /** Last frame's GL command counts. Zeroed when the GL probe is off. */
  gl: GlCounts;
  /** Filter passes implied by this frame's render-target switches. */
  filterPasses: number;
  scene: SceneCounts;
  gpuTextures: number;
  heapMB: number | null;
  tickerListeners: number;
}

export interface PerfMonitorOptions extends FrameSamplerOptions {
  /** Wrap the WebGL context to count draw calls. Off by default: it rewrites the live GL
   *  entry points, which is fine for a `?perf=1` session and not something a normal one
   *  should carry. */
  probeGl?: boolean;
  onSnapshot?: (s: PerfSnapshot) => void;
  /** Defaults to a console.warn. Replaced wholesale (not appended to) when provided. */
  onWarn?: (reason: string, w: FrameWindow) => void;
}

/** Minimum gap between two warnings, so a genuinely slow device logs once every half
 *  minute instead of every window. funny relies on its backend's own 60s cooldown for
 *  this; here the cooldown has to live locally. */
const REWARN_EVERY_MS = 30_000;

export class PerfMonitor {
  readonly sampler: FrameSampler;
  private readonly probe = new GlProbe();
  private readonly probeGlRequested: boolean;
  private readonly onSnapshot?: (s: PerfSnapshot) => void;

  private ticker: Ticker | null = null;
  private stage: Container | null = null;
  private renderer: ProbedRenderer | null = null;
  private unwrapRender: (() => void) | null = null;
  private observer: { disconnect(): void } | null = null;

  private frameStartMs = 0;
  private renderMs = 0;
  private lastWarnMs = -Infinity;
  /** The most recent snapshot, also exposed on `window.__perf` for console poking. */
  latest: PerfSnapshot | null = null;

  constructor(opts: PerfMonitorOptions = {}) {
    this.probeGlRequested = opts.probeGl ?? false;
    this.onSnapshot = opts.onSnapshot;
    const warn = opts.onWarn ?? ((reason: string) => console.warn(`[perf] ${reason}`));
    this.sampler = new FrameSampler({
      ...opts,
      onWindow: (w) => this.closeWindow(w, opts.onWindow),
      onWarn: (reason, w) => {
        const now = nowMs();
        if (now - this.lastWarnMs < REWARN_EVERY_MS) return;
        this.lastWarnMs = now;
        warn(reason, w);
      },
    });
  }

  install(app: Application): void {
    this.ticker = app.ticker;
    this.stage = app.stage;
    this.renderer = app.renderer as unknown as ProbedRenderer;
    this.sampler.isHiddenNow = isHiddenNow;
    if (isHiddenNow()) this.sampler.markHidden();

    // Brackets the whole frame: HIGH runs before the game's own update listener, UTILITY
    // runs after Pixi's render (LOW). Neither the game nor the renderer is modified.
    this.ticker.add(this.onFrameStart, null, UPDATE_PRIORITY.HIGH);
    this.ticker.add(this.onFrameEnd, null, UPDATE_PRIORITY.UTILITY);
    this.wrapRender();
    if (this.probeGlRequested) this.probe.install(this.renderer.gl as Record<string, unknown> | undefined);
    this.installLongTaskObserver();
    globalThis.document?.addEventListener?.('visibilitychange', this.onVisibilityChange);
    globalThis.document?.addEventListener?.('freeze', this.onVisibilityChange);
  }

  uninstall(): void {
    this.ticker?.remove(this.onFrameStart, null);
    this.ticker?.remove(this.onFrameEnd, null);
    this.unwrapRender?.();
    this.unwrapRender = null;
    this.probe.uninstall();
    try {
      this.observer?.disconnect();
    } catch {
      /* already gone */
    }
    this.observer = null;
    globalThis.document?.removeEventListener?.('visibilitychange', this.onVisibilityChange);
    globalThis.document?.removeEventListener?.('freeze', this.onVisibilityChange);
    this.ticker = null;
    this.stage = null;
    this.renderer = null;
  }

  /** Time one render pass and the GL traffic it produced. Wrapping `renderer.render` (as
   *  opposed to another pair of ticker listeners) is what separates render cost from
   *  update cost: Pixi's own render listener sits between ours, and there is no hook
   *  between the two halves other than the call itself. */
  private wrapRender(): void {
    const renderer = this.renderer;
    if (!renderer || typeof renderer.render !== 'function') return;
    // Both halves are needed: `bound` is what the wrapper calls, `previous`/`hadOwn` are
    // what uninstall puts back. Restoring the BOUND function instead would leave a
    // permanent own-property shim on the renderer — invisible while it works, and a second
    // install/uninstall cycle deep before it bites.
    const hadOwn = Object.prototype.hasOwnProperty.call(renderer, 'render');
    const previous = renderer.render;
    const bound = previous.bind(renderer) as (...args: never[]) => unknown;
    renderer.render = (...args: never[]): unknown => {
      const t0 = nowMs();
      this.probe.beginFrame();
      try {
        return bound(...args);
      } finally {
        this.probe.endFrame();
        this.renderMs += nowMs() - t0;
      }
    };
    this.unwrapRender = () => {
      if (hadOwn) renderer.render = previous;
      else delete (renderer as Partial<typeof renderer>).render; // it lived on the prototype
    };
  }

  private onFrameStart = (): void => {
    this.frameStartMs = nowMs();
    this.renderMs = 0;
  };

  private onFrameEnd = (): void => {
    const cpuMs = nowMs() - this.frameStartMs;
    const renderMs = this.renderMs;
    // Never negative: `renderMs` is measured inside the same bracket, but a clock that
    // jumps (or a render triggered outside the ticker) must not produce a negative update.
    const updateMs = Math.max(0, cpuMs - renderMs);
    this.sampler.frame(this.ticker?.deltaMS ?? 16.7, updateMs, renderMs);
  };

  private onVisibilityChange = (): void => {
    if (isHiddenNow()) this.sampler.markHidden();
  };

  private installLongTaskObserver(): void {
    const Ctor = (globalThis as {
      PerformanceObserver?: new (cb: (list: { getEntries(): { duration: number }[] }) => void) => {
        observe(opts: { entryTypes: string[] }): void;
        disconnect(): void;
      };
    }).PerformanceObserver;
    if (!Ctor) return; // unsupported (WeChat, older Safari): fall back to the fps path alone
    try {
      const observer = new Ctor((list) => {
        for (const e of list.getEntries()) this.sampler.addLongTaskMs(e.duration);
      });
      observer.observe({ entryTypes: ['longtask'] });
      this.observer = observer;
      this.sampler.longTaskSupported = true;
    } catch {
      // Some environments construct the observer but reject the entry type: degrade quietly.
      this.observer = null;
      this.sampler.longTaskSupported = false;
    }
  }

  private closeWindow(w: FrameWindow, passthrough?: (w: FrameWindow) => void): void {
    const gl = { ...this.probe.perFrame };
    const snapshot: PerfSnapshot = {
      window: w,
      gl,
      filterPasses: filterPasses(gl),
      scene: countScene(this.stage as WalkableNode | null),
      gpuTextures: gpuTextureCount(this.renderer),
      heapMB: heapMB(),
      tickerListeners: tickerCount(this.ticker),
    };
    this.latest = snapshot;
    this.onSnapshot?.(snapshot);
    passthrough?.(w);
  }
}

/** The renderer as this module uses it: something that renders, may expose a GL context to
 *  probe, and may expose a managed-texture list to count. Structural on purpose — the same
 *  reason `sceneCounters` is: none of it should need a GPU to test. */
interface ProbedRenderer extends CountableRenderer {
  render: (...args: never[]) => unknown;
  gl?: unknown;
}

function nowMs(): number {
  return globalThis.performance?.now ? globalThis.performance.now() : 0;
}

function isHiddenNow(): boolean {
  return globalThis.document?.hidden === true;
}

/** `Ticker.count` is the listener count — a number that only ever climbs is funny's
 *  classic "a scene was never torn down and its closures still tick" signature. */
function tickerCount(ticker: Ticker | null): number {
  return (ticker as unknown as { count?: number } | null)?.count ?? -1;
}
