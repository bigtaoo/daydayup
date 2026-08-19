// Split out of fx/filters.ts (2026-08-18, 500-line convention): the four PER-ACTOR skin
// filters (design/01 fidelity-roadmap milestone 5) — shield rim-glow, hit outline,
// death dissolve, burn heat-haze. Attached to one `Skin.view` at a time by
// `Actor.applySkinFilters`, never to the whole screen.
import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js';
import { FRAME_UV, hexToRgb } from './shaderPrelude';

/** Vertical foreshortening of the shield ring — see `uSquash` in `shieldFrag` below.
 *  Deliberately the same 0.62 the ground-shadow ellipse and the status auras use
 *  (`Entity.makeShadow`, `Actor.setStatus`), so every round thing wrapping a body in
 *  this view agrees on how much the camera tilt compresses it. */
export const SHIELD_SQUASH = 0.62;

const shieldFrag = FRAME_UV + /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uSquash;

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    // Region-normalized, NOT raw \`vTextureCoord\` — this ring's centre is the whole point
    // of the filter and the raw coord's midpoint is the pool texture's, not the actor's.
    // See FRAME_UV above for the full story (this is the bug that produced the long-
    // running "shield renders as a partial crescent" report).
    vec2 uv = frameUv(vTextureCoord) - vec2(0.5);
    // Squashed vertically (2026-08-18 depth pass, user report: the ring read as "a sticker
    // glued on"): a shield WRAPS a body, and this is a tilted view (design/01), so its
    // silhouette is an ellipse, not the perfect screen-space circle a raw UV distance
    // gives. Dividing the vertical component by uSquash (<1) shortens the ring's vertical
    // reach by exactly that factor while leaving its horizontal reach alone — the same
    // foreshortening \`RigSkin\`'s EYE_TRACK_SQUASH and \`Entity\`'s shadow ellipse already use.
    uv.y /= uSquash;
    float dist = length(uv) * 1.4142135;
    // A band hugging the silhouette's own bounding circle, not the true alpha edge —
    // same UV-distance trick as VignetteFilter above, so it needs no extra per-skin
    // wiring to read correctly against both the Graphics placeholder body and a real
    // .tao rig sprite.
    // Band radius (2026-08-19 volume pass). \`uv\` spans ±0.5 across a filterArea 6 body radii
    // wide, so \`dist\` 0.5 sits 2.1 BODY RADII from the actor's centre — the ring was more than
    // twice the size of the character it wrapped, and blanketed the floor all round its feet
    // with opaque cyan. Measured consequence: a shielded actor lost its ground shadow entirely,
    // and with it every grounding cue the volume pass added. Pulled in to peak at 0.283, i.e.
    // 1.2 body radii, which hugs the silhouette the way a shield should.
    float rim = smoothstep(0.17, 0.283, dist) * (1.0 - smoothstep(0.283, 0.40, dist));
    // Shimmer: a slow breathing pulse, not a flicker (user report, 2026-08-17: "护盾的
    // 闪烁频率降低"). Was \`0.6 + 0.4 * sin(uTime * 0.006 + dist * 18.0)\` — 0.006 rad/ms
    // is ~0.95 Hz, and with the ring's own 18-cycle radial banding scrolling through it
    // the combined effect read as a strobe on the character's silhouette rather than as
    // energy. Two changes: the temporal rate drops to ~0.29 Hz (one pulse per ~3.4s),
    // and the swing narrows from ±0.4 to ±0.25 around a brighter base, so the shield
    // stays continuously readable instead of dimming to 0.6x every cycle. The radial
    // term is halved too — it is what turns a slow pulse back into visible ripple
    // banding as the wave crosses the rim.
    float shimmer = 0.75 + 0.25 * sin(uTime * 0.0018 + dist * 9.0);
    float glow = rim * shimmer * uIntensity;
    color.rgb += uColor * glow;
    // 0.85 -> 0.7: what this line does is paint the glow onto TRANSPARENT background outside
    // the body, so it is also the knob that decides how much floor the shield hides.
    color.a = max(color.a, glow * 0.7);
    finalColor = color;
}
`;

/** A shimmering rim-glow around a character's silhouette — the "energy shield" custom
 * shader (design/01 fidelity roadmap milestone 5). `intensity` is driven by the live
 * shield ratio (Actor.setShield): full glow at a full shield pool, fading as it drains,
 * gone once it hits 0 — the `shield_break` event's own flash (EventReactor) covers that
 * instant, this filter just isn't there to fade awkwardly underneath it. */
export class EnergyShieldFilter extends Filter {
  private clock = 0;

  constructor(color = 0x66e0ff, intensity = 0) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: shieldFrag, name: 'energy-shield-filter' });
    super({
      glProgram,
      // The rim ring is positioned relative to the filtered REGION's centre, so the
      // region has to stay the full `Actor.filterArea` square. Pixi otherwise intersects
      // it with the viewport (`FilterSystem._calculateFilterBounds`), which would crop
      // the square — and therefore move its centre — for any shielded actor standing
      // near a screen edge, reintroducing the lopsided ring in exactly that spot. Safe
      // to disable here because `filterArea` already bounds this filter to a small fixed
      // square (3× body radius); it is NOT safe for the two screen-wide post-fx above,
      // which rely on the clip to size themselves to the viewport.
      clipToViewport: false,
      resources: {
        shieldUniforms: new UniformGroup({
          uColor: { value: hexToRgb(color), type: 'vec3<f32>' },
          uIntensity: { value: intensity, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uSquash: { value: SHIELD_SQUASH, type: 'f32' },
        }),
      },
    });
  }

  get intensity(): number { return this.resources.shieldUniforms.uniforms.uIntensity; }
  set intensity(v: number) { this.resources.shieldUniforms.uniforms.uIntensity = v; }

  set color(hex: number) { this.resources.shieldUniforms.uniforms.uColor = hexToRgb(hex); }

  /** The ring's vertical foreshortening (`SHIELD_SQUASH`). Read-only in practice — exposed
   *  so a test can assert the ring is an ellipse rather than the old screen-space circle. */
  get squash(): number { return this.resources.shieldUniforms.uniforms.uSquash; }

  /** Advance the shimmer clock — call once per rendered frame while attached. */
  tick(frameDt: number): void {
    this.clock += frameDt;
    this.resources.shieldUniforms.uniforms.uTime = this.clock;
  }
}

const outlineFrag = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize; // Pixi's default vertex precision for this uniform is
// highp; the fragment stage must match exactly or GL refuses to link the program.
uniform vec3 uColor;
uniform float uThickness;
uniform float uAlpha;

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 px = uInputSize.zw * uThickness;
    float n = 0.0;
    n = max(n, texture(uTexture, vTextureCoord + vec2(px.x, 0.0)).a);
    n = max(n, texture(uTexture, vTextureCoord - vec2(px.x, 0.0)).a);
    n = max(n, texture(uTexture, vTextureCoord + vec2(0.0, px.y)).a);
    n = max(n, texture(uTexture, vTextureCoord - vec2(0.0, px.y)).a);
    float edge = clamp(n - color.a, 0.0, 1.0) * uAlpha;
    color.rgb = mix(color.rgb, uColor, edge);
    color.a = max(color.a, edge);
    finalColor = color;
}
`;

