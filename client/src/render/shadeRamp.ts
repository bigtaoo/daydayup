// Smooth shading gradients as a sampled TEXTURE instead of a stack of hand-stepped rects
// (2026-08-24, third draw-call pass). One primitive — a procedural texture built from a
// buffer and cached by key — plus the `Graphics` fill style that lays a 1-D ramp of one
// across a shape.
//
// **Why this exists at all.** Every graduated cue in this renderer was drawn as N adjacent
// constant-alpha rects, N chosen per surface so the alpha STEP is below what the eye can
// find (`wallTone.CAP_GRADIENT_BANDS` = 14, `FACE_COPING_BANDS` = 18, `rigShading`'s
// `SHADE_BANDS` = 40, and so on). That is correct and it is expensive twice over. Pixi v8
// auto-batches a `Graphics` only under 400 floats of geometry
// (`GraphicsContextSystem.updateGpuContext`, see `staticGraphics.ts` for the full rule), and
// eight ramps of 12-20 rects each puts a wall block's shading at 520-2010 floats — so every
// one of the level-1 start room's 31 wall/door blocks paid a draw call plus a program switch
// each way. Measured there, 8 live enemies at 1920x855: 33 unbatched shading Graphics,
// 26,896 floats, 50 of the frame's 107 draw calls.
//
// A ramp is a ONE-DIMENSIONAL function. Sampling it from a 256-texel texture makes the
// geometry one quad — 8 floats instead of 150 — and makes the result *smoother* than the
// banding it replaces, because the GPU's own linear filtering interpolates between texels
// instead of stepping between bands. The band counts existed to hide a discretisation that
// is now gone.
//
// **Why not `FillGradient`, which is Pixi's own tool for exactly this.** It calls
// `DOMAdapter.createCanvas()` inside `buildGradient()`, i.e. at `fill()` time, which throws
// `ReferenceError: document is not defined` in this repo's canvas-free test environment —
// and reading a `Graphics`' retained instruction list is how the wall and rig shading are
// machine-checked here (`wallRender.test.ts`, `rigShading.test.ts`). `rigShading.ts` has
// carried a note ruling it out on those grounds since 2026-08-19. A `BufferImageSource`
// needs no canvas, so the same look becomes testable rather than untestable: a test can
// read the ramp's texels back and assert the profile directly, which is a stronger check
// than counting rects ever was.
//
// **Premultiplied, by hand.** Pixi's buffer uploader is a bare `texImage2D` of the
// `Uint8Array` (`glUploadBufferImageResource`); WebGL's `UNPACK_PREMULTIPLY_ALPHA_WEBGL`
// only applies to DOM sources, so nothing premultiplies a buffer on the way to the GPU
// while the batch shader assumes premultiplied texels. Hence `alphaMode:
// 'premultiplied-alpha'` and the multiply in `writeTexel`.
import { BufferImageSource, Matrix, Texture } from 'pixi.js';

/**
 * Texels across a 1-D ramp.
 *
 * The number that matters is the alpha step between adjacent texels at the ramp's steepest
 * point, and 256 puts that below 1/255 for every profile in this project — i.e. below what
 * an 8-bit framebuffer can even represent, let alone show. That is the same reasoning the
 * band counts used (`FACE_COPING_BANDS`' doc states it outright), applied once here instead
 * of re-derived per surface, and it lands two orders of magnitude on the safe side because a
 * texel costs 4 bytes where a band cost a draw-call-sized piece of geometry.
 */
export const RAMP_TEXELS = 256;

