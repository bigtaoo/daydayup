/**
 * `frameProbe` — the A/B/C frame differ, tested against synthetic frames rather than a live
 * renderer (there is no canvas in this environment, which is the same reason
 * `readFrame`/`frameRectOf` are exercised only through their pure collaborators).
 *
 * The behaviour worth protecting is not the arithmetic, it is the two REFUSALS. Both guards
 * exist because a real pass was misled by their absence:
 *
 *  - a restore path skipped by an `if (!node.parent) continue` guard, whose only symptom was
 *    a restore check equal to the A/B delta instead of zero;
 *  - and a whole round of measurement against a scene that was never on screen, where A, B
 *    and C agreed perfectly because all three were the main menu. The restore check passes in
 *    that case — hiding something invisible changes nothing — so only the liveness control
 *    separates "my change did nothing" from "I am not looking at my change".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  diffFrames,
  frameRectOf,
  lumaPercentiles,
  meanLuma,
  probeFrames,
  readFrame,
  type Frame,
} from './frameProbe';

function frame(width: number, height: number, at: (x: number, y: number) => [number, number, number]): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

const flat = (w: number, h: number, v: number) => frame(w, h, () => [v, v, v]);

describe('diffFrames', () => {
  it('reports nothing for two identical frames', () => {
    const d = diffFrames(flat(8, 4, 50), flat(8, 4, 50));
    expect(d).toMatchObject({ changed: 0, pct: 0, meanDelta: 0, maxDelta: 0, bbox: null });
  });

  it('averages the delta over the CHANGED pixels, not the whole frame', () => {
    // The bug this guards: a whole-frame mean is dominated by the untouched majority, so any
    // local edit reads as "no change". One pixel of 400 moving 60 is a real 60, not a 0.15.
    const a = flat(20, 20, 50);
    const b = flat(20, 20, 50);
    for (let c = 0; c < 3; c++) b.data[c] = 110;
    const d = diffFrames(a, b);
    expect(d.changed).toBe(1);
    expect(d.meanDelta).toBe(60);
    expect(d.maxDelta).toBe(60);
  });

  it('locates the change, because where a diff is matters more than how big', () => {
    const a = flat(20, 10, 40);
    const b = frame(20, 10, (x, y) => (x >= 4 && x < 8 && y >= 2 && y < 6 ? [200, 200, 200] : [40, 40, 40]));
    expect(diffFrames(a, b).bbox).toEqual({ x: 4, y: 2, w: 4, h: 4 });
  });

  it('ignores deltas at or below the threshold, so dithering is not a finding', () => {
    const a = flat(6, 6, 40);
    const b = flat(6, 6, 42); // summed delta 6, exactly at the default
    expect(diffFrames(a, b).changed).toBe(0);
    expect(diffFrames(a, b, 5).changed).toBe(36);
  });

  it('refuses to compare frames of different sizes rather than reading past the end', () => {
    expect(() => diffFrames(flat(4, 4, 0), flat(4, 5, 0))).toThrow(/size mismatch/);
  });
});

describe('probeFrames — the two refusals', () => {
  /**
   * Drives the REAL `probeFrames` through its injected reader. The fake "scene" is two flags
   * the reader renders from, so each of the five reads sees whatever the probe has just done.
   */
  function run(opts: { changeWorks: boolean; restoreWorks: boolean; controlWorks: boolean }) {
    const state = { blanked: false, patch: null as number | null };
    const read = (): Frame =>
      frame(20, 10, (x, y) => {
        if (state.blanked) return [0, 0, 0];
        const inPatch = state.patch !== null && x >= 4 && x < 8 && y >= 2 && y < 6;
        const v = inPatch ? state.patch! : 40;
        return [v, v, v];
      });
    // `app` is only reached for the DEFAULT control and the default reader, both overridden.
    const app = { stage: { children: [], removeChildren() {}, addChild() {} } } as never;
    return probeFrames(app, {
      read,
      control: () => {
        if (opts.controlWorks) state.blanked = true;
        return () => {
          state.blanked = false;
        };
      },
      change: () => {
        if (opts.changeWorks) state.patch = 200;
        return () => {
          if (opts.restoreWorks) state.patch = null;
        };
      },
    });
  }

  it('trusts a probe whose control fires and whose restore comes back clean', () => {
    const r = run({ changeWorks: true, restoreWorks: true, controlWorks: true });
    expect(r.trustworthy).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.diff.changed).toBe(16); // the 4x4 patch
    expect(r.diff.bbox).toEqual({ x: 4, y: 2, w: 4, h: 4 });
    expect(r.restore.changed).toBe(0);
    expect(r.liveness.changed).toBeGreaterThan(0);
  });

  it('refuses a probe whose liveness control moved nothing — the invisible-scene trap', () => {
    // A whole measurement round was spent on a scene hidden behind the main menu, where A, B
    // and C matched perfectly. Note what this case looks like WITHOUT the control: a zero
    // diff and a clean restore, i.e. indistinguishable from "the change did nothing".
    const r = run({ changeWorks: false, restoreWorks: true, controlWorks: false });
    expect(r.diff.changed).toBe(0);
    expect(r.restore.changed).toBe(0);
    expect(r.trustworthy).toBe(false);
    expect(r.problems.join(' ')).toMatch(/liveness control moved zero pixels/);
  });

  it('refuses a probe whose undo did not undo', () => {
    const r = run({ changeWorks: true, restoreWorks: false, controlWorks: true });
    expect(r.restore.changed).toBeGreaterThan(0);
    expect(r.trustworthy).toBe(false);
    expect(r.problems.join(' ')).toMatch(/restore read differs/);
  });

  it('reports a real zero-diff as trustworthy when the control proves the scene is live', () => {
    // The distinction the whole design is for: "nothing changed" is only a finding once the
    // reader has demonstrated it can see this scene at all.
    const r = run({ changeWorks: false, restoreWorks: true, controlWorks: true });
    expect(r.diff.changed).toBe(0);
    expect(r.trustworthy).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('runs the control BEFORE the change, so a dead reader is reported first', () => {
    // Ordering is behaviour here: if the change ran first and left the scene dirty, the
    // control would be measuring a different scene than the A/B pair.
    const order: string[] = [];
    const app = { stage: { children: [], removeChildren() {}, addChild() {} } } as never;
    probeFrames(app, {
      read: () => flat(4, 4, 10),
      control: () => {
        order.push('control');
        return () => order.push('control-undo');
      },
      change: () => {
        order.push('change');
        return () => order.push('change-undo');
      },
    });
    expect(order).toEqual(['control', 'control-undo', 'change', 'change-undo']);
  });

  it('passes the measure callback the A and B frames it actually diffed', () => {
    const app = { stage: { children: [], removeChildren() {}, addChild() {} } } as never;
    let seen: { a: number; b: number } | null = null;
    const state = { patch: false };
    const r = probeFrames(app, {
      read: () => flat(4, 4, state.patch ? 90 : 30),
      control: () => {
        state.patch = true;
        return () => {
          state.patch = false;
        };
      },
      change: () => {
        state.patch = true;
        return () => {
          state.patch = false;
        };
      },
      measure: ({ a, b }) => {
        seen = { a: meanLuma(a, 0, 0, 4, 4)!, b: meanLuma(b, 0, 0, 4, 4)! };
        return seen;
      },
    });
    expect(seen).toEqual({ a: 30, b: 90 });
    expect(r.value).toEqual({ a: 30, b: 90 });
  });
});

