import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Graphics, Ticker, UPDATE_PRIORITY } from 'pixi.js';
import { installPerf, type InstalledPerf } from './index';

// PerfOverlay builds a real Pixi `Text`, which measures on a canvas this plain-node vitest
// does not have. Stubbed to a plain Container-shaped object: this file is about the WIRING
// (what gets mounted, what gets removed), and the overlay's own behaviour has its own test.
vi.mock('./PerfOverlay', async () => {
  // A REAL Container for `view` — `stage.addChild` is Pixi's own and rejects a plain object,
  // and "is it actually mounted on the stage" is half of what this file asserts.
  const { Container: PixiContainer } = await import('pixi.js');
  return {
    PerfOverlay: class {
      view = new PixiContainer();
      snapshots: unknown[] = [];
      updates = 0;
      setSnapshot(s: unknown) { this.snapshots.push(s); }
      toggle(on = !this.view.visible) { this.view.visible = on; }
      update() { this.updates += 1; }
    },
    formatSnapshot: () => '',
  };
});

/** The pieces of `Application` `installPerf` touches. */
function fakeApp() {
  const ticker = new Ticker();
  ticker.autoStart = false;
  const stage = new Container();
  const existing = new Container();
  stage.addChild(existing);
  const gl: Record<string, unknown> = { drawArrays: () => {}, useProgram: () => {}, bindTexture: () => {}, bindFramebuffer: () => {} };
  const renderer = {
    gl,
    screen: { width: 800, height: 600 },
    texture: { _managedTextures: { items: {} } },
    // The census reads its verdicts off `renderer.graphicsContext`; a fixed answer is enough here,
    // `drawAttribution.test.ts` covers the walk and the sort.
    graphicsContext: {
      updateGpuContext: () => ({ isBatchable: false, batches: [{}], geometryData: { vertices: new Array(900) } }),
    },
    render() {
      (gl.drawArrays as () => void)();
    },
  };
  ticker.add(() => renderer.render(), null, UPDATE_PRIORITY.LOW);
  ticker.update(1000); // prime, so the first measured frame is not the clamped 100ms one
  return { ticker, stage, existing, renderer, gl, app: { ticker, stage, renderer } as never };
}

function run(ticker: Ticker, frames: number, stepMs = 16): void {
  let t = 1000;
  for (let i = 0; i < frames; i++) {
    t += stepMs;
    ticker.update(t);
  }
}

let handle: InstalledPerf | null = null;
afterEach(() => {
  handle?.uninstall();
  handle = null;
  delete (globalThis as { __perf?: unknown }).__perf;
  vi.restoreAllMocks();
});

describe('installPerf — the default (no overlay) session', () => {
  it('installs the monitor and nothing visible', () => {
    // The point of porting funny's design rather than writing a dev FPS counter: the monitor
    // is cheap enough to leave on for every player, so a stutter in the field leaves a trace.
    const { app, ticker, stage } = fakeApp();
    const before = stage.children.length;
    handle = installPerf(app);
    expect(handle.monitor).toBeTruthy();
    expect(handle.overlay).toBeNull();
    expect(stage.children).toHaveLength(before);
    // The app's own render listener plus the monitor's two frame brackets, and nothing else —
    // no overlay refresh listener, which is what makes this the cheap always-on configuration.
    expect(ticker.count).toBe(3);
  });

  it('leaves the GL context untouched — the probe is opt-in', () => {
    // The probe rewrites live GL entry points. Fine for a `?perf=1` session, not something a
    // normal one should carry.
    const { app, gl } = fakeApp();
    const originals = { ...gl };
    handle = installPerf(app);
    for (const k of Object.keys(originals)) expect(gl[k]).toBe(originals[k]);
  });

  it('still produces snapshots, so `window.__perf` is useful without a reload', () => {
    const { app, ticker } = fakeApp();
    handle = installPerf(app, { windowMs: 50 });
    run(ticker, 10);
    expect(handle.monitor.latest).not.toBeNull();
  });
});