/** A premultiplied RGBA sample, channels 0..1. `rgb` is ALREADY multiplied by `a`. */
export interface Premul {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Straight (non-premultiplied) colour + alpha, as every `wallTone`/`rigShading` constant is
 *  written, converted to the premultiplied form the GPU wants. */
export function premul(color: number, alpha: number): Premul {
  return {
    r: (((color >> 16) & 0xff) / 255) * alpha,
    g: (((color >> 8) & 0xff) / 255) * alpha,
    b: ((color & 0xff) / 255) * alpha,
    a: alpha,
  };
}

/** Fully transparent — the identity for `over`. */
export const CLEAR: Premul = { r: 0, g: 0, b: 0, a: 0 };

/**
 * `src` composited OVER `dst`, both premultiplied — the same source-over the GPU would apply
 * if the two were drawn as separate fills, one after the other.
 *
 * This is what lets a stack of overlapping washes collapse into ONE texture without changing
 * the result: premultiplied source-over is associative, so compositing them into a texel and
 * then blending that texel against the scene equals blending each in turn. (It is only
 * associative in the premultiplied form, which is the other half of why this module works in
 * premultiplied space throughout.)
 */
export function over(dst: Premul, src: Premul): Premul {
  const k = 1 - src.a;
  return {
    r: src.r + dst.r * k,
    g: src.g + dst.g * k,
    b: src.b + dst.b * k,
    a: src.a + dst.a * k,
  };
}

/** Write one premultiplied sample into an RGBA byte buffer at texel `i`. */
export function writeTexel(rgba: Uint8Array, i: number, s: Premul): void {
  const o = i * 4;
  rgba[o] = Math.round(Math.max(0, Math.min(1, s.r)) * 255);
  rgba[o + 1] = Math.round(Math.max(0, Math.min(1, s.g)) * 255);
  rgba[o + 2] = Math.round(Math.max(0, Math.min(1, s.b)) * 255);
  rgba[o + 3] = Math.round(Math.max(0, Math.min(1, s.a)) * 255);
}

/** Keyed by the caller's own key: one bake per distinct profile, however many objects sample
 *  it. Every texture here is tiny (a 1-D ramp is 1 KB) and lives for the process. */
const baked = new Map<string, Texture>();

/**
 * A procedurally painted texture, built once per `key`.
 *
 * `paint` receives a zeroed premultiplied-RGBA buffer of `w * h * 4` bytes and fills it. The
 * caller owns the key's uniqueness: it must encode every input that changes the pixels, or
 * two different fields will share one bake.
 */
export function bakedField(
  key: string,
  w: number,
  h: number,
  paint: (rgba: Uint8Array, w: number, h: number) => void,
  opts: { mipmap?: boolean } = {},
): Texture {
  const hit = baked.get(key);
  if (hit) return hit;
  const rgba = new Uint8Array(w * h * 4);
  paint(rgba, w, h);
  const tex = new Texture({
    source: new BufferImageSource({
      resource: rgba,
      width: w,
      height: h,
      alphaMode: 'premultiplied-alpha',
      // Off by default: a 1-D ramp is sampled along its length at roughly 1:1 and gains
      // nothing from mip levels. A 2-D tile that a shader MINIFIES does — the shield
      // membrane compresses ~5x at the limb (`filters/shieldScales.ts`), and without mips
      // that is a shimmering moire ring rather than a surface. POT sizes only: WebGL1
      // (WeChat) silently disables mipmapping on an NPOT texture.
      autoGenerateMipmaps: opts.mipmap ?? false,
      // Linear is the whole point — it is what turns 256 samples into a continuous ramp.
      scaleMode: 'linear',
      // `generateTextureMatrix` force-sets `repeat` on any non-gradient texture fill anyway
      // (it rewrites `clamp-to-edge` on the source in place), so declaring it here just makes
      // the mode the ramp geometry is designed against explicit rather than a surprise. See
      // `rampFill` for why wrapping can never be reached.
      addressMode: 'repeat',
    }),
  });
  tex.label = `shade-ramp:${key}`;
  baked.set(key, tex);
  return tex;
}

/**
 * A 1-D white ramp whose ALPHA runs linearly from `from` to `to` — the shape almost every
 * graduated cue in this project has, since they are all one colour at a varying strength.
 *
 * White, so the fill's own `color`/`alpha` carry the tone: `rampFill(alphaRamp(0, 1), …,
 * { color: 0x000000, alpha: CAP_GRADIENT_MAX })` is a black ramp reaching
 * `CAP_GRADIENT_MAX`, and one cached texture serves every such cue. A profile that ISN'T
 * linear in alpha (the rig's sphere ramp) builds its own field instead.
 */
export function alphaRamp(from: number, to: number): Texture {
  return bakedField(`alpha:${from}:${to}`, RAMP_TEXELS, 1, (rgba, w) => {
    for (let i = 0; i < w; i++) {
      const t = w === 1 ? 0 : i / (w - 1);
      writeTexel(rgba, i, premul(0xffffff, from + (to - from) * t));
    }
  });
}

/** The plain rising 0 -> 1 ramp, which with `rampFill`'s free choice of direction also covers
 *  every falling one — the two differ only in which end of the span `t = 0` sits at. */
export function linearRamp(): Texture {
  return alphaRamp(0, 1);
}

/** Tone applied to a sampled ramp: the fill's flat multiply over the texture's alpha. */
export interface RampTone {
  color: number;
  /** Peak alpha, i.e. the alpha the ramp reaches where its texture reads 1. */
  alpha: number;
}

/**
 * Fill style that lays `texture`'s 1-D ramp across the shape being filled, with `t = 0` at
 * `(x0, y0)` and `t = 1` at `(x1, y1)` **in the Graphics' own local space**.
 *
 * Anchoring the ramp to an explicit segment rather than to the shape's bounds is deliberate,
 * and it is not the shorter option (`textureSpace: 'local'` would map bounds -> 0..1 for
 * free). Half of this project's ramps are drawn on a rect that has been CLAMPED to the
 * block's own width — `wallShadingJoins.drawCornerAO`'s creases run outward from a join and
 * stop at the block edge, `clampSpan` returning a shorter rect. Bound to the shape, a clamp
 * would COMPRESS the whole ramp into the narrower rect; bound to a segment, it truncates it,
 * which is what the stepped version did (the out-of-range bands were simply dropped) and
 * what the cue means.
 *
 * Wrapping is unreachable by construction: `t` is mapped onto texel CENTRES (0.5 ..
 * `width - 0.5`), so the ends sample their end texel exactly, and every caller draws a shape
 * that is a subset of its own ramp segment. Across the ramp's perpendicular the texture is
 * one texel tall, where `repeat` is the identity.
 */
export function rampFill(
  texture: Texture,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tone: RampTone,
): {
  texture: Texture;
  matrix: Matrix;
  textureSpace: 'global';
  color: number;
  alpha: number;
} {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const span = Math.hypot(dx, dy);
  // A DEGENERATE segment has to stay invertible. Pixi inverts `style.matrix` at geometry-build
  // time, and a zero direction makes the linear part singular — `.invert()` then fills the matrix
  // with non-finite values and every fill in that Graphics is lost, not just this one. It is
  // reachable: a cue's ramp is derived from the block's own geometry, so a surface that collapses
  // (a zero-height fallback block, a reach clamped to nothing) hands this a point rather than a
  // segment. Falling back to a unit +x direction makes such a ramp a flat fill at `t = 0`, which
  // is what a gradient with no extent means.
  const len = span > 1e-9 ? span : 1;
  const ux = span > 1e-9 ? dx / len : 1;
  const uy = span > 1e-9 ? dy / len : 0;
  // Texels per local unit along the ramp. `width - 1` (not `width`) because the two ends land
  // ON the first and last texel's centre, half a texel inside the texture either side.
  const k = (texture.width - 1) / len;
  // Local -> texel space. Row 1 is the ramp axis; row 2 is the perpendicular, present only so
  // the matrix is invertible (Pixi inverts `style.matrix`, so a rank-1 map is not expressible)
  // — its output lands on a one-texel-tall texture and is therefore ignored.
  const toTexel = new Matrix(
    k * ux,
    -uy,
    k * uy,
    ux,
    0.5 - k * (ux * x0 + uy * y0),
    0.5 - (-uy * x0 + ux * y0),
  );
  return {
    texture,
    matrix: toTexel.invert(),
    textureSpace: 'global',
    color: tone.color,
    alpha: tone.alpha,
  };
}

/** What a ramp fill is, read back out of the fill style it was turned into. */
export interface RampRead {
  /** Local-space point where the ramp reads its first texel. */
  x0: number;
  y0: number;
  /** ...and its last. */
  x1: number;
  y1: number;
  color: number;
  alpha: number;
  texture: Texture;
}

/**
 * Invert `rampFill` — recover the ramp's own segment from a `Graphics` fill style.
 *
 * Exported for tests, and the reason this module is testable at all. A stepped ramp could be
 * checked by reading the rects back off `context.instructions` and comparing their alphas
 * (which is what `wallRender.test.ts` and `rigShading.test.ts` did, and why `FillGradient`
 * was ruled out); a sampled ramp is one rect with a matrix, so without this the same
 * assertions would have nothing to read. With it they get MORE: where the ramp starts and
 * ends is now exact rather than inferred from band centres.
 *
 * The inversion is trivial because `rampFill` stores the local <- texel map directly: the
 * ramp's ends are the texel-space points `(0.5, 0.5)` and `(width - 0.5, 0.5)` put through
 * it. Returns null for a style that is not a ramp fill.
 */
export function readRampFill(style: unknown): RampRead | null {
  const s = style as {
    texture?: Texture;
    matrix?: Matrix;
    textureSpace?: string;
    color?: number;
    alpha?: number;
  };
  if (!s || !s.texture || !s.matrix || s.textureSpace !== 'global') return null;
  const n = s.texture.width;
  const p0 = s.matrix.apply({ x: 0.5, y: 0.5 });
  const p1 = s.matrix.apply({ x: n - 0.5, y: 0.5 });
  return {
    x0: p0.x,
    y0: p0.y,
    x1: p1.x,
    y1: p1.y,
    color: s.color ?? 0xffffff,
    alpha: s.alpha ?? 1,
    texture: s.texture,
  };
}

/**
 * A ramp texture's own alpha profile, 0..1 per texel — the other half of what `readRampFill`
 * recovers, and what lets a test assert the SHAPE of a gradient (monotone, where the
 * terminator sits, how big the largest step between texels is) instead of trusting the
 * function that built it.
 */
export function rampProfile(texture: Texture): number[] {
  const res = texture.source.resource as Uint8Array | undefined;
  if (!res) return [];
  const out: number[] = [];
  for (let i = 0; i < texture.width; i++) out.push(res[i * 4 + 3]! / 255);
  return out;
}

/** Drop every cached bake. Tests only — a texture cache that survives between cases hides
 *  key collisions, which are exactly the bug this cache can have. */
export function resetShadeRampCache(): void {
  baked.clear();
}

/** How many textures the cache is holding, for a test that wants to prove sharing rather than
 *  assume it: the whole draw-call argument depends on every wall block sampling the SAME
 *  texture, and nothing else would notice if a key started varying per block. */
export function shadeRampCacheSize(): number {
  return baked.size;
}