/** A real alpha-edge-detected silhouette outline — unlike `EnergyShieldFilter`'s
 * UV-distance approximation above, this samples the actual rendered alpha at 4
 * neighbouring texels (`uInputSize` is a filter uniform Pixi binds automatically for
 * every `Filter`, no extra wiring needed — `.zw` is `(1/width, 1/height)`), so it hugs
 * whatever shape is actually drawn: the Graphics placeholder, a real `.tao` rig, a
 * boss's larger silhouette. `padding` is set so the edge at the very boundary of the
 * sprite's own tight bounds has real transparent neighbour texels to sample against
 * (without it, Pixi clamps to the edge texel and the outermost ring never detects an
 * edge at all). Used as a brief "you were just hit" flash (`Actor.hitFlash`) — `alpha`
 * is set to 1 on hit and decays to 0 over a couple hundred ms (`Actor.interpolate`),
 * the same transient-not-permanent convention as `ChromaticAberrationFilter.amount`. */
export class OutlineFilter extends Filter {
  constructor(color = 0xffffff, thickness = 1.5, alpha = 0) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: outlineFrag, name: 'outline-filter' });
    super({
      glProgram,
      padding: thickness + 2,
      resources: {
        outlineUniforms: new UniformGroup({
          uColor: { value: hexToRgb(color), type: 'vec3<f32>' },
          uThickness: { value: thickness, type: 'f32' },
          uAlpha: { value: alpha, type: 'f32' },
        }),
      },
    });
  }

  get alpha(): number { return this.resources.outlineUniforms.uniforms.uAlpha; }
  set alpha(v: number) { this.resources.outlineUniforms.uniforms.uAlpha = v; }
}

