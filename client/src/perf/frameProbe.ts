// A/B/C frame differencing for art work — the "get a real frame out and measure it" loop
// that `perf/README.md` had only as a console snippet to retype by hand, plus the controls
// that snippet was missing.
//
// Why a module rather than a snippet. For art, the source file is not evidence and neither
// is looking at the screen: the only way to know whether a change did what it claims is to
// grab the composited frame twice and diff it. Every previous pass rebuilt that by hand, and
// each one paid for a different way of getting it wrong:
//
//   - `gl.readPixels` on this canvas returns a STALE frame (`antialias: true` +
//     `preserveDrawingBuffer: false`, so the resolved default framebuffer only updates on a
//     page composite). Hiding all 27 wall shadings once reported zero difference — a broken
//     harness agreeing with you.
//   - `renderer.extract.pixels` on a custom region reads screen-space filters at the wrong
//     place, so 25 of 27 wall blocks came back at mean luma 0 where a dark overlay is a
//     genuine no-op.
//   - A restore path skipped by an `if (!node.parent) continue` guard made the "restore
//     check" equal the A/B delta instead of zero.
//   - And the one that cost the most time (2026-08-24): every diff read zero because the
//     scene under test was never on screen at all. `Game.beginRun()` is reachable from the
//     console and sets up a whole run, but it does not hide the main menu, which is drawn
//     over everything in `layers.ui`. A/B/C all agreed perfectly, on a frame of the menu.
//
// That last one is why `probeFrames` REQUIRES a liveness control and refuses to report
// without it. The C-equals-A restore check cannot catch it: when the subject is not being
// drawn, hiding it changes nothing and the restore check passes. Only "make a change the
// frame must show, and confirm it does" separates "my edit had no effect" from "I am not
// looking at my edit".
import type { Application, Container } from 'pixi.js';

export interface Frame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface FrameDiff {
  /** Pixels whose summed |RGB| delta exceeds the threshold. */
  changed: number;
  /** ...as a percentage of the frame. */
  pct: number;
  /** Mean per-channel delta over the changed pixels only — a whole-frame mean is dominated
   *  by the untouched majority and reads as "no change" for any local edit. */
  meanDelta: number;
  /** Largest single per-channel delta anywhere. */
  maxDelta: number;
  /** Bounding box of the changed region, `null` if nothing changed. Answering WHERE a diff
   *  is has repeatedly mattered more than how big it is. */
  bbox: { x: number; y: number; w: number; h: number } | null;
}

export interface ProbeResult<T> {
  /** The A/B diff — what the change under test actually did to the frame. */
  diff: FrameDiff;
  /** C vs A. Anything non-zero means the restore path is broken and `diff` is fiction. */
  restore: FrameDiff;
  /** The control's diff: proof the reader can see this scene at all. */
  liveness: FrameDiff;
  /** True only if the control moved pixels AND the restore came back clean. */
  trustworthy: boolean;
  /** Why not, when `trustworthy` is false. */
  problems: string[];
  value: T;
}

/**
 * Read the composited frame. `render()` first, then `drawImage` off the canvas — NOT
 * `readPixels`, for the reason in the module comment. Returns raw RGBA at the renderer's own
 * resolution, so a DPR-2 frame is twice the CSS size on each axis.
 */
