/**
 * The melee sector arc (`slashArc.ts`) — the fx that states, on screen, the sector
 * `HitResolveSystem.meleeArc` and `DeflectSystem` actually use.
 *
 * Everything asserted here is a property of the GEOMETRY or of the alpha field, because that is
 * where every visible property of this fx lives and none of it shows up in a screenshot of one
 * frame: which way the blade travels, that the unswept part of the sector is not drawn, that the
 * outer edge sits at the weapon's real reach, and that the brush is bright at the reach limit and
 * transparent at the body. A real `MeshGeometry` is built (no renderer needed — same
 * "construct real Pixi objects under plain vitest" convention `terrainSwatch.test.ts` uses for
 * the real `bakedField` bake) and its buffers are read back directly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SlashArc, ARC_SEGMENTS, acquireSlashArc, releaseSlashArc, resetSlashArcPool, slashArcPoolSize,
  slashBrush, radialProfile, tailProfile, type SlashArcPose,
} from './slashArc';
import { rampProfile } from '../../render/shadeRamp';

const POSE: SlashArcPose = {
  x: 100,
  y: 200,
  facingRad: 0,
  arcHalfRad: Math.PI / 2, // a 180° sector, so left/right/ahead are all easy to reason about
  innerPx: 10,
  outerPx: 50,
  color: 0x90cdf4,
  flipX: 1,
  delayMs: 60,
  sweepMs: 100,
  fadeMs: 200,
};

/** Every column's (inner, outer) point pair, in the arc's own local space. */
function columns(arc: SlashArc): { ix: number; iy: number; ox: number; oy: number; u: number }[] {
  const p = arc.geometry.positions;
  const uv = arc.geometry.uvs;
  return Array.from({ length: ARC_SEGMENTS + 1 }, (_, i) => ({
    ix: p[i * 4]!, iy: p[i * 4 + 1]!, ox: p[i * 4 + 2]!, oy: p[i * 4 + 3]!, u: uv[i * 4]!,
  }));
}

/** One row of the baked brush, by radial fraction — its alpha across the whole tail axis. */
function brushRow(v: number): number[] {
  const resource = slashBrush().source.resource as Uint8Array;
  const y = Math.min(63, Math.floor(v * 64));
  return Array.from({ length: 256 }, (_, x) => resource[(y * 256 + x) * 4 + 3]! / 255);
}

const radius = (x: number, y: number): number => Math.hypot(x, y);
const angle = (x: number, y: number): number => Math.atan2(y, x);

beforeEach(() => resetSlashArcPool());

