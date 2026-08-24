// Per-frame WebGL command counters — the batching probe.
//
// This has no counterpart in `funny`: that client reports its perf findings to a log
// backend and its render load is a handful of card sprites, so "how many draw calls" was
// never the question. Here it is THE question. daydayup runs a per-actor filter stack
// (NormalLitFilter on every actor, plus shield/outline/dissolve/heat-haze), and every
// filtered object costs Pixi a render-target switch, a program switch and its own draw
// call — none of which batch with anything around them. A frame-time number alone cannot
// distinguish "too much JS" from "the batcher was broken into 200 pieces"; these counters
// can, and they are the cheapest true measurement of it available in the browser.
//
// Implementation is a straight monkey-patch of the live GL context: each counted entry
// point is replaced once by a wrapper that bumps a counter and forwards. The cost is one
// property lookup and one increment per GL call, which is noise next to the call itself —
// but it is still opt-in (`?perf=1`), never installed in a normal session.

/** GL command counts. Cumulative on the probe, per-frame in a `GlFrameCounts` delta. */
export interface GlCounts {
  /** drawArrays + drawElements + the instanced variants: one batch flush each. */
  draws: number;
  /** useProgram: a shader switch, which always breaks the current batch. */
  programs: number;
  /** bindTexture: a texture switch. Far above `draws` means the atlas is not being shared. */
  textures: number;
  /** bindFramebuffer: render-target switches. Two per filter pass — the filter counter. */
  framebuffers: number;
}

const ZERO: GlCounts = { draws: 0, programs: 0, textures: 0, framebuffers: 0 };

/** Anything with the handful of WebGL entry points this probe wraps. Deliberately not
 *  `WebGL2RenderingContext` so a test can pass a plain object with four functions. */
export type CountableGl = Record<string, unknown>;

const DRAW_METHODS = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'] as const;

/** Wraps a live GL context and counts the commands that break batching.
 *  `install` is idempotent per context: a second probe on the same context reuses the
 *  first one's wrappers instead of stacking a second layer of them. */
export class GlProbe {
  private readonly counts: GlCounts = { ...ZERO };
  private lastFrame: GlCounts = { ...ZERO };
  private frameStart: GlCounts = { ...ZERO };
  private installed = false;
  /** Kept so `uninstall` can put the context back exactly as it was — a probe that
   *  permanently rewrote the renderer's GL context would outlive its own toggle. */
  private readonly originals: [CountableGl, string, (...args: unknown[]) => unknown][] = [];

  /** Cumulative counts since install. */
  get total(): Readonly<GlCounts> {
    return this.counts;
  }

  /** Counts recorded between the last two `endFrame` calls. */
  get perFrame(): Readonly<GlCounts> {
    return this.lastFrame;
  }

  install(gl: CountableGl | null | undefined): boolean {
    if (this.installed || !gl) return false;
    const wrap = (name: string, key: keyof GlCounts): void => {
      const original = gl[name];
      if (typeof original !== 'function') return;
      const fn = original as (...args: unknown[]) => unknown;
      gl[name] = (...args: unknown[]): unknown => {
        this.counts[key] += 1;
        return fn.apply(gl, args);
      };
      this.originals.push([gl, name, fn]);
    };
    for (const m of DRAW_METHODS) wrap(m, 'draws');
    wrap('useProgram', 'programs');
    wrap('bindTexture', 'textures');
    wrap('bindFramebuffer', 'framebuffers');
    this.installed = this.originals.length > 0;
    return this.installed;
  }

  uninstall(): void {
    for (const [gl, name, fn] of this.originals) gl[name] = fn;
    this.originals.length = 0;
    this.installed = false;
  }

  /** Call immediately before the renderer's frame. */
  beginFrame(): void {
    this.frameStart = { ...this.counts };
  }

  /** Call immediately after the renderer's frame; `perFrame` then holds this frame's cost. */
  endFrame(): void {
    this.lastFrame = {
      draws: this.counts.draws - this.frameStart.draws,
      programs: this.counts.programs - this.frameStart.programs,
      textures: this.counts.textures - this.frameStart.textures,
      framebuffers: this.counts.framebuffers - this.frameStart.framebuffers,
    };
  }
}

/** Rough filter-pass count implied by a frame's framebuffer binds. Pixi binds the filter's
 *  own target and then rebinds the previous one, so passes ~= binds / 2 (the frame's own
 *  initial bind rounds away). A number here that tracks the on-screen actor count is the
 *  signature of per-actor filters, which is the single most expensive thing this renderer
 *  does — it is why the overlay prints it next to the draw count. */
export function filterPasses(counts: Readonly<GlCounts>): number {
  return Math.max(0, Math.floor(counts.framebuffers / 2));
}
