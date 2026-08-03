import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js';

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

const vignetteFrag = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uIntensity;
uniform float uRadius;

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 uv = vTextureCoord - vec2(0.5);
    float dist = length(uv) * 1.4142135;
    float vig = smoothstep(uRadius, 1.0, dist);
    color.rgb *= (1.0 - vig * uIntensity);
    finalColor = color;
}
`;

/** Darkens the screen edges — a first-pass approximation (`vTextureCoord` is the
 * filtered region's own UV space, not a guaranteed whole-viewport 0..1, so this reads
 * correctly only while `world` roughly fills the viewport, same simplification the
 * chromatic-aberration filter below makes). */
export class VignetteFilter extends Filter {
  constructor(intensity = 0.35, radius = 0.55) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: vignetteFrag, name: 'vignette-filter' });
    super({
      glProgram,
      resources: {
        vignetteUniforms: new UniformGroup({
          uIntensity: { value: intensity, type: 'f32' },
          uRadius: { value: radius, type: 'f32' },
        }),
      },
    });
  }

  get intensity(): number { return this.resources.vignetteUniforms.uniforms.uIntensity; }
  set intensity(v: number) { this.resources.vignetteUniforms.uniforms.uIntensity = v; }
  get radius(): number { return this.resources.vignetteUniforms.uniforms.uRadius; }
  set radius(v: number) { this.resources.vignetteUniforms.uniforms.uRadius = v; }
}

const chromaticFrag = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uAmount;

void main(void)
{
    vec2 dir = vTextureCoord - vec2(0.5);
    float r = texture(uTexture, vTextureCoord - dir * uAmount).r;
    float g = texture(uTexture, vTextureCoord).g;
    float b = texture(uTexture, vTextureCoord + dir * uAmount).b;
    float a = texture(uTexture, vTextureCoord).a;
    finalColor = vec4(r, g, b, a);
}
`;

/** Splits R/G/B sampling outward from screen centre — a hit-reaction "juice" cue, not
 * a permanent look (Game.ts only raises `amount` briefly then decays it to 0). */
export class ChromaticAberrationFilter extends Filter {
  constructor(amount = 0) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: chromaticFrag, name: 'chromatic-aberration-filter' });
    super({
      glProgram,
      resources: {
        chromaticUniforms: new UniformGroup({
          uAmount: { value: amount, type: 'f32' },
        }),
      },
    });
  }

  get amount(): number { return this.resources.chromaticUniforms.uniforms.uAmount; }
  set amount(v: number) { this.resources.chromaticUniforms.uniforms.uAmount = v; }
}

const shieldFrag = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 uv = vTextureCoord - vec2(0.5);
    float dist = length(uv) * 1.4142135;
    // A band hugging the silhouette's own bounding circle, not the true alpha edge —
    // same UV-distance trick as VignetteFilter above, so it needs no extra per-skin
    // wiring to read correctly against both the Graphics placeholder body and a real
    // .tao rig sprite.
    float rim = smoothstep(0.30, 0.5, dist) * (1.0 - smoothstep(0.5, 0.66, dist));
    float shimmer = 0.6 + 0.4 * sin(uTime * 0.006 + dist * 18.0);
    float glow = rim * shimmer * uIntensity;
    color.rgb += uColor * glow;
    color.a = max(color.a, glow * 0.85);
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
      resources: {
        shieldUniforms: new UniformGroup({
          uColor: { value: hexToRgb(color), type: 'vec3<f32>' },
          uIntensity: { value: intensity, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
        }),
      },
    });
  }

  get intensity(): number { return this.resources.shieldUniforms.uniforms.uIntensity; }
  set intensity(v: number) { this.resources.shieldUniforms.uniforms.uIntensity = v; }

  set color(hex: number) { this.resources.shieldUniforms.uniforms.uColor = hexToRgb(hex); }

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

