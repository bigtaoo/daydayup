// Split out of fx/filters.ts (2026-08-18, 500-line convention): the GLSL prelude and the
// colour helper every filter module in this directory shares. No Filter subclass lives
// here — siblings import from this file, never the other way round.
//
// Post-processing filters (design/01 fidelity roadmap milestone 3: bloom, chromatic
// aberration, vignette). Custom Pixi v8 `Filter`s, not a third-party filter package —
// matches this project's "own the code" preference (design/00) and needs no extra
// bundle weight for WeChat (design/04's package-size constraint). Only a WebGL
// `glProgram` is supplied (no `gpuProgram`/WGSL): both platforms force
// `preference:'webgl'` (WebPlatform.ts/WeChatPlatform.ts — WeChat has no WebGPU, design/04),
// and Pixi's own contract for a filter with no gpuProgram is a clean no-op under
// WebGPU, never a crash — so this is safe even if that constraint ever relaxes.
// `main.wechat.ts`'s existing `pixi.js/unsafe-eval` import already covers ALL Pixi
// uniform/shader upload (design/04) — nothing filter-specific is needed for WeChat.

// Shared GLSL prelude for every filter below that needs a position WITHIN the filtered
// region (a centre, a cell grid, a UV displacement) rather than just "sample where I am".
//
// The trap it exists to close (root-caused 2026-08-15 from a long-running "shield ring
// renders as a partial/lopsided crescent" report): Pixi v8's default filter vertex shader
// emits `vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw)`, so it spans
// 0..(region size / ALLOCATED TEXTURE size) — NOT 0..1. Those two differ almost always,
// because filter inputs come from `TexturePool.getOptimalTexture`, which rounds each
// dimension up to the next power of two: a 130px-wide region is handed a 256px-wide
// texture, and `vTextureCoord` then only ever reaches 0.508. Any shader that treats 0.5
// as "the middle" is therefore centred on the POOL TEXTURE's middle, which sits at
// `0.5 * source/frame` in region terms — off the region's own edge entirely once the
// region's pixel size lands just past a power of two.
//
// That is what produced the crescent: the region's pixel size is `filterArea × zoom ×
// renderer resolution`, so crossing a pow2 boundary flips the glow from centred to gone
// with no code change — which is exactly why it looked like "integer camera zoom is fine,
// 1.5/1.32 is broken" and got misdiagnosed (commit d5c06db, reverted) as Pixi corrupting
// filters under a non-integer ancestor scale. It is neither zoom- nor Pixi-specific: it
// is this file's own UV math, and it always applied.
//
// `OutlineFilter`/`NormalLitFilter` below deliberately do NOT use this — they only ever
// step by one texel (`uInputSize.zw` IS the correct texel size, since it is the allocated
// texture's), never by a position, so they were never affected.
export const FRAME_UV = /* glsl */ `
uniform highp vec4 uInputSize;   // xy = allocated filter texture size, zw = 1/xy
uniform highp vec4 uOutputFrame; // zw = the filtered region's own size
uniform highp vec4 uInputClamp;  // xy / zw = min / max texcoord still inside the region

/** \`vTextureCoord\` remapped to a true 0..1 across the filtered REGION. */
vec2 frameUv(vec2 coord)
{
    return coord * uInputSize.xy * (1.0 / uOutputFrame.zw);
}

/** A region-space (0..1) offset expressed back in texcoord space — the inverse of the
 *  above, for shaders that displace their sample point rather than just read one. */
vec2 frameOffset(vec2 delta)
{
    return delta * uOutputFrame.zw * uInputSize.zw;
}

/** Keep a displaced sample inside the region: the pooled texture's area beyond it holds
 *  whatever the LAST filter to borrow that pool entry left there, not transparent black. */
vec2 clampToFrame(vec2 coord)
{
    return clamp(coord, uInputClamp.xy, uInputClamp.zw);
}
`;

/** Hex colour -> the 0..1 vec3 a shader uniform wants. */
export function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}
