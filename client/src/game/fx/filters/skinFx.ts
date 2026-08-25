// Split out of fx/filters.ts (2026-08-18, 500-line convention): the four PER-ACTOR skin
// filters (design/01 fidelity-roadmap milestone 5) — shield shell, hit outline,
// death dissolve, burn heat-haze. Attached to one `Skin.view` at a time by
// `Actor.applySkinFilters`, never to the whole screen.
import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js';
import { FRAME_UV, hexToRgb } from './shaderPrelude';

const shieldFrag = FRAME_UV + /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    // Region-normalized, NOT raw \`vTextureCoord\` — this shell's centre is the whole point
    // of the filter and the raw coord's midpoint is the pool texture's, not the actor's.
    // See FRAME_UV above for the full story (this is the bug that produced the long-
    // running "shield renders as a partial crescent" report).
    vec2 uv = frameUv(vTextureCoord) - vec2(0.5);
    // A CIRCLE, deliberately — no vertical foreshortening, unlike every other round thing
    // around a body here (2026-08-24, user report: *"护盾成了一个圆圈, 我希望是圆形护盾的效果,
    // 最初那种效果是对的"*). The 2026-08-18 depth pass had divided \`uv.y\` by 0.62, the same
    // squash \`Entity\`'s ground shadow and \`Actor.setStatus\`'s auras use, on the reasoning
    // that "every round thing wrapping a body in a tilted view foreshortens the same way".
    // That reasoning holds for a shadow and an aura and does NOT hold for this: those are
    // flat discs lying ON THE GROUND PLANE, which a tilted camera compresses; a shield is a
    // SPHERE around the body, and a sphere's silhouette is a circle from every angle. The
    // squashed version read on screen as a flat hoop threaded through the character at gun
    // height — the "圆圈" of the report — instead of a bubble enclosing it.
    float dist = length(uv) * 1.4142135;
    // A SOLID SHELL, not a rim band (2026-08-25, user report: *"现在的护盾是一个圆圈包裹着
    // 角色, 我希望的是类似一个透明的蛋壳一样的效果将角色全部包裹, 而不是一个圆环"*). Every
    // version up to here was \`smoothstep(a, b, dist) * (1.0 - smoothstep(b, c, dist))\` — a
    // band with a HOLE in it, so the character stood in empty space with a hoop drawn round
    // its waist. What follows instead treats the region as a glass sphere: the interior is
    // filled (faintly — you have to still read the character through it), and the brightness
    // comes from where the surface turns away from the viewer, which is what makes a
    // transparent shell look like a shell rather than a decal.
    //
    // \`SHELL_R\` is the outer surface, in the same \`dist\` units as above. \`Actor\` pins this
    // filter's area to a square 6 body radii per side, so \`dist\` D sits D * 6 / sqrt(2) body
    // radii out: 0.44 is ~1.87 radii, an envelope that encloses the WHOLE character — body,
    // spikes and mounted weapon (the 2026-08-25 report asks for the character 全部包裹, and at
    // ~1.55 radii the gun barrels stuck out through it) — while stopping short of pooling on the
    // floor around the feet, where the ground shadow has to stay readable (that is what the
    // 2026-08-19 volume pass added, and what an opaque overlay here eats).
    const float SHELL_R = 0.44;
    // Sphere normal's z at this pixel: 1.0 face-on at the centre, 0.0 at the silhouette
    // edge. \`1.0 - nz\` is therefore the grazing-angle term — Fresnel, cubed so the limb
    // brightening stays tight against the edge instead of washing the whole disc out.
    float r = min(dist / SHELL_R, 1.0);
    float nz = sqrt(max(0.0, 1.0 - r * r));
    float fresnel = pow(1.0 - nz, 3.0);
    // Falls to nothing just PAST the surface, which is also where \`fresnel\` is pinned at 1 —
    // so the same term doubles as the shell's soft outer bloom. Never rises with \`dist\`:
    // that is the difference between a shell and the ring this replaced.
    float shell = 1.0 - smoothstep(SHELL_R, SHELL_R + 0.045, dist);
    // \`FILL\` is the glass tint — the whole interior is painted, not just the edge, which is the
    // difference between a shell and an outline — and the fresnel term carries it the rest of the
    // way to a bright limb. It is DAMPED by the body's own alpha (\`1.0 - 0.55 * color.a\`): over
    // empty background the fill is the bubble you look through, but over the character it is an
    // additive wash on top of the art, and at full strength it flattened the hero's face — the
    // saturated blue eye came out as the same pale cyan as the shell around it.
    const float FILL = 0.14;
    float glass = shell * (FILL * (1.0 - 0.55 * color.a) + 0.86 * fresnel);
    // A single specular blob up and to the left, the one cue that reads instantly as
    // "curved and transparent" (every drawn soap bubble / egg has one). Positioned in \`uv\`
    // space at ~0.6 of the shell radius — far enough out to land on CLEAR shell rather than on the
    // body, where an additive glint over pale character art is invisible. Screen-y points down.
    vec2 hi = uv - vec2(-0.120, -0.143);
    float spec = shell * exp(-dot(hi, hi) * 260.0) * 1.3;
    // Shimmer: a slow breathing pulse, not a flicker (user report, 2026-08-17: "护盾的
    // 闪烁频率降低"). Was \`0.6 + 0.4 * sin(uTime * 0.006 + dist * 18.0)\` — 0.006 rad/ms
    // is ~0.95 Hz, and with the shell's own 18-cycle radial banding scrolling through it
    // the combined effect read as a strobe on the character's silhouette rather than as
    // energy. Two changes: the temporal rate drops to ~0.29 Hz (one pulse per ~3.4s),
    // and the swing narrows from ±0.4 to ±0.25 around a brighter base, so the shield
    // stays continuously readable instead of dimming to 0.6x every cycle. The radial
    // term is halved too — it is what turns a slow pulse back into visible ripple
    // banding as the wave crosses the surface.
    float shimmer = 0.75 + 0.25 * sin(uTime * 0.0018 + dist * 9.0);
    float glow = (glass + spec) * shimmer * uIntensity;
    color.rgb += uColor * glow;
    // 0.85 -> 0.7: what this line does is paint the glow onto TRANSPARENT background outside
    // the body, so it is also the knob that decides how much floor the shield hides. With the
    // fill above it now applies to the shell's INTERIOR too — at FILL 0.14 that lands near
    // 8% alpha over the ground, a tint the shadow still reads through.
    color.a = max(color.a, glow * 0.7);
    finalColor = color;
}
`;

/** A shimmering transparent shell enclosing a character — the "energy shield" custom
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
      // The shell is positioned relative to the filtered REGION's centre, so the
      // region has to stay the full `Actor.filterArea` square. Pixi otherwise intersects
      // it with the viewport (`FilterSystem._calculateFilterBounds`), which would crop
      // the square — and therefore move its centre — for any shielded actor standing
      // near a screen edge, reintroducing the lopsided glow in exactly that spot. Safe
      // to disable here because `filterArea` already bounds this filter to a small fixed
      // square (3× body radius); it is NOT safe for the two screen-wide post-fx above,
      // which rely on the clip to size themselves to the viewport.
      clipToViewport: false,
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
