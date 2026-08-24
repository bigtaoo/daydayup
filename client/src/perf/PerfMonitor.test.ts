import { describe, it, expect, vi, afterEach } from 'vitest';
import { Ticker, UPDATE_PRIORITY } from 'pixi.js';
import { PerfMonitor, type PerfSnapshot } from './PerfMonitor';

/**
 * A stand-in for the pieces of `Application` the monitor touches: a REAL Pixi Ticker (the
 * priority ordering between our brackets, the game's update and Pixi's render is the
 * behaviour under test, so faking the ticker would fake away the test), plus a fake
 * renderer and a plain-object stage.
 *
 * `render` is added at UPDATE_PRIORITY.LOW exactly as Pixi's own TickerPlugin adds it, so
 * the ordering the monitor relies on is the shipped one, not an assumption.
 */
function fakeApp(opts: { updateCost?: number; renderCost?: number; rewindAfterRender?: number; clock: { t: number } } = { clock: { t: 0 } }) {
  const ticker = new Ticker();
  ticker.autoStart = false;
  const clock = opts.clock;
  const gl: Record<string, unknown> = {
    drawArrays: () => {},
    useProgram: () => {},
    bindTexture: () => {},
    bindFramebuffer: () => {},
  };
  const stage = { children: [{ filters: [{}] }, {}], visible: true };
  const renderer = {
    gl,
    screen: { width: 800, height: 600 },
    texture: { _managedTextures: { items: { 0: {}, 1: {} } } },
    rendered: 0,
    render(): void {
      renderer.rendered += 1;
      clock.t += opts.renderCost ?? 0;
      (gl.drawArrays as () => void)();
      (gl.bindFramebuffer as () => void)();
      (gl.bindFramebuffer as () => void)();
    },
  };
  // The game's own update listener, at the default priority, between the two brackets.
  ticker.add(() => {
    clock.t += opts.updateCost ?? 0;
  });
  ticker.add(() => renderer.render(), null, UPDATE_PRIORITY.LOW);
  // A non-monotonic clock, if the test asks for one: runs after the render but BEFORE the
  // monitor's own closing bracket (UTILITY is the lowest priority Pixi has), so the frame's
  // measured wall time comes out shorter than the render it contains.
  if (opts.rewindAfterRender) {
    ticker.add(() => { clock.t -= opts.rewindAfterRender!; }, null, UPDATE_PRIORITY.UTILITY + 1);
  }
  // One priming tick before anything is installed. A Pixi Ticker's very first `update`
  // measures from its construction time and gets clamped to `maxElapsedMS` (100ms), which
  // would otherwise make every test's first frame a fake 100ms outlier.
  ticker.update(clock.t);
  renderer.rendered = 0;
  return { ticker, renderer, stage, app: { ticker, renderer, stage } as never };
}

/** Advance the ticker by `frames` steps of `stepMs`, keeping the fake clock in sync. */
function run(ticker: Ticker, clock: { t: number }, frames: number, stepMs = 16.7): void {
  for (let i = 0; i < frames; i++) {
    clock.t += stepMs;
    ticker.update(clock.t);
  }
}

/** Drive `performance.now()` off the same clock the fake app advances, so every measured
 *  duration in the test is exact rather than dependent on how fast the test machine is. */
