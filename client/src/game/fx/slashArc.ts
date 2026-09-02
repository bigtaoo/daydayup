// The melee swing's SECTOR, drawn as a sweeping arc of light (2026-09-02, asked for directly: an
// fx that shows the attack's sector). Its own file rather than a third `Graphics` factory on
// `FxController` (413 lines, CLAUDE.md's 500-line convention) because it is the only fx in this
// renderer that is neither a `Graphics` nor a particle — see below for why it cannot be either.
//
// ## What it draws, and why it is the weapon's REAL arc
//
// `HitResolveSystem.meleeArc` hits every hostile inside `arcHalf` of the facing and within
// `range` of the actor's centre, and `DeflectSystem` parries bullets in the identical sector. Both
// numbers are per-weapon and vary a lot across the roster (60°-220°, 1.3-2.1 grid), and until now
// nothing on screen carried either of them: the rig's swing was one hardcoded 68° sweep (see
// `render/rigAttackMotion.ts`, now data-driven off the same spec). This fx is that sector, at its
// true angle and true radius, swept once per swing.
//
// ## Why a Mesh, when every other fx here is a Graphics
//
// The look wants alpha to vary along TWO axes at once: radially (transparent at the body, a bright
// rim at the reach limit, so the sector's edge is a stated boundary) and along the sweep (hot at
// the blade's current angle, fading through the trail behind it). Pixi's `Graphics` can only carry
// a ONE-dimensional ramp — `render/shadeRamp.rampFill` maps a linear gradient through a texture
// matrix, and a matrix cannot express a polar mapping — so a Graphics version would be N adjacent
// constant-alpha sub-wedges, i.e. exactly the banded, draw-call-heavy shape `shadeRamp.ts` exists
// to have deleted. A textured `Mesh` gets both axes from the texture's own UVs for one draw call:
// the geometry is a triangle strip across the arc, `u` runs from the blade's current angle
// backwards through the trail and `v` from the actor's edge out to the reach limit.
//
// ## Why the brush is BAKED rather than generated art
//
// The asset is a parametric alpha field (a radial profile times a tail profile) that has to be
// additive-clean and to hold up at any arc width — the case design/12 and the art-pipeline notes
// call "generate it, don't prompt it": an image model brings a MATERIAL, and there is no material
// here, only a falloff you converge on by editing a number. So it goes through
// `shadeRamp.bakedField` like the shield's scale tile: zero bytes against design/04's package
// budget, POT + mipmapped, and readable back by a test.
import { Mesh, MeshGeometry, Texture } from 'pixi.js';
import { bakedField, writeTexel } from '../../render/shadeRamp';

/** Angular segments across the arc. FIXED, not proportional to the sector: every arc then shares
 *  one geometry LAYOUT, which is what lets retired instances be pooled and reused (a 220° hammer
 *  arc and a 60° spear poke differ only in the numbers written into the buffers). 32 puts the
 *  widest sector in the roster at 6.9° per segment, well inside the point where a straight chord
 *  is visibly not an arc at the ~4x room zoom. */
export const ARC_SEGMENTS = 32;

/** Brush texture size. `u` (width) is the sweep axis, `v` (height) the radial one; POT on both
 *  because WebGL1 (WeChat) silently disables mipmapping on an NPOT texture, and this brush IS
 *  minified — a 1.3-grid arc squeezes 64 radial texels into ~42 world px. */
const BRUSH_W = 256;
const BRUSH_H = 64;

/** Peak alpha in the brush. Additive over `layers.fx` (which also carries the bloom pass), so
 *  full opacity would blow the sector to white and hide the enemies standing in it. */
const BRUSH_PEAK = 0.8;
/** How fast the trail gives out behind the blade. An exponent, not a linear fade: a slash reads
 *  as a bright leading edge with a wake, and a linear tail reads as a filled-in pie slice.
 *
 *  Tuned DOWN from 3.2 after measuring the first live swing (2026-09-02): at 3.2 the wake was
 *  under 1% of peak by the time the blade was 80% of the way round, so a 220° hammer only ever
 *  showed ~90° of itself at once and the fx read as a crescent rather than as a sector. 2.4 keeps
 *  the whole swept arc faintly lit while the blade is still travelling, which is the difference
 *  between "something flashed" and "that is how far this weapon reaches". */
const TAIL_POWER = 2.4;
/** The radial profile's two terms: a wash filling in toward the body, and the rim band that marks
 *  the reach limit. `RIM_AT`/`RIM_WIDTH` are fractions of the radius. */
