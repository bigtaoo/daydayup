import { describe, expect, it, vi } from 'vitest';
import {
  GpuTimer,
  createGpuTimer,
  resolutionSplit,
  sweepTrust,
  type MsSample,
  type SweepPoint,
  type TimerGl,
} from './gpuTimer';

const TIME_ELAPSED = 0x88bf;
const GPU_DISJOINT = 0x8fbb;
const QUERY_RESULT_AVAILABLE = 0x8867;
const QUERY_RESULT = 0x8866;

interface FakeOpts {
  /** Nanoseconds each query reports, in order. A `null` entry marks that query disjoint. */
  results: (number | null)[];
  /** Withhold the result for this many polls before making it available. */
  availableAfter?: number;
  /** Never make a result available — the driver-disagrees path. */
  neverAvailable?: boolean;
  ext?: boolean;
}

function fakeGl(opts: FakeOpts) {
  const log = {
    renders: 0,
    finishes: 0,
    created: 0,
    deleted: 0,
    begun: [] as number[],
    ended: [] as number[],
  };
  let queryIndex = -1;
  let polls = 0;
  const gl: TimerGl = {
    getExtension: (name) =>
      name === 'EXT_disjoint_timer_query_webgl2' && opts.ext !== false
        ? { TIME_ELAPSED_EXT: TIME_ELAPSED, GPU_DISJOINT_EXT: GPU_DISJOINT }
        : null,
    createQuery: () => {
      log.created += 1;
      queryIndex += 1;
      polls = 0;
      return { id: queryIndex };
    },
    deleteQuery: () => {
      log.deleted += 1;
    },
    beginQuery: (target) => log.begun.push(target),
    endQuery: (target) => log.ended.push(target),
    finish: () => {
      log.finishes += 1;
    },
    getParameter: (p) => (p === GPU_DISJOINT ? opts.results[queryIndex] === null : undefined),
    getQueryParameter: (q, p) => {
      const idx = (q as { id: number }).id;
      if (p === QUERY_RESULT_AVAILABLE) {
        if (opts.neverAvailable) return false;
        polls += 1;
        return polls > (opts.availableAfter ?? 0);
      }
      if (p === QUERY_RESULT) return opts.results[idx] ?? 0;
      return undefined;
    },
    QUERY_RESULT_AVAILABLE,
    QUERY_RESULT,
  };
  return { gl, log };
}

function timerFor(opts: FakeOpts) {
  const { gl, log } = fakeGl(opts);
  const wait = vi.fn(async () => {});
  const timer = createGpuTimer(gl, () => {
    log.renders += 1;
  }, { wait });
  return { timer, log, wait };
}

/** A finished `MsSample`, for the pure helpers. */
function s(ms: number | null, min = ms ?? 0, max = ms ?? 0, kept = 5, discarded = 0): MsSample {
  return { ms, kept, discarded, min, max };
}

describe('createGpuTimer', () => {
  it('is null without a GL context, and null when the extension is missing', () => {
    expect(createGpuTimer(null, () => {})).toBeNull();
    expect(createGpuTimer(undefined, () => {})).toBeNull();
    const { gl } = fakeGl({ results: [], ext: false });
    expect(createGpuTimer(gl, () => {})).toBeNull();
  });

  it('builds a timer when the extension is present', () => {
    const { timer } = timerFor({ results: [1e6] });
    expect(timer).toBeInstanceOf(GpuTimer);
  });
});