function stubClock(): { t: number } {
  const clock = { t: 1000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
  return clock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PerfMonitor frame split', () => {
  it('attributes time inside renderer.render to render and the rest to update', () => {
    // The whole reason the monitor brackets the ticker instead of asking Game to
    // instrument itself: neither Game nor GameLoop knows this exists.
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock, updateCost: 4, renderCost: 6 });
    const snapshots: PerfSnapshot[] = [];
    const m = new PerfMonitor({ windowMs: 100, onSnapshot: (s) => snapshots.push(s) });
    m.install(app);
    run(ticker, clock, 10, 16);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.window.update.p50).toBe(4);
    expect(snapshots[0]!.window.render.p50).toBe(6);
    m.uninstall();
  });

  it('never reports a negative update half, even off a clock that goes backwards', () => {
    // update = frameCpu - render, and `performance.now()` is not guaranteed monotonic on
    // every platform this ships to (WeChat's is coarse). A single backwards step makes the
    // render look longer than the frame that contained it; without the floor that lands in
    // the percentiles as a negative and every reading downstream becomes nonsense.
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock, renderCost: 50, rewindAfterRender: 60 });
    const snapshots: PerfSnapshot[] = [];
    const m = new PerfMonitor({ windowMs: 100, onSnapshot: (s) => snapshots.push(s) });
    m.install(app);
    // 100ms steps: the frame still advances net-forwards (100 + 50 render - 60 rewind), so
    // windows close normally — it is only the WITHIN-frame measurement that inverts.
    run(ticker, clock, 5, 100);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[0]!.window.update.p50).toBeGreaterThanOrEqual(0);
    expect(snapshots[0]!.window.update.max).toBeGreaterThanOrEqual(0);
    m.uninstall();
  });

  it('still charges the render half its real time when that happens', () => {
    // The floor must not be implemented by zeroing BOTH halves — the render measurement is
    // independent of the frame's wall time and stays valid.
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock, renderCost: 50, rewindAfterRender: 60 });
    const snapshots: PerfSnapshot[] = [];
    const m = new PerfMonitor({ windowMs: 100, onSnapshot: (s) => snapshots.push(s) });
    m.install(app);
    run(ticker, clock, 5, 100);
    expect(snapshots[0]!.window.render.p50).toBe(50);
    m.uninstall();
  });

  it('uses the ticker delta for the frame figure, not the measured CPU time', () => {
    // fps has to describe what the player saw. A frame that idles waiting for vsync is
    // still a 16.7ms frame even if only 2ms of it was ours.
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock, updateCost: 1, renderCost: 1 });
    const snapshots: PerfSnapshot[] = [];
    const m = new PerfMonitor({ windowMs: 100, onSnapshot: (s) => snapshots.push(s) });
    m.install(app);
    run(ticker, clock, 10, 16);
    expect(snapshots[0]!.window.frame.p50).toBeCloseTo(18, 0); // 16 step + the 2ms of work
    m.uninstall();
  });
});

describe('PerfMonitor snapshots', () => {
  it('carries the GL counts of one frame, not the whole window', () => {
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock });
    const snapshots: PerfSnapshot[] = [];
    const m = new PerfMonitor({ windowMs: 100, probeGl: true, onSnapshot: (s) => snapshots.push(s) });
    m.install(app);
    run(ticker, clock, 10, 16);
    expect(snapshots[0]!.gl.draws).toBe(1); // the fake renderer issues exactly one per frame
    expect(snapshots[0]!.filterPasses).toBe(1); // ...and two framebuffer binds
    m.uninstall();
  });

  it('reports zeroed GL counts when the probe is off', () => {
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock });
    const snapshots: PerfSnapshot[] = [];
    const m = new PerfMonitor({ windowMs: 100, probeGl: false, onSnapshot: (s) => snapshots.push(s) });
    m.install(app);
    run(ticker, clock, 10, 16);
    expect(snapshots[0]!.gl).toEqual({ draws: 0, programs: 0, textures: 0, framebuffers: 0 });
    m.uninstall();
  });

  it('counts the live scene graph and the renderer texture hash', () => {
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock });
    const snapshots: PerfSnapshot[] = [];
    const m = new PerfMonitor({ windowMs: 100, onSnapshot: (s) => snapshots.push(s) });
    m.install(app);
    run(ticker, clock, 10, 16);
    expect(snapshots[0]!.scene.nodes).toBe(3);
    expect(snapshots[0]!.scene.filtered).toBe(1);
    expect(snapshots[0]!.gpuTextures).toBe(2);
    expect(snapshots[0]!.tickerListeners).toBeGreaterThan(0);
    m.uninstall();
  });

  it('keeps the most recent snapshot on `latest` for console inspection', () => {
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock });
    const m = new PerfMonitor({ windowMs: 100 });
    expect(m.latest).toBeNull();
    m.install(app);
    run(ticker, clock, 10, 16);
    expect(m.latest).not.toBeNull();
    m.uninstall();
  });
});