const CORE_POWER = 2.4;
const CORE_WEIGHT = 0.5;
const RIM_WEIGHT = 0.85;
const RIM_AT = 0.9;
const RIM_WIDTH = 0.11;
/** The outermost fraction of the radius the brush feathers to nothing over, so the boundary is
 *  antialiased rather than a stair-stepped hard cut. Deliberately tiny: the whole point of the rim
 *  is that a player can see where their reach ends. */
const EDGE_FEATHER = 0.03;

/** The alpha field, separably: `tailProfile(u) * radialProfile(v)`. Exported for the test, which
 *  asserts the profile's shape (a monotone tail, a peak near the rim, nothing at the body) rather
 *  than sampling texels back out of a GPU-bound texture. */
export function tailProfile(u: number): number {
  // Clamped, not because the geometry can hand this a u past 1 (it cannot — `writeSweep` keeps
  // every column inside [0, 1]) but because `Math.pow` of a NEGATIVE base and a fractional
  // exponent is NaN, and one NaN texel in the bake is an invisible hole in the brush.
  return Math.pow(Math.max(0, 1 - u), TAIL_POWER);
}

export function radialProfile(v: number): number {
  const core = Math.pow(v, CORE_POWER) * CORE_WEIGHT;
  const rim = Math.exp(-(((v - RIM_AT) / RIM_WIDTH) ** 2)) * RIM_WEIGHT;
  const feather = v > 1 - EDGE_FEATHER ? Math.max(0, (1 - v) / EDGE_FEATHER) : 1;
  return Math.min(1, core + rim) * feather;
}

/** The one brush every arc samples, built on first use and kept for the process. White, so each
 *  swing's own `tint` carries the element colour — the same "one bake, tinted per use" rule
 *  `shadeRamp.alphaRamp` states for the 1-D ramps. */
export function slashBrush(): Texture {
  return bakedField('slash-arc-brush', BRUSH_W, BRUSH_H, (rgba, w, h) => {
    for (let y = 0; y < h; y++) {
      const radial = radialProfile((y + 0.5) / h) * BRUSH_PEAK;
      for (let x = 0; x < w; x++) {
        const alpha = radial * tailProfile((x + 0.5) / w);
        // Premultiplied white: rgb IS the alpha (see shadeRamp's header on why nothing
        // premultiplies a BufferImageSource on its way to the GPU).
        writeTexel(rgba, y * w + x, { r: alpha, g: alpha, b: alpha, a: alpha });
      }
    }
  }, { mipmap: true });
}

/** One swing, in render units. Every angle is a WORLD angle (radians, y-down screen space) and
 *  every length world px — the fp/brad conversion happens at the read site (`EventReactor`). */
export interface SlashArcPose {
  /** The swinging actor's centre, world px. */
  x: number;
  y: number;
  /** Aim angle the sector is centred on. */
  facingRad: number;
  /** Half the weapon's own `arcDeg`, radians — the sector's true half-width. */
  arcHalfRad: number;
  /** Inner radius (the actor's own edge, so the arc does not wash over the character) and outer
   *  radius (`MeleeSimSpec.range`, the reach from the actor's centre the hit test uses). */
  innerPx: number;
  outerPx: number;
  /** Element colour of the weapon that swung. */
  color: number;
  /** Which way the blade travels, from `render/facing.facingFromAngle`. The rig states its swing
   *  in canonical (pre-mirror) space, so a left-facing body sweeps the other way around the
   *  circle; an arc that ignored this would run against the blade half the time. */
  flipX: 1 | -1;
  /** Schedule, all ms from the swing event. `delayMs`/`sweepMs` come straight off
   *  `swingSchedule`'s strike window so the arc and the blade are one motion. */
  delayMs: number;
  sweepMs: number;
  fadeMs: number;
}

function buildIndices(): Uint32Array {
  const out = new Uint32Array(ARC_SEGMENTS * 6);
  for (let i = 0; i < ARC_SEGMENTS; i++) {
    const v = i * 2; // the inner/outer pair at this column; the next column's is v+2 / v+3
    out.set([v, v + 1, v + 3, v, v + 3, v + 2], i * 6);
  }
  return out;
}

/**
 * A single swing's arc. Owns its geometry (positions and UVs are rewritten every frame — the
 * sweep IS the animation, so there is nothing static to cache) and samples the shared brush.
 *
 * The unswept part of the sector is not drawn: every column ahead of the blade collapses onto the
 * blade's own angle, which makes those triangles zero-area. That is what gives the leading edge
 * its hard boundary — a fade there would read as the whole sector lighting up at once.
 */