export function readFrame(app: Application): Frame {
  app.renderer.render(app.stage);
  const src = app.canvas as HTMLCanvasElement;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('frameProbe: no 2d context for the read-back canvas');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** Per-pixel RGB difference between two frames of the same size. */
export function diffFrames(a: Frame, b: Frame, threshold = 6): FrameDiff {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`frameProbe: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let changed = 0;
  let sum = 0;
  let maxDelta = 0;
  let minX = a.width;
  let minY = a.height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i]! - b.data[i]!);
    const dg = Math.abs(a.data[i + 1]! - b.data[i + 1]!);
    const db = Math.abs(a.data[i + 2]! - b.data[i + 2]!);
    const total = dr + dg + db;
    if (total <= threshold) continue;
    changed++;
    sum += total / 3;
    const biggest = Math.max(dr, dg, db);
    if (biggest > maxDelta) maxDelta = biggest;
    const px = (i / 4) % a.width;
    const py = Math.floor(i / 4 / a.width);
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  return {
    changed,
    pct: +((changed / (a.width * a.height)) * 100).toFixed(3),
    meanDelta: changed ? +(sum / changed).toFixed(2) : 0,
    maxDelta,
    bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

export interface ProbeOptions<T> {
  /**
   * Apply the change under test. Must return an undo. The undo runs before the C read, and
   * a `restore` diff of anything but zero fails the probe — a swap helper whose restore path
   * was skipped by a `if (!node.parent) continue` guard is a real bug this caught once, and
   * its only symptom was a restore check that equalled the A/B delta.
   */
  change: () => () => void;
  /**
   * Make the frame demonstrably different, and undo it. Defaults to blanking the whole stage,
   * which every real scene must react to. Override it with something narrower when you want
   * to prove a specific SUBTREE is on screen — that is the check that would have caught a
   * probe aimed at a scene hidden behind the main menu.
   */
  control?: () => () => void;
  /** Anything worth carrying out alongside the diffs (sample rects, counts, labels). */
  measure?: (frames: { a: Frame; b: Frame }) => T;
  threshold?: number;
  /**
   * How to grab a frame. Defaults to `readFrame(app)`; overridable so the control flow — the
   * ordering of the five reads and both refusals, which is the whole point of this function —
   * can be exercised without a DOM canvas. Without this seam the test has to restate the
   * ordering itself and would then pass with `probeFrames` deleted.
   */
  read?: () => Frame;
}

/**
 * Run the A/B/C probe with its liveness control, and refuse to be believed if either guard
 * fails. Order matters: the control runs FIRST, because if the reader cannot see the scene
 * there is no point measuring anything else, and a zero A/B diff would otherwise read as
 * "the change did nothing".
 */
export function probeFrames<T = undefined>(app: Application, opts: ProbeOptions<T>): ProbeResult<T> {
  const threshold = opts.threshold ?? 6;
  const control = opts.control ?? (() => defaultControl(app));
  const read = opts.read ?? (() => readFrame(app));

  const base = read();
  const undoControl = control();
  const controlled = read();
  undoControl();
  const liveness = diffFrames(base, controlled, threshold);

  const a = read();
  const undo = opts.change();
  const b = read();
  undo();
  const c = read();

  const diff = diffFrames(a, b, threshold);
  const restore = diffFrames(a, c, threshold);
  const problems: string[] = [];
  if (liveness.changed === 0) {
    problems.push(
      'the liveness control moved zero pixels — the reader is not seeing this scene, so every ' +
        'other number here is meaningless. Check the scene is actually displayed (a menu or ' +
        'overlay drawn on top will do this) before reading the diff.',
    );
  }
  if (restore.changed !== 0) {
    problems.push(
      `the restore read differs from the baseline in ${restore.changed} px — the undo returned ` +
        'by `change` is incomplete, so the A/B diff mixes the change with whatever did not come back.',
    );
  }
  return {
    diff,
    restore,
    liveness,
    trustworthy: problems.length === 0,
    problems,
    value: (opts.measure ? opts.measure({ a, b }) : undefined) as T,
  };
}

/** Blank the whole stage. Crude on purpose: the default control has to be something no live
 *  scene can fail to notice. */
function defaultControl(app: Application): () => void {
  const stage = app.stage as Container;
  const kids = [...stage.children];
  stage.removeChildren();
  return () => {
    for (const k of kids) stage.addChild(k);
  };
}

/** Mean luma over a rect, in FRAME pixels (multiply CSS coordinates by the renderer
 *  resolution first — `readFrame` returns the backing buffer, not the CSS box). */
export function meanLuma(frame: Frame, x: number, y: number, w: number, h: number): number | null {
  let sum = 0;
  let n = 0;
  for (let py = Math.max(0, Math.round(y)); py < Math.min(frame.height, Math.round(y + h)); py++) {
    for (let px = Math.max(0, Math.round(x)); px < Math.min(frame.width, Math.round(x + w)); px++) {
      const i = (py * frame.width + px) * 4;
      sum += 0.299 * frame.data[i]! + 0.587 * frame.data[i + 1]! + 0.114 * frame.data[i + 2]!;
      n++;
    }
  }
  return n ? +(sum / n).toFixed(2) : null;
}

/**
 * Luma percentiles over a rect. A mean hides the thing you are usually looking for: a change
 * that moves 3% of an object's pixels a long way reads as "no change" in the mean, and a
 * REVERSED shading ramp is byte-identical in every count that is not order-aware.
 */
export function lumaPercentiles(
  frame: Frame,
  x: number,
  y: number,
  w: number,
  h: number,
  ps: readonly number[] = [0.05, 0.25, 0.5, 0.75, 0.95],
): Record<string, number> {
  const v: number[] = [];
  for (let py = Math.max(0, Math.round(y)); py < Math.min(frame.height, Math.round(y + h)); py++) {
    for (let px = Math.max(0, Math.round(x)); px < Math.min(frame.width, Math.round(x + w)); px++) {
      const i = (py * frame.width + px) * 4;
      v.push(0.299 * frame.data[i]! + 0.587 * frame.data[i + 1]! + 0.114 * frame.data[i + 2]!);
    }
  }
  v.sort((m, n) => m - n);
  const out: Record<string, number> = {};
  for (const p of ps) {
    out[`p${Math.round(p * 100)}`] = v.length ? +v[Math.min(v.length - 1, Math.floor(v.length * p))]!.toFixed(1) : 0;
  }
  return out;
}

/**
 * Where a node actually lands in FRAME pixels, without doing camera arithmetic by hand.
 * Reparents into a throwaway probe container to read one exact live position — the technique
 * that replaced a round of fighting `getGlobalPosition` and zoom math, and the reason a
 * sample rect should be derived from the renderer rather than from level data (level
 * coordinates move under a camera; extract bounds move per grab).
 */
export function frameRectOf(app: Application, node: Container): { x: number; y: number; w: number; h: number } {
  const res = app.renderer.resolution;
  const p = node.getGlobalPosition();
  const b = node.getBounds();
  return { x: (p.x - b.width / 2) * res, y: (p.y - b.height) * res, w: b.width * res, h: b.height * res };
}
