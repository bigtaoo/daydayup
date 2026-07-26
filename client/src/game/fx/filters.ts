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