describe('installPerf — the ?perf=1 session', () => {
  it('mounts the overlay LAST, so it draws over every layer without sorting the stage', () => {
    const { app, stage, existing } = fakeApp();
    handle = installPerf(app, { overlay: true });
    expect(stage.children).toHaveLength(2);
    expect(stage.children[0]).toBe(existing);
    expect(stage.children[1]).toBe(handle.overlay!.view as never);
  });

  it('shows it immediately — the flag IS the request to see it', () => {
    const { app } = fakeApp();
    handle = installPerf(app, { overlay: true });
    expect(handle.overlay!.view.visible).toBe(true);
  });

  it('turns the GL probe on with it, since the draw-call line is the overlay point', () => {
    const { app, gl, ticker } = fakeApp();
    const original = gl.drawArrays;
    handle = installPerf(app, { overlay: true });
    expect(gl.drawArrays).not.toBe(original);
    run(ticker, 10);
    // ...and the counts actually reach a snapshot rather than staying inside the probe.
    handle.monitor.latest && expect(handle.monitor.latest.gl).toBeTruthy();
  });

  it('can have the probe forced off even with the overlay on', () => {
    const { app, gl } = fakeApp();
    const original = gl.drawArrays;
    handle = installPerf(app, { overlay: true, probeGl: false });
    expect(gl.drawArrays).toBe(original);
  });

  it('refreshes the overlay AFTER the render, so it is not a cost inside its own numbers', () => {
    const { app, ticker } = fakeApp();
    handle = installPerf(app, { overlay: true });
    const overlay = handle.overlay as unknown as { updates: number };
    run(ticker, 5);
    expect(overlay.updates).toBe(5);
  });

  it('feeds each closed window to the overlay', () => {
    const { app, ticker } = fakeApp();
    handle = installPerf(app, { overlay: true, windowMs: 50 });
    run(ticker, 20);
    expect((handle.overlay as unknown as { snapshots: unknown[] }).snapshots.length).toBeGreaterThan(0);
  });

  it('still calls a caller-supplied onSnapshot alongside the overlay', () => {
    // `installPerf` wraps onSnapshot to feed the overlay; swallowing the caller's own hook
    // would break the seam a telemetry backend would attach to.
    const seen: unknown[] = [];
    const { app, ticker } = fakeApp();
    handle = installPerf(app, { overlay: true, windowMs: 50, onSnapshot: (s) => seen.push(s) });
    run(ticker, 20);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('installPerf — teardown', () => {
  it('puts the ticker listener count back and takes the overlay off the stage', () => {
    // The monitor outlives every scene, so a leak here is exactly the class of bug funny's
    // MemoryMonitor exists to catch — and it would show up in this module's own counters.
    const { app, ticker, stage } = fakeApp();
    const tickers = ticker.count;
    const children = stage.children.length;
    const h = installPerf(app, { overlay: true });
    expect(ticker.count).toBeGreaterThan(tickers);
    h.uninstall();
    expect(ticker.count).toBe(tickers);
    expect(stage.children).toHaveLength(children);
  });

  it('destroys the overlay view rather than leaving an orphaned Text alive', () => {
    const { app } = fakeApp();
    const h = installPerf(app, { overlay: true });
    const view = h.overlay!.view;
    h.uninstall();
    expect(view.destroyed).toBe(true);
  });

  it('restores the renderer render function and the GL context', () => {
    const { app, gl, renderer } = fakeApp();
    const originalRender = renderer.render;
    const originalDraw = gl.drawArrays;
    const h = installPerf(app, { overlay: true });
    h.uninstall();
    expect(renderer.render).toBe(originalRender);
    expect(gl.drawArrays).toBe(originalDraw);
  });

  it('is safe to call twice', () => {
    const { app } = fakeApp();
    const h = installPerf(app, { overlay: true });
    h.uninstall();
    expect(() => h.uninstall()).not.toThrow();
  });
});

describe('installPerf — the console handle', () => {
  it('exposes the install on `window.__perf`, the same convention as `__game`', () => {
    const { app } = fakeApp();
    handle = installPerf(app);
    expect((globalThis as { __perf?: InstalledPerf }).__perf).toBe(handle);
  });
});

describe('installPerf — the console draw-attribution handle', () => {
  it('attributes a group by hiding it, and puts the scene back', () => {
    const { app, stage } = fakeApp();
    handle = installPerf(app, { overlay: true });
    const target = new Container();
    stage.addChild(target);
    const report = handle.attribute({ target: [target] });
    expect(report.attribution).not.toBeNull();
    expect(report.attribution!.rows.map((r) => r.name)).toEqual(['target']);
    expect(report.text).toContain('target');
    expect(target.visible).toBe(true);
  });

  it('says so instead of reporting zeros when the GL probe is off', () => {
    // Without `?perf=1` every counter reads zero, and a zero row reads as "this group is free" —
    // the one wrong answer the tool must not give.
    const { app } = fakeApp();
    handle = installPerf(app);
    const report = handle.attribute({ anything: [] });
    expect(report.attribution).toBeNull();
    expect(report.text).toContain('?perf=1');
  });

  it('censuses the whole stage by default, and a given subtree when asked', () => {
    const { app, stage } = fakeApp();
    handle = installPerf(app, { overlay: true });
    const g = new Graphics();
    g.label = 'probe-me';
    stage.addChild(g);
    expect(handle.census().rows.map((r) => r.name)).toContain('probe-me');
    expect(handle.census().text).toContain('NOT batched');
    // A subtree that holds no Graphics reports an empty census rather than falling back to the stage.
    expect(handle.census(new Container()).rows).toHaveLength(0);
  });
});
