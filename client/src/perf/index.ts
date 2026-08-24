// Assembly shell for the perf system. One call wires the monitor, the overlay and the
// console handle; the game layer knows nothing else about any of it.

import { UPDATE_PRIORITY, type Application } from 'pixi.js';
import { PerfMonitor, type PerfMonitorOptions, type PerfSnapshot } from './PerfMonitor';
import { PerfOverlay } from './PerfOverlay';

export { PerfMonitor, type PerfSnapshot, type PerfMonitorOptions } from './PerfMonitor';
export { PerfOverlay, formatSnapshot } from './PerfOverlay';
export { FrameSampler, msStats, numFromStorage, type FrameWindow, type MsStats } from './frameSampler';
export { GlProbe, filterPasses, type GlCounts } from './glProbe';
export { countScene, heapMB, gpuTextureCount, NODE_WALK_CAP, type SceneCounts } from './sceneCounters';

export interface InstalledPerf {
  monitor: PerfMonitor;
  overlay: PerfOverlay | null;
  uninstall(): void;
}

export interface InstallPerfOptions extends PerfMonitorOptions {
  /** Show the on-screen readout and turn on the GL probe that feeds its draw-call line.
   *  Off in a normal session: the monitor alone is one ticker bracket and a windowed
   *  counter, the overlay costs a Text and a live-patched GL context. */
  overlay?: boolean;
}

/**
 * Install the perf system on a running app.
 *
 * The monitor part is always safe to run — that is the point of porting funny's design
 * rather than writing a dev-only FPS counter: a player hitting a sustained stutter leaves
 * a console warning that names which half of the frame was to blame, without anyone having
 * to reproduce it with a flag on. `overlay: true` (wired to `?perf=1`) adds the live
 * readout and the draw-call probe on top.
 */
export function installPerf(app: Application, opts: InstallPerfOptions = {}): InstalledPerf {
  const wantOverlay = opts.overlay ?? false;
  const overlay = wantOverlay ? new PerfOverlay() : null;
  const monitor = new PerfMonitor({
    ...opts,
    probeGl: opts.probeGl ?? wantOverlay,
    onSnapshot: (s: PerfSnapshot) => {
      overlay?.setSnapshot(s);
      opts.onSnapshot?.(s);
    },
  });
  monitor.install(app);

  let tick: (() => void) | null = null;
  if (overlay) {
    // Added last, so it draws over every layer without needing the stage sorted.
    app.stage.addChild(overlay.view);
    overlay.toggle(true);
    tick = () => overlay.update(app.ticker, app.renderer.screen.width, app.renderer.screen.height);
    // UTILITY, i.e. after the render: the overlay describes the frame that just went out,
    // and refreshing it before the render would make it a cost inside its own numbers.
    app.ticker.add(tick, null, UPDATE_PRIORITY.UTILITY);
  }

  const handle: InstalledPerf = {
    monitor,
    overlay,
    uninstall(): void {
      if (tick) app.ticker.remove(tick, null);
      if (overlay) {
        app.stage.removeChild(overlay.view);
        overlay.view.destroy({ children: true });
      }
      monitor.uninstall();
    },
  };
  // Same convention as `__game` in main.ts: reachable from the devtools console, so a
  // snapshot can be read (or the overlay toggled) without a reload.
  (globalThis as unknown as { __perf?: InstalledPerf }).__perf = handle;
  return handle;
}