export class SlashArc extends Mesh {
  private ms = 0;
  private pose: SlashArcPose;
  private startRad = 0;
  private spanRad = 0;

  constructor(pose: SlashArcPose) {
    super({
      geometry: new MeshGeometry({
        positions: new Float32Array((ARC_SEGMENTS + 1) * 4),
        uvs: new Float32Array((ARC_SEGMENTS + 1) * 4),
        indices: buildIndices(),
      }),
      texture: slashBrush(),
    });
    this.blendMode = 'add';
    this.pose = pose;
    this.reset(pose);
  }

  /** Re-aim a pooled arc at a new swing. Everything an arc carries is in `pose` or derived from
   *  it, so this is the whole of "construct" minus the buffers. */
  reset(pose: SlashArcPose): void {
    this.pose = pose;
    this.ms = 0;
    this.startRad = pose.facingRad - pose.flipX * pose.arcHalfRad;
    this.spanRad = pose.flipX * 2 * pose.arcHalfRad;
    this.position.set(pose.x, pose.y);
    this.tint = pose.color;
    this.alpha = 1;
    this.visible = false; // nothing on screen until the wind-up is over
    this.writeSweep(0);
  }

  /** Advance by one render frame (ms). False once the arc has finished fading and the caller
   *  should retire it. */
  advance(dtMs: number): boolean {
    this.ms += dtMs;
    const t = this.ms - this.pose.delayMs;
    if (t <= 0) return true; // still winding up
    const sweep = Math.max(1, this.pose.sweepMs);
    this.visible = true;
    this.alpha = t <= sweep ? 1 : Math.max(0, 1 - (t - sweep) / Math.max(1, this.pose.fadeMs));
    this.writeSweep(Math.min(1, t / sweep));
    return this.alpha > 0;
  }

  /** Lay the strip out for a blade `p` of the way (0..1) through the sector. */
  private writeSweep(p: number): void {
    const { innerPx, outerPx } = this.pose;
    const positions = this.geometry.positions;
    const uvs = this.geometry.uvs;
    for (let i = 0; i <= ARC_SEGMENTS; i++) {
      const a = i / ARC_SEGMENTS;
      const swept = Math.min(a, p); // ahead of the blade: collapsed onto it, zero area
      const ang = this.startRad + this.spanRad * swept;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      // 0 at the blade, growing back through the trail — the brush's own tail axis.
      const u = p - swept;
      const o = i * 4;
      positions[o] = cos * innerPx;
      positions[o + 1] = sin * innerPx;
      positions[o + 2] = cos * outerPx;
      positions[o + 3] = sin * outerPx;
      uvs[o] = u;
      uvs[o + 1] = 0;
      uvs[o + 2] = u;
      uvs[o + 3] = 1;
    }
    // Re-assigning the same array is how a `Buffer` is told its contents changed (its `data`
    // setter emits `update` even for an identical reference — pixi's Buffer.setDataWithSize).
    this.geometry.positions = positions;
    this.geometry.uvs = uvs;
  }

  /** Pixi's `Mesh.destroy` releases neither the geometry nor its GPU buffers, and every arc owns
   *  its own — so this does. Never the texture: the brush is shared by every swing in the run. */
  override destroy(): void {
    const geometry = this.geometry;
    super.destroy();
    geometry.destroy(true);
  }
}

/** How many retired arcs are kept for reuse. Bounded by how many actors can be mid-swing at once
 *  (two players in an arena match, and an arc lives ~230 ms against a ~370 ms recovery), with room
 *  to spare; past that a retired arc is destroyed rather than hoarded. */
const POOL_MAX = 4;
const pool: SlashArc[] = [];

/** Take an arc for `pose` — reusing a retired one if there is one, since each arc otherwise
 *  allocates three GPU buffers that live for ~230 ms. */
export function acquireSlashArc(pose: SlashArcPose): SlashArc {
  const spare = pool.pop();
  if (!spare) return new SlashArc(pose);
  spare.reset(pose);
  return spare;
}

/** Hand a finished arc back. The caller has already removed it from its parent. */
export function releaseSlashArc(arc: SlashArc): void {
  arc.visible = false;
  if (pool.length < POOL_MAX) pool.push(arc);
  else arc.destroy();
}

/** Drop the pool — for tests, which need each case to start from a known allocation state
 *  (`shadeRamp.resetShadeRampCache` exists for the same reason). */
export function resetSlashArcPool(): void {
  for (const arc of pool.splice(0)) arc.destroy();
}

export function slashArcPoolSize(): number {
  return pool.length;
}