describe('SlashArc — the sweep', () => {
  it('draws nothing at all until the wind-up is over', () => {
    // The arc is spawned on the `melee_swing` event but the blade does not cross the aim line
    // until `strikeStartMs` (`rigAttackMotion.swingSchedule`). An arc that appeared immediately
    // would light up the sector while the character was still cocking the weapon.
    const arc = new SlashArc(POSE);
    expect(arc.visible).toBe(false);
    expect(arc.advance(POSE.delayMs - 1)).toBe(true);
    expect(arc.visible).toBe(false);
    arc.advance(2);
    expect(arc.visible).toBe(true);
  });

  it('collapses every column ahead of the blade onto the blade itself — zero area, not faded', () => {
    // This is what gives the leading edge its hard boundary. Asserted as geometry because a
    // degenerate triangle is invisible: nothing in a rendered frame distinguishes "not drawn"
    // from "drawn at alpha 0", and only one of those is what the sweep needs.
    const arc = new SlashArc(POSE);
    arc.advance(POSE.delayMs + POSE.sweepMs * 0.25); // a quarter of the way across
    const cols = columns(arc);
    const head = angle(cols[Math.round(ARC_SEGMENTS * 0.25)]!.ox, cols[Math.round(ARC_SEGMENTS * 0.25)]!.oy);
    // Behind the blade: fanned out across distinct angles.
    expect(angle(cols[0]!.ox, cols[0]!.oy)).toBeLessThan(head - 0.1);
    // Ahead of it: every last column pinned to the blade's own angle.
    for (const c of cols.slice(Math.ceil(ARC_SEGMENTS * 0.25) + 1)) {
      expect(angle(c.ox, c.oy)).toBeCloseTo(head, 6);
    }
  });

  it('sweeps the FULL sector by the end of the strike, and no further', () => {
    const arc = new SlashArc(POSE);
    arc.advance(POSE.delayMs + POSE.sweepMs);
    const cols = columns(arc);
    expect(angle(cols[0]!.ox, cols[0]!.oy)).toBeCloseTo(-POSE.arcHalfRad, 6);
    expect(angle(cols[ARC_SEGMENTS]!.ox, cols[ARC_SEGMENTS]!.oy)).toBeCloseTo(POSE.arcHalfRad, 6);
    // ...and over-advancing into the fade does not push it past its own arc.
    arc.advance(POSE.fadeMs * 0.5);
    const later = columns(arc);
    expect(angle(later[ARC_SEGMENTS]!.ox, later[ARC_SEGMENTS]!.oy)).toBeCloseTo(POSE.arcHalfRad, 6);
  });

  it('travels the other way around the circle for a mirrored body', () => {
    // The rig states its swing in canonical (pre-mirror) space, so `view.scale.x = -1` reverses
    // the blade's direction on screen (`render/facing.canonicalAimRad`). An arc that ignored
    // `flipX` would run against the blade for every left-facing swing — half of all of them.
    const arc = new SlashArc({ ...POSE, flipX: -1 });
    arc.advance(POSE.delayMs + POSE.sweepMs * 0.25);
    const cols = columns(arc);
    // Starts at +arcHalf and moves toward -arcHalf: the tail is now the POSITIVE side.
    expect(angle(cols[0]!.ox, cols[0]!.oy)).toBeCloseTo(POSE.arcHalfRad, 6);
    const head = angle(cols[Math.round(ARC_SEGMENTS * 0.25)]!.ox, cols[Math.round(ARC_SEGMENTS * 0.25)]!.oy);
    expect(head).toBeLessThan(POSE.arcHalfRad);
  });

  it('is centred on the aim, whichever way the actor faces', () => {
    for (const facingRad of [0, 1.2, Math.PI, -2.4]) {
      // A 100° sector, not this file's default 180°: the edges of a half-circle are ANTIPODAL,
      // so averaging their unit vectors is (0,0) and the mid-angle below is undefined. That is
      // a degenerate case of the assertion, not of the fx.
      const arc = new SlashArc({ ...POSE, facingRad, arcHalfRad: (50 * Math.PI) / 180 });
      arc.advance(POSE.delayMs + POSE.sweepMs);
      const cols = columns(arc);
      const first = angle(cols[0]!.ox, cols[0]!.oy);
      const last = angle(cols[ARC_SEGMENTS]!.ox, cols[ARC_SEGMENTS]!.oy);
      // Half-way between the two extremes is the aim — compared as unit vectors so the
      // comparison survives atan2's own wrap at ±π.
      const mid = Math.atan2((Math.sin(first) + Math.sin(last)) / 2, (Math.cos(first) + Math.cos(last)) / 2);
      expect(Math.cos(mid - facingRad)).toBeCloseTo(1, 6);
    }
  });

  it('spans exactly the weapon reach it was given — inner ring at the body, outer at the range', () => {
    // The number this fx exists to communicate. `outerPx` is `MeleeSimSpec.range` in px, the
    // same reach the hit test measures from the actor's centre; `innerPx` is the actor's own
    // radius, so the arc starts at the body's edge instead of washing over the character.
    const arc = new SlashArc(POSE);
    arc.advance(POSE.delayMs + POSE.sweepMs);
    for (const c of columns(arc)) {
      expect(radius(c.ix, c.iy)).toBeCloseTo(POSE.innerPx, 5);
      expect(radius(c.ox, c.oy)).toBeCloseTo(POSE.outerPx, 5);
    }
  });

  it('scales its arc with the weapon, not with a constant — a 60° poke and a 220° sweep differ', () => {
    // The whole point of the pass (2026-09-02): the roster's sectors run 60°-220° and the
    // animation used to draw one fixed 68° regardless.
    const arcOf = (deg: number): number => {
      const arc = new SlashArc({ ...POSE, arcHalfRad: ((deg / 2) * Math.PI) / 180 });
      arc.advance(POSE.delayMs + POSE.sweepMs);
      const cols = columns(arc);
      return angle(cols[ARC_SEGMENTS]!.ox, cols[ARC_SEGMENTS]!.oy) - angle(cols[0]!.ox, cols[0]!.oy);
    };
    expect(arcOf(60)).toBeCloseTo(Math.PI / 3, 5);
    expect(arcOf(140)).toBeCloseTo((140 * Math.PI) / 180, 5);
    expect(arcOf(220) / arcOf(60)).toBeCloseTo(220 / 60, 5);
  });

  it('runs the brush tail from the blade backwards, so the wake fades and the edge does not', () => {
    const arc = new SlashArc(POSE);
    arc.advance(POSE.delayMs + POSE.sweepMs * 0.5);
    const cols = columns(arc);
    const headCol = Math.round(ARC_SEGMENTS * 0.5);
    expect(cols[headCol]!.u).toBeCloseTo(0, 6); // u = 0 IS the bright end of the brush
    expect(cols[0]!.u).toBeCloseTo(0.5, 6); // the oldest drawn column, half-way down the tail
    // Monotone in between, and never outside the texture (which would wrap — `addressMode` is
    // `repeat`, so an out-of-range u would sample the bright head again at the tail's far end).
    for (let i = 1; i <= headCol; i++) expect(cols[i]!.u).toBeLessThan(cols[i - 1]!.u);
    for (const c of cols) {
      expect(c.u).toBeGreaterThanOrEqual(0);
      expect(c.u).toBeLessThanOrEqual(1);
    }
  });

  it('holds full strength through the sweep, then fades out and reports itself finished', () => {
    const arc = new SlashArc(POSE);
    arc.advance(POSE.delayMs + POSE.sweepMs * 0.5);
    expect(arc.alpha).toBe(1);
    expect(arc.advance(POSE.sweepMs * 0.5 + POSE.fadeMs * 0.5)).toBe(true);
    expect(arc.alpha).toBeCloseTo(0.5, 6);
    expect(arc.advance(POSE.fadeMs * 0.5)).toBe(false); // done — the caller retires it
    expect(arc.alpha).toBe(0);
  });

  it('is frame-rate independent — one coarse step lands where many fine ones do', () => {
    const coarse = new SlashArc(POSE);
    coarse.advance(POSE.delayMs + 40);
    const fine = new SlashArc(POSE);
    for (let i = 0; i < 20; i++) fine.advance((POSE.delayMs + 40) / 20);
    expect(columns(fine).map(c => c.u)).toEqual(
      columns(coarse).map(c => expect.closeTo(c.u, 10) as unknown as number),
    );
  });

  it('carries the weapon element as its tint, so one baked brush serves every element', () => {
    expect(new SlashArc({ ...POSE, color: 0xff8844 }).tint).toBe(0xff8844);
  });
});

