// GPU-side frame timing via `EXT_disjoint_timer_query_webgl2` — the only measurement in this
// repo that reads what the GPU actually did, rather than what the CPU spent submitting it.
//
// Why a module rather than a snippet, and why the controls below are not optional. Every
// wall-clock approach to "how long is the arena's frame" has been tried here and each one
// returned a confident, wrong number:
//
//   - `performance.now()` around a `renderer.render` loop measures CPU SUBMISSION. In a tab
//     that is not compositing (a hidden tab, the in-app browser pane) nothing forces the GPU
//     to finish, so the loop reports the driver accepting commands. On 2026-08-26 that method
//     reported a 1000x-ALU shader change as free.
//   - `PerfMonitor`'s `render p50` is the same quantity, and its windows are additionally
//     DISCARDED when `document.hidden` is true, because the browser throttles rAF. A tab
//     behind another window reports `ticker.FPS` near 60 while actually running a handful of
//     frames a second — the fps number is the throttle, not the game.
//   - `gl.readPixels` / `extract.pixels` answer a different question entirely (what was
//     drawn, not how long it took) and have their own stale-frame traps — see `frameProbe.ts`.
//
// A timer query sidesteps all of it: the GPU timestamps its own work, so the number does not
// depend on compositing, on rAF, or on the tab being focused. What it DOES depend on is the
// GPU clock not being disturbed mid-query (`GPU_DISJOINT_EXT`) and on the extension existing
// at all — which is where the two controls come in.
//
// The controls, and what each one caught (2026-08-26, measuring `arena_launch`):
//
//   1. **An empty target must cost ~nothing.** If rendering an empty `Container` costs about
//      what the real scene costs, the harness is measuring its own overhead and every
//      attribution built on it is fiction. This one passed at 0.000 ms, which is what made
//      the ~3 ms resolution-independent floor believable as real scene work.
//   2. **A resolution sweep must MOVE, monotonically.** A timer that returns a plausible
//      constant is indistinguishable from a working one on a single reading. Sweeping
//      resolution changes the pixel count by a known factor and nothing else, so the number
//      has to follow. Today's run went 3.20 -> 4.31 -> 5.93 ms across a 16x pixel range with
//      non-overlapping min/max bands, which is what licensed the reading.
//
//      That same sweep is also the measurement worth having, not just a control: 16x the
//      pixels for 1.85x the time says the frame is NOT fill-bound, and `resolutionSplit`
//      turns the sweep into the fixed-vs-per-pixel decomposition that follows from it. In the
//      arena that split (fixed ~3.0 ms, fill ~0.7 ms) is what redirected the whole
//      investigation away from the shaders and onto the floor's batched geometry.
//
// Two usage rules learned the same day, both of which will silently corrupt a reading:
//
//   - **Stop the ticker first.** A live ticker mutates the scene between renders, so
//     consecutive samples are of different frames.
//   - **Attribute by hiding a RENDER GROUP ROOT, never a child inside one.** Hiding a child
//     of `layers.ground` invalidates that group and forces the batcher to repack ~550k floats,
//     which cost MORE than the geometry removed: the arena measured 4.52 ms with 322 floor
//     sprites hidden against 4.14 ms with them visible. Hiding `layers.ground` itself skips
//     the group with its cached instructions intact, and is trustworthy. `staticGraphics.ts`
//     documents the underlying policy; this is what it looks like from the measuring end.

/** The slice of `WebGL2RenderingContext` a timer query needs. Deliberately structural, so a
 *  test can pass a plain object instead of a real GL context — same trick as `glProbe`'s
 *  `CountableGl`. */
export interface TimerGl {
  getExtension(name: string): unknown;
  createQuery(): unknown;
  deleteQuery(q: unknown): void;
  beginQuery(target: number, q: unknown): void;
  endQuery(target: number): void;
  finish(): void;
  getParameter(p: number): unknown;
  getQueryParameter(q: unknown, p: number): unknown;
  readonly QUERY_RESULT_AVAILABLE: number;
  readonly QUERY_RESULT: number;
}