describe('GpuTimer.sample', () => {
  it('divides the query result by the render count, converting ns to ms', async () => {
    // 8 renders reported as 32,000,000 ns = 32 ms total => 4 ms per render.
    const { timer, log } = timerFor({ results: [32_000_000] });
    await expect(timer!.sample(8)).resolves.toBe(4);
    expect(log.renders).toBe(8);
  });

  it('brackets exactly the renders it times, and blocks on finish before polling', async () => {
    const { timer, log } = timerFor({ results: [8_000_000] });
    await timer!.sample(4);
    expect(log.begun).toEqual([TIME_ELAPSED]);
    expect(log.ended).toEqual([TIME_ELAPSED]);
    // One finish per sample, and it must happen — without it the result is simply not ready.
    expect(log.finishes).toBe(1);
    expect(log.created).toBe(1);
    expect(log.deleted).toBe(1);
  });

  it('returns null when the GPU clock went disjoint, rather than a plausible number', async () => {
    const { timer } = timerFor({ results: [null] });
    await expect(timer!.sample(8)).resolves.toBeNull();
  });

  it('polls a late result WITHOUT yielding — a background tab clamps setTimeout to ~1s', async () => {
    const { timer, wait } = timerFor({ results: [16_000_000], availableAfter: 3 });
    await expect(timer!.sample(8)).resolves.toBe(2);
    // The whole point of the synchronous path: three retries must not cost three timer waits.
    expect(wait).not.toHaveBeenCalled();
  });

  it('still falls back to yielding when the synchronous polls are exhausted', async () => {
    // Needs more polls than SYNC_POLL_TRIES, so the async tail has to finish the job.
    const { timer, wait } = timerFor({ results: [16_000_000], availableAfter: 10_004 });
    await expect(timer!.sample(8)).resolves.toBe(2);
    expect(wait).toHaveBeenCalled();
    expect(wait.mock.calls.length).toBeLessThan(20);
  });

  it('gives up and frees the query when a result never arrives', async () => {
    const { timer, log, wait } = timerFor({ results: [16_000_000], neverAvailable: true });
    await expect(timer!.sample(8)).resolves.toBeNull();
    expect(log.deleted).toBe(1);
    // Bounded, not an infinite spin.
    expect(wait.mock.calls.length).toBeGreaterThan(10);
    expect(wait.mock.calls.length).toBeLessThan(1000);
  });
});

describe('GpuTimer.warm', () => {
  it('renders the requested count untimed and flushes', () => {
    const { timer, log } = timerFor({ results: [] });
    timer!.warm(12);
    expect(log.renders).toBe(12);
    expect(log.finishes).toBe(1);
    expect(log.created).toBe(0); // untimed: no query at all
  });
});

describe('GpuTimer.median', () => {
  it('reports the MEDIAN, not the mean — one outlier must not move the reading', async () => {
    // Per-render ms for n=1: 3, 3, 3, 3, 100. mean = 22.4, median = 3.
    const ns = [3, 3, 3, 3, 100].map((ms) => ms * 1e6);
    const { timer } = timerFor({ results: ns });
    const out = await timer!.median(1, 5);
    expect(out.ms).toBe(3);
    expect(out.max).toBe(100);
    expect(out.min).toBe(3);
    expect(out.kept).toBe(5);
  });

  it('discards disjoint samples and counts them', async () => {
    const { timer } = timerFor({ results: [2e6, null, 4e6, null, 6e6] });
    const out = await timer!.median(1, 5);
    expect(out.kept).toBe(3);
    expect(out.discarded).toBe(2);
    expect(out.ms).toBe(4);
  });

  it('takes the upper-middle sample on an EVEN count, so sort order is pinned', async () => {
    // 4 kept samples: 1, 2, 3, 100 ms. Ascending picks index 2 => 3. A descending sort would
    // pick 2 from the same set, and every odd-count test above cannot tell the two apart.
    const { timer } = timerFor({ results: [1e6, 2e6, 3e6, 100e6] });
    const out = await timer!.median(1, 4);
    expect(out.kept).toBe(4);
    expect(out.ms).toBe(3);
  });

  it('reports ms null when every sample was disjoint', async () => {
    const { timer } = timerFor({ results: [null, null, null] });
    const out = await timer!.median(1, 3);
    expect(out.ms).toBeNull();
    expect(out.kept).toBe(0);
    expect(out.discarded).toBe(3);
  });
});