describe('SlashArc — the pool', () => {
  it('reuses a retired arc instead of allocating another set of GPU buffers', () => {
    const first = acquireSlashArc(POSE);
    releaseSlashArc(first);
    expect(slashArcPoolSize()).toBe(1);
    const second = acquireSlashArc({ ...POSE, facingRad: 2 });
    expect(second).toBe(first);
    expect(slashArcPoolSize()).toBe(0);
  });

  it('a reused arc starts from its new swing, carrying nothing over from the last one', () => {
    // The failure this guards is specific: a pooled arc that kept its old clock would appear
    // already half-swept, or already faded out, on the frame it was handed to a new swing.
    const first = acquireSlashArc(POSE);
    first.advance(POSE.delayMs + POSE.sweepMs + POSE.fadeMs); // fully spent
    expect(first.alpha).toBe(0);
    releaseSlashArc(first);
    const reused = acquireSlashArc({ ...POSE, facingRad: Math.PI, color: 0x112233 });
    expect(reused.alpha).toBe(1);
    expect(reused.visible).toBe(false);
    expect(reused.tint).toBe(0x112233);
    reused.advance(POSE.delayMs + POSE.sweepMs);
    const cols = columns(reused);
    expect(angle(cols[0]!.ox, cols[0]!.oy)).toBeCloseTo(Math.PI - POSE.arcHalfRad, 6);
  });

  it('destroys rather than hoards once the pool is full', () => {
    const arcs = Array.from({ length: 6 }, () => acquireSlashArc(POSE));
    for (const a of arcs) releaseSlashArc(a);
    expect(slashArcPoolSize()).toBe(4); // POOL_MAX
  });
});