/** The `EXT_disjoint_timer_query_webgl2` surface. */
interface TimerExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** A median-of-samples reading, in milliseconds of GPU time per render. */
export interface MsSample {
  /** Median across the kept samples, or `null` if every sample was discarded. */
  ms: number | null;
  /** How many samples survived (a disjoint GPU clock discards one). */
  kept: number;
  /** How many were thrown away as disjoint — a high count means the reading is noise. */
  discarded: number;
  min: number;
  max: number;
}

const EMPTY_SAMPLE: MsSample = { ms: null, kept: 0, discarded: 0, min: 0, max: 0 };

/** Median rather than mean: one disjoint-adjacent outlier moves a mean of five by more than
 *  the effects being measured. The 2026-08-26 shield-filter pass got a "3.5x cheaper"
 *  reading from a mean that a median showed as a tie. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function summarise(kept: number[], discarded: number): MsSample {
  if (kept.length === 0) return { ...EMPTY_SAMPLE, discarded };
  return {
    ms: median(kept),
    kept: kept.length,
    discarded,
    min: Math.min(...kept),
    max: Math.max(...kept),
  };
}

/** Synchronous re-reads of `QUERY_RESULT_AVAILABLE` before yielding to the event loop.
 *
 * This is the primary path, and it does not await, for a reason that cost a measurement
 * (2026-08-26): **a background tab clamps `setTimeout` to about once per second.** A poll loop
 * built on `setTimeout(1)` therefore costs a SECOND per try there, and a run that needs a few
 * polls per sample stops looking like a slow measurement and starts looking like a hung page —
 * which is exactly how it presented, as repeated 45 s tool timeouts on a workload that had
 * completed in under two seconds an hour earlier. `gl.finish()` has already blocked until the
 * GPU is done by the time these run, so the first read normally succeeds and nothing yields. */
const SYNC_POLL_TRIES = 10_000;

/** How many 1 ms waits to allow after the synchronous polls are exhausted — a last resort for a
 *  driver that reports completion late, and deliberately small because each of these may cost a
 *  full second in a background tab. */
const RESULT_POLL_TRIES = 20;

/** Renders one frame of whatever is under test. Kept as a bare callback so this module needs
 *  no Pixi types and a test needs no renderer. */
export type RenderOnce = () => void;

export interface GpuTimerOptions {
  /** Injected for tests; defaults to a real 1 ms sleep. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * A GPU stopwatch over one GL context.
 *
 * `null` from {@link createGpuTimer} means the extension is absent — the honest answer on a
 * software rasterizer, and one to report rather than route around. (Note that "this machine
 * has no GPU timing" is a claim about a BROWSER SURFACE, not a machine: the in-app browser
 * pane here reports `Microsoft Basic Render Driver` with no extension, while real Chrome on
 * the same box reports `Intel Arc Pro` and supports it. Check the surface you are actually
 * measuring in before concluding a number cannot be had.)
 */
export class GpuTimer {
  private readonly gl: TimerGl;
  private readonly ext: TimerExt;
  private readonly render: RenderOnce;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(gl: TimerGl, ext: TimerExt, render: RenderOnce, opts: GpuTimerOptions = {}) {
    this.gl = gl;
    this.ext = ext;
    this.render = render;
    this.wait = opts.wait ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
  }

  /** Submit `n` renders untimed, to get shader compilation and buffer uploads out of the way.
   *  A cold first sample reads several times a warm one. */
  warm(n = 20): void {
    for (let i = 0; i < n; i += 1) this.render();
    this.gl.finish();
  }