describe('PerfMonitor warnings', () => {
  it('warns through console by default', () => {
    const clock = stubClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, ticker } = fakeApp({ clock });
    const m = new PerfMonitor({ windowMs: 100, sustainWindows: 1, fpsWarn: 25 });
    m.install(app);
    run(ticker, clock, 4, 200); // 5fps
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain('[perf]');
    m.uninstall();
  });

  it('holds a cooldown so a permanently slow device logs once, not every window', () => {
    // funny gets this from its backend's 60s per-type cooldown; with no backend here the
    // cooldown has to live locally or the console becomes unusable exactly when it matters.
    const clock = stubClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, ticker } = fakeApp({ clock });
    const m = new PerfMonitor({ windowMs: 100, sustainWindows: 1, fpsWarn: 25 });
    m.install(app);
    run(ticker, clock, 40, 200); // ten slow windows in a row
    expect(warn).toHaveBeenCalledTimes(1);
    m.uninstall();
  });

  it('routes to a supplied onWarn instead of the console', () => {
    const clock = stubClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    const { app, ticker } = fakeApp({ clock });
    const m = new PerfMonitor({ windowMs: 100, sustainWindows: 1, fpsWarn: 25, onWarn: (r) => seen.push(r) });
    m.install(app);
    run(ticker, clock, 4, 200);
    expect(seen).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    m.uninstall();
  });
});

describe('PerfMonitor install/uninstall', () => {
  it('leaves the ticker listener count where it found it', () => {
    // The monitor outlives every scene; a leak here is the exact class of bug funny's
    // MemoryMonitor was written to catch.
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock });
    const before = ticker.count;
    const m = new PerfMonitor({ windowMs: 100 });
    m.install(app);
    expect(ticker.count).toBe(before + 2);
    m.uninstall();
    expect(ticker.count).toBe(before);
  });

  it('restores the renderer render function', () => {
    const clock = stubClock();
    const { app, renderer } = fakeApp({ clock });
    const original = renderer.render;
    const m = new PerfMonitor({ windowMs: 100 });
    m.install(app);
    expect(renderer.render).not.toBe(original);
    m.uninstall();
    expect(renderer.render).toBe(original);
  });

  it('keeps rendering while wrapped', () => {
    const clock = stubClock();
    const { app, ticker, renderer } = fakeApp({ clock });
    const m = new PerfMonitor({ windowMs: 100 });
    m.install(app);
    run(ticker, clock, 5, 16);
    expect(renderer.rendered).toBe(5);
    m.uninstall();
  });

  it('stops sampling after uninstall', () => {
    const clock = stubClock();
    const { app, ticker } = fakeApp({ clock });
    const snapshots: PerfSnapshot[] = [];
    const m = new PerfMonitor({ windowMs: 100, onSnapshot: (s) => snapshots.push(s) });
    m.install(app);
    run(ticker, clock, 10, 16);
    const n = snapshots.length;
    m.uninstall();
    run(ticker, clock, 20, 16);
    expect(snapshots).toHaveLength(n);
  });
});

describe('PerfMonitor.measureFrame — the FrameProbe behind draw attribution', () => {
  it('renders twice and counts only the second, so a settling frame is not measured', () => {
    // The caller has just flipped a group invisible, which makes Pixi rebuild its instruction set;
    // counting that frame would charge the group for the invalidation instead of for its own draws.
    const clock = { t: 0 };
    const { app, renderer } = fakeApp({ clock });
    const m = new PerfMonitor({ probeGl: true });
    m.install(app);
    renderer.rendered = 0;
    const cost = m.measureFrame()!;
    expect(renderer.rendered).toBe(2);
    // The fake renderer emits one drawArrays and two bindFramebuffer per render — one render's
    // worth, not two, must come back.
    expect(cost.draws).toBe(1);
    expect(cost.framebuffers).toBe(2);
    m.uninstall();
  });

  it('is null without the GL probe, rather than reporting a free scene', () => {
    // Every counter would read zero with the probe off, and a caller would take that as "this group
    // costs nothing" — the one wrong answer this must never give.
    const clock = { t: 0 };
    const { app } = fakeApp({ clock });
    const m = new PerfMonitor({ probeGl: false });
    m.install(app);
    expect(m.measureFrame()).toBeNull();
    m.uninstall();
  });

  it('is null before install and after uninstall', () => {
    const clock = { t: 0 };
    const { app } = fakeApp({ clock });
    const m = new PerfMonitor({ probeGl: true });
    expect(m.measureFrame()).toBeNull();
    m.install(app);
    expect(m.measureFrame()).not.toBeNull();
    m.uninstall();
    expect(m.measureFrame()).toBeNull();
  });
});