describe('the baked brush', () => {
  it('is one shared texture, not one per swing', () => {
    expect(slashBrush()).toBe(slashBrush());
    expect(new SlashArc(POSE).texture).toBe(slashBrush());
  });

  it('is transparent at the body and brightest at the reach limit', () => {
    // Which is the whole reason this fx reads as a RANGE rather than as a glow around the
    // character: the value peak is at the edge the player needs to judge.
    expect(radialProfile(0)).toBeCloseTo(0, 6);
    expect(radialProfile(0.25)).toBeLessThan(radialProfile(0.6));
    const peak = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].reduce(
      (best, v) => (radialProfile(v) > radialProfile(best) ? v : best),
    );
    expect(peak).toBeGreaterThan(0.8);
    // ...and it feathers to nothing at the very edge rather than ending on a hard step.
    expect(radialProfile(1)).toBeCloseTo(0, 6);
  });

  it('gives out monotonically along the tail, reaching nothing by the far end', () => {
    // `addressMode` is `repeat` (shadeRamp's bake), so a tail that did NOT reach zero would
    // show a seam: the geometry's u stays inside [0,1], but a linear filter samples across the
    // wrap at the last texel and would blend the bright head into the tail's end.
    let last = tailProfile(0);
    expect(last).toBe(1);
    for (let u = 0.05; u <= 1.0001; u += 0.05) {
      const here = tailProfile(u);
      expect(here).toBeLessThan(last);
      last = here;
    }
    expect(tailProfile(1)).toBeCloseTo(0, 12);
  });

  it('is PREMULTIPLIED — rgb never exceeds alpha anywhere in the bake', () => {
    // `bakedField` declares `alphaMode: 'premultiplied-alpha'` and nothing on the path to the GPU
    // premultiplies a `BufferImageSource` (shadeRamp's header). The classic bug is writing white
    // rgb under a varying alpha, which the batch shader reads as over-bright: on an ADDITIVE layer
    // that is a solid white wedge instead of a graduated one, and it is invisible in any test that
    // only reads the alpha channel — including the two above.
    const resource = slashBrush().source.resource as Uint8Array;
    let worst = 0;
    for (let i = 0; i < resource.length; i += 4) {
      worst = Math.max(worst, resource[i]! - resource[i + 3]!, resource[i + 1]! - resource[i + 3]!,
        resource[i + 2]! - resource[i + 3]!);
    }
    expect(worst).toBe(0);
  });

  it('bakes that profile into the texture rather than only describing it', () => {
    // The two profiles above are pure functions; this is the assertion that the TEXTURE the mesh
    // actually samples was painted from them — the same "read the bake back" check
    // `terrainSwatch.test.ts` makes, and the only thing that would catch a paint loop that
    // transposed its axes (a transposed brush is a perfectly plausible-looking gradient).
    //
    // `rampProfile` reads row 0, the brush's INNER edge, where the radial term is ~0: the whole
    // row must be transparent whatever the tail does.
    expect(rampProfile(slashBrush())).toHaveLength(256);
    expect(Math.max(...rampProfile(slashBrush()))).toBe(0);

    // The rim row carries the content, and along it the TAIL profile must be what varies.
    const rim = brushRow(0.9);
    expect(rim[0]!).toBeGreaterThan(0.5); // the blade's own edge, near the brush's peak alpha
    expect(rim[255]!).toBeCloseTo(0, 2); // and nothing left at the end of the wake
    for (let i = 1; i < rim.length; i++) expect(rim[i]!).toBeLessThanOrEqual(rim[i - 1]!);
  });
});

/**
 * The four cases a 2026-09-02 mutation battery (39 authored / 39 executed / 35 killed) found
 * nothing here could observe. Each one is a real defect the rest of this file sails past, and each
 * is stated as the PROPERTY it breaks rather than as the mutant it came from.
 */
