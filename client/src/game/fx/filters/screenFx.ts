// Split out of fx/filters.ts (2026-08-18, 500-line convention): the two SCREEN-SPACE
// post-processing filters, applied to the whole `world` container rather than to one
// sprite. Both size themselves from the filtered region, so both need FRAME_UV.
import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js';
import { FRAME_UV } from './shaderPrelude';

const vignetteFrag = FRAME_UV + /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uIntensity;
uniform float uRadius;

void main(void)
{
    vec4 color = texture(uTexture, vTextureCoord);
    vec2 uv = frameUv(vTextureCoord) - vec2(0.5);
    float dist = length(uv) * 1.4142135;
    float vig = smoothstep(uRadius, 1.0, dist);
    color.rgb *= (1.0 - vig * uIntensity);
    finalColor = color;
}
`;

/** Darkens the screen edges — a first-pass approximation (the filtered region is `world`'s
 * viewport-clipped bounds, not exactly the viewport, so this reads as "centred on what's
 * on screen" rather than on a true screen centre; `frameUv` at least makes it centred on
 * that region instead of on the pool texture, see FRAME_UV above). */
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

const chromaticFrag = FRAME_UV + /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uAmount;

void main(void)
{
    // Split direction is region-space (outward from the region's centre), but the sample
    // offset it produces has to be applied in texcoord space — see FRAME_UV above.
    vec2 dir = frameUv(vTextureCoord) - vec2(0.5);
    vec2 shift = frameOffset(dir * uAmount);
    float r = texture(uTexture, clampToFrame(vTextureCoord - shift)).r;
    float g = texture(uTexture, vTextureCoord).g;
    float b = texture(uTexture, clampToFrame(vTextureCoord + shift)).b;
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