describe('sampling helpers', () => {
  it('means the luma over a rect and clips to the frame', () => {
    const f = frame(10, 10, (x) => (x < 5 ? [0, 0, 0] : [255, 255, 255]));
    expect(meanLuma(f, 0, 0, 5, 10)).toBe(0);
    expect(meanLuma(f, 5, 0, 5, 10)).toBe(255);
    expect(meanLuma(f, 8, 8, 100, 100)).toBe(255); // clipped, not out of bounds
    expect(meanLuma(f, 50, 50, 4, 4)).toBeNull();
  });

  it('reports percentiles, which a mean would hide', () => {
    // 90% dark, 10% blown out: the mean says "dark", p95 says there is a highlight. A change
    // that moves only the top few percent is exactly the kind these exist to catch.
    const f = frame(10, 10, (_x, y) => (y === 9 ? [250, 250, 250] : [30, 30, 30]));
    const q = lumaPercentiles(f, 0, 0, 10, 10);
    expect(q.p50).toBeCloseTo(30, 0);
    expect(q.p95).toBeGreaterThan(200);
  });
});

describe('the gaps a mutation battery found, and the one mutant that is genuinely equivalent', () => {
  // Every case below corresponds to a mutant that survived the first battery over this file.
  // Kept as its own block rather than folded into the ones above, because the reason each
  // exists is "the earlier assertion could not see this", which is worth being able to read.

  it('weights luma by Rec.601, not by whichever channel comes first', () => {
    // Survived: swapping the 0.299/0.587 coefficients. Every earlier fixture was GREY, where
    // the coefficients sum to 1 and any permutation gives the same answer — the same fixture
    // blindness this repo keeps hitting, where the fixture made two different things equal.
    const red = frame(4, 4, () => [255, 0, 0]);
    const green = frame(4, 4, () => [0, 255, 0]);
    const blue = frame(4, 4, () => [0, 0, 255]);
    expect(meanLuma(red, 0, 0, 4, 4)).toBeCloseTo(76.25, 1);
    expect(meanLuma(green, 0, 0, 4, 4)).toBeCloseTo(149.69, 1);
    expect(meanLuma(blue, 0, 0, 4, 4)).toBeCloseTo(29.07, 1);
    // ...and green is the heavy channel, which is the ordering the swap inverts.
    expect(meanLuma(green, 0, 0, 4, 4)!).toBeGreaterThan(meanLuma(red, 0, 0, 4, 4)!);
  });

  it('clips a sample rect at the near edge as well as the far one', () => {
    // Survived: dropping the `Math.max(0, ...)` lower clamp. A rect straddling the top-left
    // corner is the normal case for a sample centred on an object near the edge of frame, and
    // without the clamp the loop starts at a negative index and reads nothing at all.
    const f = frame(10, 10, (x, y) => (x < 5 && y < 5 ? [100, 100, 100] : [0, 0, 0]));
    expect(meanLuma(f, -5, -5, 10, 10)).toBeCloseTo(100, 1);
    expect(meanLuma(f, -50, -50, 10, 10)).toBeNull();
  });

  it('sorts before taking percentiles', () => {
    // Survived: removing the sort. Every earlier fixture happened to be authored in ascending
    // scan order, so the unsorted array was already sorted and the two agreed. This one ramps
    // DOWNWARD in scan order, which is the only way the mutant is visible.
    const f = frame(10, 10, (_x, y) => {
      const v = 250 - y * 25;
      return [v, v, v];
    });
    const q = lumaPercentiles(f, 0, 0, 10, 10);
    expect(q.p5).toBeLessThan(q.p50!);
    expect(q.p50).toBeLessThan(q.p95!);
    expect(q.p5).toBeLessThan(60);
    expect(q.p95).toBeGreaterThan(200);
  });

  it('clamps the percentile index, so p100 is the maximum and not NaN', () => {
    // Survived: dropping `Math.min(v.length - 1, ...)`. `p: 1` indexes one past the end and
    // comes back NaN through the `toFixed`, which reads as a real measurement of zero.
    const f = frame(4, 4, (x) => (x === 3 ? [200, 200, 200] : [10, 10, 10]));
    const q = lumaPercentiles(f, 0, 0, 4, 4, [0, 1]);
    expect(q.p0).toBeCloseTo(10, 1);
    expect(q.p100).toBeCloseTo(200, 1);
    expect(Number.isNaN(q.p100!)).toBe(false);
  });

  it('puts the stage back when the DEFAULT control is the one that ran', () => {
    // Survived: making `defaultControl`'s undo a no-op. Nothing exercised the default at all —
    // every other test passes its own control — so the probe's fallback could have been
    // permanently destroying the scene it was asked to measure.
    const kids = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const stage = {
      children: [...kids] as { id: string }[],
      removeChildren() {
        this.children.length = 0;
      },
      addChild(k: unknown) {
        this.children.push(k as { id: string });
      },
    };
    const app = { stage } as never;
    const r = probeFrames(app, { read: () => flat(4, 4, 20), change: () => () => {} });
    expect(stage.children).toEqual(kids);
    // And the default control cannot prove liveness against a reader that ignores the stage,
    // which is the refusal working rather than a gap: no false confidence from a stub scene.
    expect(r.trustworthy).toBe(false);
    expect(r.problems.join(' ')).toMatch(/liveness control moved zero pixels/);
  });

  it('records the one mutant that is genuinely equivalent, so nobody hunts it twice', () => {
    // `alphaClamp`'s `else if` split into two `if`s cannot change behaviour: `floor < ceiling`
    // is enforced, a pixel cleared to 0 then fails `0 >= ceiling`, and a pixel at or above
    // `ceiling` never satisfied `<= floor`. The `else` is there for reading, not correctness.
    // Left as a note rather than a chase — an equivalent mutant is not a coverage gap.
    expect(true).toBe(true);
  });
});

