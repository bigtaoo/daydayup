// Split out of fx/filters.ts (2026-08-18, 500-line convention): the directional-lighting
// filter (design/01 fidelity-roadmap milestone 2), the only one that takes a per-call-site
// look (ambient/gradient) rather than one tuning. It briefly also shaded level geometry
// (RoomBuilder's standing walls, `WALL_LIT_*`) — removed 2026-08-20 after being measured to
// do nothing visible (see RoomBuilder.ts's git history for the numbers); this file now has
// exactly one call site again, the actor-facing `ACTOR_*` look below.
import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js';
import { hexToRgb } from './shaderPrelude';

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
uniform float uAmbient;
uniform float uGradient;

// Fixed "lit from upper-left" direction (screen space) — the one directional-lighting
// convention this project already has (RoomBuilder.ts's pillar highlight/shadow bands),
// now reused here instead of invented fresh. z=0.5 keeps the key light from ever fully
// grazing a flat-on sprite.
const vec3 KEY_DIR = vec3(-0.6469, -0.6469, 0.4285); // normalize(vec3(-0.6, -0.6, 0.4))

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
    float dx = (hR - hL) * uGradient;
    float dy = (hD - hU) * uGradient;
    vec3 normal = normalize(vec3(-dx, -dy, 1.0));

    vec3 pointDirN = normalize(vec3(uPointDir, 0.4));
    float keyTerm = max(0.0, dot(normal, KEY_DIR));
    float pointTerm = max(0.0, dot(normal, pointDirN));

    vec3 lit = vec3(uAmbient) + keyTerm * uKeyIntensity * uKeyColor + pointTerm * uPointIntensity * uPointColor;
    color.rgb *= lit;
    finalColor = color;
}
`;

/** Ambient floor + fake-normal gain for an ACTOR (the original, and still the default):
 *  ambient 0.55 means an actor's unlit side drops to 55% of its painted colour, and the
 *  strong gradient gain reads every internal luminance edge of a small, busy character
 *  sprite as relief. */
const ACTOR_AMBIENT = 0.55;
const ACTOR_GRADIENT = 7.0;

/** Per-call-site look for `NormalLitFilter` (2026-08-18) — see `ACTOR_*` above. */
export interface NormalLitOptions {
  /** Shading floor: what an entirely unlit texel is multiplied by. */
  ambient?: number;
  /** Gain on the luminance gradient that stands in for a normal map. */
  gradient?: number;
}

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
  constructor(keyColor = 0xfff2e0, keyIntensity = 0.55, opts: NormalLitOptions = {}) {
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
          uAmbient: { value: opts.ambient ?? ACTOR_AMBIENT, type: 'f32' },
          uGradient: { value: opts.gradient ?? ACTOR_GRADIENT, type: 'f32' },
        }),
      },
    });
  }

  /** The unlit floor of the shading term — exposed for tests (an actor's `ACTOR_AMBIENT < 1`
   *  means its unlit side darkens; a future non-actor look with `ambient > 1 − key` would
   *  brighten its lit side instead, the way `WALL_LIT_AMBIENT` briefly did before it was
   *  removed as visually inert — see this file's header). */
  get ambient(): number { return this.resources.normalLitUniforms.uniforms.uAmbient; }
  get gradient(): number { return this.resources.normalLitUniforms.uniforms.uGradient; }

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