const dissolveFrag = FRAME_UV + /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec3 uColor;
uniform float uProgress;

float hash(vec2 p)
{
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    // 36 cells across the SILHOUETTE — off the raw coord the cell count would instead
    // scale with the pooled texture, so the burn grain visibly changed size with the
    // camera zoom (FRAME_UV above).
    float n = hash(floor(frameUv(vTextureCoord) * 36.0));
    if (n < uProgress) discard;
    float edge = smoothstep(0.0, 0.14, n - uProgress);
    color.rgb += uColor * (1.0 - edge);
    finalColor = color;
}
`;

/** Dissolve-on-death (design/01 fidelity roadmap milestone 5). Procedural cell noise
 * (a GLSL hash of the UV, no noise texture — same "no textures" discipline as
 * `Particles.ts`) burns away in patches as `progress` goes
 * 0→1, with a bright ember-coloured edge trailing the dissolving boundary. Driven by
 * `Actor.startDissolve`/`Scene`'s dying-view list, which keeps a dead actor's view
 * alive (instead of destroying it the instant its id drops out of the engine state) for
 * exactly as long as this animation needs. */
export class DissolveFilter extends Filter {
  constructor(color = 0xffb347, progress = 0) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: dissolveFrag, name: 'dissolve-filter' });
    super({
      glProgram,
      resources: {
        dissolveUniforms: new UniformGroup({
          uColor: { value: hexToRgb(color), type: 'vec3<f32>' },
          uProgress: { value: progress, type: 'f32' },
        }),
      },
    });
  }

  get progress(): number { return this.resources.dissolveUniforms.uniforms.uProgress; }
  set progress(v: number) { this.resources.dissolveUniforms.uniforms.uProgress = v; }
}

const heatHazeFrag = FRAME_UV + /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uIntensity;
uniform float uTime;

void main(void)
{
    // Both the wobble's vertical frequency and its horizontal amplitude are meant to be
    // fractions of the SILHOUETTE, so both are computed in region space (FRAME_UV above)
    // and the resulting displacement converted back before sampling.
    float wobble = sin(frameUv(vTextureCoord).y * 40.0 + uTime * 0.012) * 0.012 * uIntensity;
    vec2 uv = clampToFrame(vTextureCoord + frameOffset(vec2(wobble, 0.0)));
    finalColor = texture(uTexture, uv);
}
`;

/** Heat-haze distortion — the last of the four fidelity-roadmap custom shaders
 * (design/01 milestone 5). A cheap UV-wobble (sampling the source texture through a
 * sine-displaced coordinate, no noise texture) rather than a real refraction pass —
 * same "own the code, own the cost" simplification as `VignetteFilter`'s UV-distance
 * vignette. Driven by the actor's own burning status (`Actor.setStatus`, the same
 * `burnTicks > 0` condition that already drives the burn ring in `AURAS`) — a burning
 * actor's silhouette itself shimmers, on top of the existing ring. */
export class HeatHazeFilter extends Filter {
  private clock = 0;

  constructor(intensity = 1) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: heatHazeFrag, name: 'heat-haze-filter' });
    super({
      glProgram,
      resources: {
        heatHazeUniforms: new UniformGroup({
          uIntensity: { value: intensity, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
        }),
      },
    });
  }

  get intensity(): number { return this.resources.heatHazeUniforms.uniforms.uIntensity; }
  set intensity(v: number) { this.resources.heatHazeUniforms.uniforms.uIntensity = v; }

  /** Advance the wobble clock — call once per rendered frame while attached. */
  tick(frameDt: number): void {
    this.clock += frameDt;
    this.resources.heatHazeUniforms.uniforms.uTime = this.clock;
  }
}