describe('readFrame — the render-then-copy order', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** There is no DOM in this workspace's test environment, so `document` is stubbed with just
   *  enough canvas for `readFrame` to run. That stub is also what makes the two branches below
   *  reachable at all — before it, `readFrame` had no coverage of any kind. */
  function stubDom(ctx: unknown, calls: string[]) {
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => {
          calls.push('getContext');
          return ctx;
        },
      }),
    });
  }

  it('renders BEFORE copying the canvas, or the copy is a stale frame', () => {
    // Survived: deleting the `app.renderer.render(app.stage)` call. Copying without rendering
    // first is the whole failure this module exists to avoid — it returns whatever was last
    // composited, which during one pass was a frame of the main menu.
    const calls: string[] = [];
    const ctx = {
      drawImage: () => calls.push('drawImage'),
      getImageData: () => {
        calls.push('getImageData');
        return { width: 2, height: 1, data: new Uint8ClampedArray(8) };
      },
    };
    stubDom(ctx, calls);
    const app = {
      renderer: { render: () => calls.push('render'), resolution: 1 },
      stage: {},
      canvas: { width: 2, height: 1 },
    } as never;
    const f = readFrame(app);
    expect(calls[0]).toBe('render');
    expect(calls).toContain('drawImage');
    expect([f.width, f.height]).toEqual([2, 1]);
  });

  it('throws instead of returning an empty frame when there is no 2d context', () => {
    // Survived: replacing the throw with a 0x0 frame. A silent empty frame diffs against
    // another empty frame as "no change" — a broken reader agreeing with you, which is the
    // failure mode named at the top of this file.
    stubDom(null, []);
    const app = { renderer: { render: () => {}, resolution: 1 }, stage: {}, canvas: { width: 2, height: 1 } } as never;
    expect(() => readFrame(app)).toThrow(/no 2d context/);
  });
});