describe('SlashArc — what the mutation battery walked through', () => {
  const spanning: SlashArcPose = { ...POSE, arcHalfRad: 0.9 };

  it('maps the radial UV outward: v=0 at the body, v=1 at the reach limit', () => {
    // SURVIVOR: swapping the two put the brush's bright rim at the CHARACTER and the transparent
    // end at the reach limit — i.e. it inverted the one thing this fx exists to show — and every
    // case above passed, because they all read `u` (the sweep axis) and none read `v`.
    const arc = new SlashArc(spanning);
    arc.advance(spanning.delayMs + spanning.sweepMs);
    const uv = arc.geometry.uvs;
    for (let i = 0; i <= ARC_SEGMENTS; i++) {
      expect(uv[i * 4 + 1]!).toBe(0); // inner vertex
      expect(uv[i * 4 + 3]!).toBe(1); // outer vertex
    }
  });

  it('tells its buffers they changed, every frame it writes them', () => {
    // SURVIVOR: dropping the `geometry.positions = positions` re-assignment leaves both JS arrays
    // correct and the GPU copy frozen on frame one — the arc would render its first pose forever.
    // It looked untestable (no renderer here), but Pixi's `Buffer` is an EventEmitter and the
    // re-assignment is exactly what makes it emit `update`, so the upload IS observable headless.
    const arc = new SlashArc(spanning);
    let positionUploads = 0, uvUploads = 0;
    arc.geometry.attributes.aPosition!.buffer.on('update', () => { positionUploads++; });
    arc.geometry.attributes.aUV!.buffer.on('update', () => { uvUploads++; });
    arc.advance(spanning.delayMs + spanning.sweepMs * 0.3);
    arc.advance(spanning.sweepMs * 0.3);
    expect(positionUploads).toBe(2);
    expect(uvUploads).toBe(2);
  });

  it('triangulates each quad along the diagonal, leaving no gap at the outer rim', () => {
    // SURVIVOR: `[v, v+1, v+2] + [v, v+2, v+3]` splits the quad along its own INNER EDGE rather
    // than along a diagonal, so the two triangles overlap near the body and leave a wedge-shaped
    // hole along the outer edge — a notched rim, which is the one edge that has to read cleanly.
    // Asserted as coverage of the quad, not as the literal index array, so any correct
    // triangulation passes and the two broken ones do not.
    const arc = new SlashArc(spanning);
    arc.advance(spanning.delayMs + spanning.sweepMs);
    const p = arc.geometry.positions;
    const idx = arc.geometry.indices;
    const vert = (i: number): [number, number] => [p[i * 2]!, p[i * 2 + 1]!];
    const sign = (a: [number, number], b: [number, number], c: [number, number]): number =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const inside = (q: [number, number], t: [number, number][]): boolean => {
      const s = [sign(t[0]!, t[1]!, q), sign(t[1]!, t[2]!, q), sign(t[2]!, t[0]!, q)];
      return s.every(v => v >= -1e-6) || s.every(v => v <= 1e-6);
    };
    const triangles = Array.from({ length: idx.length / 3 }, (_, t) =>
      [vert(idx[t * 3]!), vert(idx[t * 3 + 1]!), vert(idx[t * 3 + 2]!)] as [number, number][]);
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      // Four probes across this column's quad, including one out at 95% of the radius where the
      // broken split leaves its hole.
      for (const [wCol, wRad] of [[0.5, 0.5], [0.5, 0.95], [0.25, 0.9], [0.75, 0.9]] as const) {
        const inner = vert(i * 2), outer = vert(i * 2 + 1);
        const innerNext = vert((i + 1) * 2), outerNext = vert((i + 1) * 2 + 1);
        const a: [number, number] = [inner[0] + (outer[0] - inner[0]) * wRad, inner[1] + (outer[1] - inner[1]) * wRad];
        const b: [number, number] = [innerNext[0] + (outerNext[0] - innerNext[0]) * wRad, innerNext[1] + (outerNext[1] - innerNext[1]) * wRad];
        const probe: [number, number] = [a[0] + (b[0] - a[0]) * wCol, a[1] + (b[1] - a[1]) * wCol];
        expect(triangles.some(t => inside(probe, t)), `column ${i} at ${wCol}/${wRad}`).toBe(true);
      }
    }
  });

  it('gives out FASTER than linearly along the tail, but not so fast the sector stops reading', () => {
    // SURVIVOR: a linear tail satisfies every property asserted above (1 at the blade, 0 at the
    // end, monotone) and turns the fx into a uniformly-filled pie slice — the exact look
    // `TAIL_POWER`'s own comment rules out. The band is the honest one: the upper bound is
    // "brighter at the blade than a linear ramp", the lower bound is what a live measurement
    // showed a 220° hammer needs to still read as a sector rather than as a crescent (the 3.2 ->
    // 2.4 retune moved the measured lit arc from 143° to 159°; at 4.5 it drops back under 140°).
    expect(tailProfile(0.5)).toBeLessThan(0.5);
    expect(tailProfile(0.5)).toBeGreaterThan(0.1);
  });
});