const dissolveFrag = /* glsl */ `
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
    float n = hash(floor(vTextureCoord * 36.0));
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

const heatHazeFrag = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uIntensity;
uniform float uTime;

void main(void)
{
    vec2 uv = vTextureCoord;
    float wobble = sin(uv.y * 40.0 + uTime * 0.012) * 0.012 * uIntensity;
    uv.x += wobble;
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

const normalLitFrag = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize; // same precision note as OutlineFilter above — must stay
// highp in the fragment stage or GL refuses to link against the vertex stage's default.
uniform vec3 uKeyColor;
uniform float uKeyIntensity;
uniform vec2 uPointDir;
uniform vec3 uPointColor;
uniform float uPointIntensity;

// Fixed "lit from upper-left" direction (screen space) — the one directional-lighting
// convention this project already has (RoomBuilder.ts's pillar highlight/shadow bands),
// now reused here instead of invented fresh. z=0.5 keeps the key light from ever fully
// grazing a flat-on sprite.
const vec3 KEY_DIR = vec3(-0.6469, -0.6469, 0.4285); // normalize(vec3(-0.6, -0.6, 0.4))
const float GRADIENT_STRENGTH = 7.0;

float luminance(vec4 c)
{
    // Premultiplied by alpha: fully transparent neighbours contribute zero "height",
    // so the silhouette's own edge reads as a slope (a rim highlight) exactly like a
    // real normal map would, on top of whatever internal shading the flat-cel art
    // already carries (design/13's sprites are rarely a single flat fill).
    return dot(c.rgb, vec3(0.299, 0.587, 0.114)) * c.a;
}

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 px = uInputSize.zw;
    float hR = luminance(texture(uTexture, vTextureCoord + vec2(px.x, 0.0)));
    float hL = luminance(texture(uTexture, vTextureCoord - vec2(px.x, 0.0)));
    float hD = luminance(texture(uTexture, vTextureCoord + vec2(0.0, px.y)));
    float hU = luminance(texture(uTexture, vTextureCoord - vec2(0.0, px.y)));
    float dx = (hR - hL) * GRADIENT_STRENGTH;
    float dy = (hD - hU) * GRADIENT_STRENGTH;
    vec3 normal = normalize(vec3(-dx, -dy, 1.0));

    vec3 pointDirN = normalize(vec3(uPointDir, 0.4));
    float keyTerm = max(0.0, dot(normal, KEY_DIR));
    float pointTerm = max(0.0, dot(normal, pointDirN));

    vec3 lit = vec3(0.55) + keyTerm * uKeyIntensity * uKeyColor + pointTerm * uPointIntensity * uPointColor;
    color.rgb *= lit;
    finalColor = color;
}
`;

/** Dynamic lighting (design/01 fidelity roadmap milestone 2) — the one item left after
 * the four milestone-5 shaders above. Rather than the doc's original literal "separate
 * lightmap layer, multiply-composited" (no `RenderTexture`/deferred-lighting machinery
 * exists anywhere in this codebase, and building one would be disproportionate to a
 * fixed-camera 2D sim), this derives a per-pixel fake normal straight from the sprite's
 * OWN rendered luminance/alpha at shader time — the same neighbour-texel-sampling trick
 * `OutlineFilter` above already uses for alpha-edge detection, just reading brightness
 * instead of alpha and turning the gradient into a normal. No normal-map texture asset
 * exists or is needed. Always attached (every actor is always lit, unlike the
 * conditionally-active shield/outline/dissolve/heat-haze filters) — `Actor.applySkinFilters`
 * puts it first, so it establishes the base-shaded colour every other overlay then
 * modifies. `setPoint`/`clearPoint` are driven per-frame from a `LightRegistry`
 * (`fx/lighting.ts`) — a small pool of local-player-glow + muzzle-flash/impact lights,
 * NOT a full lightmap; see that file's own "own the cost" note. */
export class NormalLitFilter extends Filter {
  constructor(keyColor = 0xfff2e0, keyIntensity = 0.55) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: normalLitFrag, name: 'normal-lit-filter' });
    super({
      glProgram,
      padding: 2,
      resources: {
        normalLitUniforms: new UniformGroup({
          uKeyColor: { value: hexToRgb(keyColor), type: 'vec3<f32>' },
          uKeyIntensity: { value: keyIntensity, type: 'f32' },
          uPointDir: { value: [0, 0], type: 'vec2<f32>' },
          uPointColor: { value: [1, 1, 1], type: 'vec3<f32>' },
          uPointIntensity: { value: 0, type: 'f32' },
        }),
      },
    });
  }

  /** Point-light term for this frame — `dirX`/`dirY` is a normalized world-space
   *  direction FROM the actor TOWARD the light (`LightRegistry.strongestAt`'s own
   *  convention), `intensity` already falloff-adjusted for distance. */
  setPoint(dirX: number, dirY: number, color: number, intensity: number): void {
    const u = this.resources.normalLitUniforms.uniforms;
    u.uPointDir = [dirX, dirY];
    u.uPointColor = hexToRgb(color);
    u.uPointIntensity = intensity;
  }

  /** No light close enough to matter this frame — key light alone still shades. */
  clearPoint(): void {
    this.resources.normalLitUniforms.uniforms.uPointIntensity = 0;
  }
}

function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}