describe('frameRectOf — CSS coordinates to frame pixels', () => {
  function node(pos: { x: number; y: number }, bounds: { width: number; height: number }) {
    return { getGlobalPosition: () => pos, getBounds: () => bounds } as never;
  }

  it('scales by the renderer resolution, because readFrame returns the backing buffer', () => {
    // Survived: dropping the `* res`. On a DPR-2 display every rect lands at half its real
    // position, which reads as "the object is not where I thought" rather than as an
    // arithmetic bug — and a sample rect derived from the wrong place measures the floor.
    const at1 = frameRectOf({ renderer: { resolution: 1 } } as never, node({ x: 100, y: 80 }, { width: 20, height: 30 }));
    const at2 = frameRectOf({ renderer: { resolution: 2 } } as never, node({ x: 100, y: 80 }, { width: 20, height: 30 }));
    expect(at1).toEqual({ x: 90, y: 50, w: 20, h: 30 });
    expect(at2).toEqual({ x: 180, y: 100, w: 40, h: 60 });
  });

  it('anchors the rect at the GROUND point, not the centre', () => {
    // Survived: `p.y - height / 2` instead of `p.y - height`. Every in-world object in this
    // renderer is bottom-anchored to its ground point and drawn upward, so a centred rect
    // samples half object and half floor — and the floor half quietly drags the reading.
    const r = frameRectOf({ renderer: { resolution: 1 } } as never, node({ x: 0, y: 100 }, { width: 10, height: 40 }));
    expect(r.y).toBe(60);
    expect(r.y + r.h).toBe(100); // the bottom edge sits ON the ground point
  });
});