describe('resolutionSplit', () => {
  it('separates fixed from per-pixel cost using the arena reading that motivated it', () => {
    // Measured on arena_launch, 1920x855, 2026-08-26.
    const split = resolutionSplit([
      { resolution: 0.5, sample: s(3.203, 2.601, 3.661) },
      { resolution: 1.0, sample: s(4.313, 3.163, 4.84) },
      { resolution: 2.0, sample: s(5.927, 5.423, 6.187) },
    ])!;
    // pixels go 0.25 -> 4 (16x); ms goes 3.203 -> 5.927 (1.85x).
    expect(split.fillMsAtRes1).toBeCloseTo((5.927 - 3.203) / (4 - 0.25), 6);
    expect(split.fixedMs).toBeCloseTo(3.203 - split.fillMsAtRes1 * 0.25, 6);
    // The finding: the frame is dominated by resolution-INDEPENDENT work.
    expect(split.fixedMs).toBeGreaterThan(2.8);
    expect(split.fixedMs).toBeLessThan(3.2);
    expect(split.fillShare).toBeLessThan(0.25);
  });

  it('regresses on pixel count (resolution squared), not on resolution', () => {
    // Cost that is PURELY per-pixel: ms = 4 * resolution^2, so fixed must come out at 0.
    // Regressing on resolution instead would report a non-zero fixed cost here.
    const split = resolutionSplit([
      { resolution: 1.0, sample: s(4) },
      { resolution: 2.0, sample: s(16) },
    ])!;
    expect(split.fixedMs).toBeCloseTo(0, 9);
    expect(split.fillMsAtRes1).toBeCloseTo(4, 9);
    expect(split.fillShare).toBeCloseTo(1, 9);
  });

  it('reports a purely fixed cost as zero fill', () => {
    const split = resolutionSplit([
      { resolution: 0.5, sample: s(2.15) },
      { resolution: 2.0, sample: s(2.15) },
    ])!;
    expect(split.fillMsAtRes1).toBeCloseTo(0, 9);
    expect(split.fixedMs).toBeCloseTo(2.15, 9);
    expect(split.fillShare).toBeCloseTo(0, 9);
  });

  it('reports fillShare 0 rather than NaN when the whole sweep measured zero', () => {
    // Reachable, and by the most important caller: the empty-target CONTROL reads 0.000 ms at
    // every resolution. Without the zero guard this is 0/0 and the control's own split is NaN.
    const split = resolutionSplit([
      { resolution: 0.5, sample: s(0) },
      { resolution: 2.0, sample: s(0) },
    ])!;
    expect(split.fillShare).toBe(0);
    expect(Number.isNaN(split.fillShare)).toBe(false);
    expect(split.fixedMs).toBe(0);
  });

  it('is null when there is nothing to solve', () => {
    expect(resolutionSplit([])).toBeNull();
    expect(resolutionSplit([{ resolution: 1, sample: s(4) }])).toBeNull();
    // Two points at the SAME resolution carry no gradient.
    expect(resolutionSplit([
      { resolution: 1, sample: s(4) },
      { resolution: 1, sample: s(5) },
    ])).toBeNull();
    // Unusable samples do not count towards the two.
    expect(resolutionSplit([
      { resolution: 0.5, sample: s(null) },
      { resolution: 2.0, sample: s(6) },
    ])).toBeNull();
  });
});