  /**
   * One timed sample: `n` renders inside a single `TIME_ELAPSED_EXT` query, divided by `n`.
   *
   * Batching renders into one query is deliberate. A query has its own fixed cost, and a
   * single frame here is a few milliseconds, so one-render-per-query measures the query
   * almost as much as the frame. Returns `null` if the GPU clock went disjoint during the
   * query, which is the extension telling you the number is meaningless.
   */
  async sample(n = 8): Promise<number | null> {
    const { gl, ext } = this;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    for (let i = 0; i < n; i += 1) this.render();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    // Block until the GPU has actually done the work. Without this the result is simply not
    // available yet and the polls below spin for no reason.
    gl.finish();
    // Synchronous first (see SYNC_POLL_TRIES), yielding only if that runs out.
    for (let tries = 0; tries < SYNC_POLL_TRIES; tries += 1) {
      const done = this.readIfDone(q, n);
      if (done !== undefined) return done;
    }
    for (let tries = 0; tries < RESULT_POLL_TRIES; tries += 1) {
      await this.wait(1);
      const done = this.readIfDone(q, n);
      if (done !== undefined) return done;
    }
    gl.deleteQuery(q);
    return null;
  }

  /** `undefined` while the result is still pending; a number of ms, or `null` for a discarded
   *  (disjoint) sample, once it has landed. Reading `GPU_DISJOINT_EXT` also CLEARS it, so this
   *  must be read exactly once per completed query — hence one place that does it.
   *
   *  Note what a run of `null`s means: the GPU clock was repeatedly disturbed, which is the
   *  normal state of a BACKGROUNDED tab (its context gets preempted). Every sample discarding
   *  is the extension refusing to lie, not a bug here — the fix is to foreground the window,
   *  not to relax the check. */
  private readIfDone(q: unknown, n: number): number | null | undefined {
    const { gl, ext } = this;
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) !== true) return undefined;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true;
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    gl.deleteQuery(q);
    if (disjoint || typeof ns !== 'number') return null;
    return ns / 1e6 / n;
  }

  /** Median of `reps` samples of `n` renders each, disjoint samples discarded. */
  async median(n = 8, reps = 5): Promise<MsSample> {
    const kept: number[] = [];
    let discarded = 0;
    for (let i = 0; i < reps; i += 1) {
      const v = await this.sample(n);
      if (v === null) discarded += 1;
      else kept.push(v);
    }
    return summarise(kept, discarded);
  }
}

/** Build a timer over a live GL context, or `null` when the extension is unavailable. */
export function createGpuTimer(
  gl: TimerGl | null | undefined,
  render: RenderOnce,
  opts: GpuTimerOptions = {},
): GpuTimer | null {
  if (!gl) return null;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  if (!ext) return null;
  return new GpuTimer(gl, ext, render, opts);
}

/** One point of a resolution sweep: the scale that was applied and what it measured. */
export interface SweepPoint {
  /** Renderer resolution multiplier. Pixel count scales as the square of this. */
  resolution: number;
  sample: MsSample;
}

/** The fixed-vs-per-pixel decomposition of a resolution sweep. */
export interface CostSplit {
  /** Cost that does not change with pixel count: vertex work, batching, draw submission. */
  fixedMs: number;
  /** Cost at resolution 1.0 that DOES scale with pixel count: fill rate, filter passes. */
  fillMsAtRes1: number;
  /** `fillMsAtRes1` as a share of the resolution-1.0 total. Low means optimising shaders is
   *  the wrong place to look. */
  fillShare: number;
}

/**
 * Solve `ms = fixed + k * pixels` from the extreme points of a sweep.
 *
 * Two points are enough and the extremes are the most informative pair, since the widest
 * pixel-count ratio gives the best-conditioned estimate. Returns `null` unless at least two
 * points carry a usable median at distinct resolutions.
 *
 * This is the calculation that reframed the arena: 3.20 ms at resolution 0.5 and 5.93 ms at
 * 2.0 give a fixed cost of ~3.0 ms against ~0.7 ms of fill at native resolution, i.e. 80% of
 * the frame is geometry submission. A single number at one resolution cannot tell you that,
 * and the shape of the fix is completely different in the two cases.
 */
export function resolutionSplit(points: readonly SweepPoint[]): CostSplit | null {
  const usable = points
    .filter((p): p is SweepPoint & { sample: MsSample & { ms: number } } => p.sample.ms !== null)
    .sort((a, b) => a.resolution - b.resolution);
  // An early-out for readability, not for correctness: with one point `lo === hi`, so the
  // `pHi === pLo` guard below would return null anyway. Relaxing this to `< 1` therefore
  // survives its mutant, and that survivor is EQUIVALENT rather than a hole in the tests.
  if (usable.length < 2) return null;
  const lo = usable[0];
  const hi = usable[usable.length - 1];
  // Pixel count goes as resolution^2, so that — not the resolution — is the regressor.
  const pLo = lo.resolution * lo.resolution;
  const pHi = hi.resolution * hi.resolution;
  if (pHi === pLo) return null;
  const perPixel = (hi.sample.ms - lo.sample.ms) / (pHi - pLo);
  const fixedMs = lo.sample.ms - perPixel * pLo;
  const fillMsAtRes1 = perPixel;
  const totalAtRes1 = fixedMs + fillMsAtRes1;
  return {
    fixedMs,
    fillMsAtRes1,
    fillShare: totalAtRes1 === 0 ? 0 : fillMsAtRes1 / totalAtRes1,
  };
}

/**
 * Whether a sweep is allowed to be believed.
 *
 * Two independent ways for the reading to be junk, and one check each:
 *
 *  - the timer returns a constant regardless of load: the sweep's extremes must differ by
 *    more than the noise band of the samples themselves;
 *  - the harness is measuring itself: an empty target must cost far less than the subject.
 *
 * `emptyMs` is optional only because a caller may already know the floor; omitting it drops
 * that half of the contract, and `problems` says so.
 */
export function sweepTrust(
  points: readonly SweepPoint[],
  subjectMs: number | null,
  emptyMs: number | null,
): { trustworthy: boolean; problems: string[] } {
  const problems: string[] = [];
  const usable = points
    .filter((p): p is SweepPoint & { sample: MsSample & { ms: number } } => p.sample.ms !== null)
    .sort((a, b) => a.resolution - b.resolution);

  if (usable.length < 2) {
    problems.push('resolution sweep has fewer than two usable points: the timer was never shown to respond to load');
  } else {
    const lo = usable[0];
    const hi = usable[usable.length - 1];
    // "Moved more than the noise": the bands must not overlap. Comparing medians alone lets a
    // 0.02 ms drift between two noisy configs read as a response.
    if (hi.sample.min <= lo.sample.max) {
      problems.push(
        `resolution sweep did not clear its own noise (res ${lo.resolution} max ${lo.sample.max.toFixed(3)} ms vs ` +
          `res ${hi.resolution} min ${hi.sample.min.toFixed(3)} ms): the timer may be returning a constant`,
      );
    }
  }

  if (emptyMs === null) {
    problems.push('no empty-target control was taken: nothing rules out measuring harness overhead');
  } else if (subjectMs !== null && emptyMs > subjectMs * 0.25) {
    problems.push(
      `empty-target control cost ${emptyMs.toFixed(3)} ms against a subject of ${subjectMs.toFixed(3)} ms: ` +
        'too much of this reading is fixed overhead to attribute anything to the scene',
    );
  }

  // `>=`, not `>`: losing HALF a config's samples to a disturbed GPU clock is already enough to
  // stop believing that config's median. (This threshold survived its first mutation battery in
  // both directions, i.e. the tests pinned neither — so the rule is chosen here deliberately and
  // pinned below, rather than left to whichever comparison happened to get typed.)
  const anyDiscarded = points.some((p) => p.sample.discarded >= p.sample.kept && p.sample.discarded > 0);
  if (anyDiscarded) {
    problems.push('at least half of some config\'s samples were discarded as disjoint: the GPU clock was unstable');
  }

  return { trustworthy: problems.length === 0, problems };
}