describe('sweepTrust', () => {
  const goodSweep: SweepPoint[] = [
    { resolution: 0.5, sample: s(3.203, 2.601, 3.661) },
    { resolution: 2.0, sample: s(5.927, 5.423, 6.187) },
  ];

  it('accepts the real arena run: bands clear, control is a floor', () => {
    const t = sweepTrust(goodSweep, 4.05, 0);
    expect(t.problems).toEqual([]);
    expect(t.trustworthy).toBe(true);
  });

  it('rejects a sweep whose bands OVERLAP, even though its medians differ', () => {
    // Medians 4.00 -> 4.10 look like a response; the bands say it is noise.
    const t = sweepTrust(
      [
        { resolution: 0.5, sample: s(4.0, 3.5, 4.6) },
        { resolution: 2.0, sample: s(4.1, 3.6, 4.7) },
      ],
      4.05,
      0,
    );
    expect(t.trustworthy).toBe(false);
    expect(t.problems.join(' ')).toMatch(/did not clear its own noise/);
  });

  it('rejects a timer that never responded to load at all', () => {
    const t = sweepTrust([{ resolution: 1, sample: s(4) }], 4, 0);
    expect(t.trustworthy).toBe(false);
    expect(t.problems.join(' ')).toMatch(/fewer than two usable points/);
  });

  it('rejects a reading with no empty-target control', () => {
    const t = sweepTrust(goodSweep, 4.05, null);
    expect(t.trustworthy).toBe(false);
    expect(t.problems.join(' ')).toMatch(/no empty-target control/);
  });

  it('rejects a reading that is mostly harness overhead', () => {
    // An empty stage costing 3 ms against a 4 ms subject means the scene is not what is
    // being measured — this is the check that licensed the arena attribution.
    const t = sweepTrust(goodSweep, 4.0, 3.0);
    expect(t.trustworthy).toBe(false);
    expect(t.problems.join(' ')).toMatch(/too much of this reading is fixed overhead/);
  });

  it('accepts a small-but-real control and rejects one just over the line', () => {
    expect(sweepTrust(goodSweep, 4.0, 0.9).trustworthy).toBe(true);
    expect(sweepTrust(goodSweep, 4.0, 1.1).trustworthy).toBe(false);
  });

  it('treats bands that merely TOUCH as overlapping — touching is not clearance', () => {
    // hi.min === lo.max exactly: there is no gap, so the sweep has not cleared its noise.
    const t = sweepTrust(
      [
        { resolution: 0.5, sample: s(3.2, 2.6, 4.0) },
        { resolution: 2.0, sample: s(5.9, 4.0, 6.2) },
      ],
      4.05,
      0,
    );
    expect(t.trustworthy).toBe(false);
    expect(t.problems.join(' ')).toMatch(/did not clear its own noise/);
  });

  it('rejects a config that lost exactly HALF its samples, not just more than half', () => {
    // 2 kept / 2 discarded is already too much loss to believe that config's median.
    const t = sweepTrust(
      [
        { resolution: 0.5, sample: s(3.2, 2.6, 3.7, 2, 2) },
        { resolution: 2.0, sample: s(5.9, 5.4, 6.2, 5, 0) },
      ],
      4.05,
      0,
    );
    expect(t.trustworthy).toBe(false);
    expect(t.problems.join(' ')).toMatch(/discarded as disjoint/);
  });

  it('does not complain about discards when there were none', () => {
    // Guards the `discarded > 0` half: kept 0 / discarded 0 must not read as "half were lost".
    const t = sweepTrust(
      [
        { resolution: 0.5, sample: s(3.2, 2.6, 3.7, 5, 0) },
        { resolution: 2.0, sample: s(5.9, 5.4, 6.2, 5, 0) },
      ],
      4.05,
      0,
    );
    expect(t.problems.join(' ')).not.toMatch(/disjoint/);
  });

  it('does not call a zero-rep sample a disjoint problem', () => {
    // kept 0 / discarded 0 is a config nothing was sampled for. `discarded >= kept` alone is
    // vacuously true there, so without the `discarded > 0` clause this reports a GPU-clock
    // problem that never happened, on top of the real "no usable points" one.
    const t = sweepTrust(
      [
        { resolution: 0.5, sample: s(null, 0, 0, 0, 0) },
        { resolution: 2.0, sample: s(null, 0, 0, 0, 0) },
      ],
      null,
      0,
    );
    expect(t.problems.join(' ')).not.toMatch(/disjoint/);
    expect(t.problems.join(' ')).toMatch(/fewer than two usable points/);
  });

  it('rejects a run whose samples were mostly thrown away', () => {
    const unstable: SweepPoint[] = [
      { resolution: 0.5, sample: s(3.2, 2.6, 3.7, 1, 4) },
      { resolution: 2.0, sample: s(5.9, 5.4, 6.2, 5, 0) },
    ];
    const t = sweepTrust(unstable, 4.05, 0);
    expect(t.trustworthy).toBe(false);
    expect(t.problems.join(' ')).toMatch(/discarded as disjoint/);
  });

  it('names every distinct problem at once rather than stopping at the first', () => {
    const t = sweepTrust([{ resolution: 1, sample: s(4) }], 4, null);
    expect(t.problems).toHaveLength(2);
  });
});
