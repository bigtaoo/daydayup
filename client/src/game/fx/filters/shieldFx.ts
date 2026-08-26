// Split out of skinFx.ts (2026-08-26, 500-line convention): the SHIELD SHELL and nothing else
// — by far the largest of the four per-actor skin filters, and the only one of them with a
// second texture, a radial cull and an exit animation of its own. The `shield_break` exit
// (`shatter`) is what pushed skinFx.ts past 500 lines; this is CLAUDE.md's form (1), a split by
// domain into a sibling module of unrelated classes, not an inheritance chain — nothing here
// shares state with the outline / dissolve / heat-haze filters left behind.
//
// A sibling of `shieldScales.ts` (which it imports, never the other way round) and of
// `skinFx.ts` (which does NOT import it — `fx/filters.ts` is the assembly shell that re-exports
// both).
import { Filter, GlProgram, UniformGroup, defaultFilterVert } from 'pixi.js';
import { FRAME_UV, hexToRgb } from './shaderPrelude';
import { shieldScaleTexture } from './shieldScales';

const shieldFrag = FRAME_UV + /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uScales;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uMembrane;
uniform vec3 uHit; // xy = unit impact direction, z = ms since that impact
uniform float uShatter; // the exit: 0 intact, 1 gone. Rest value 0.

void main(void)
{
    // Region-normalized, NOT raw \`vTextureCoord\` — this shell's centre is the whole point
    // of the filter and the raw coord's midpoint is the pool texture's, not the actor's.
    // See FRAME_UV above for the full story (this is the bug that produced the long-
    // running "shield renders as a partial crescent" report).
    vec2 uv = frameUv(vTextureCoord) - vec2(0.5);

    // ---- 1. impact: an ELASTIC DENT along the hit axis ------------------------------
    // 2026-08-26. Until now the shield had exactly one dynamic — \`uIntensity\` tracking
    // the pool — and did nothing at all when the actor was hit: \`ActorFilters.hitFlash\`
    // drove only the white \`OutlineFilter\`. This is what 20-year-old sprite shields did
    // with hand-drawn squash frames, done properly: the envelope is a DAMPED OSCILLATION
    // (\`exp\` decay times \`cos\`), so the surface springs back past its rest radius and
    // settles, rather than fading out. A fade reads as "the glow dimmed"; a rebound reads
    // as "something hit it".
    float env = exp(-uHit.z * 0.0055);
    float wob = env * cos(uHit.z * 0.019);
    // Outward from the actor's centre. Written by hand rather than via normalize() so the
    // shader stays inside the small builtin set the GLSL evaluator in shieldShellModel.test.ts
    // implements; the guard is for the one pixel dead on the centre.
    vec2 dir = uv / max(length(uv), 1e-5);
    // +1 at the point the hit landed, -1 directly opposite.
    float toward = dot(dir, -uHit.xy);
    float nearSide = smoothstep(-0.1, 1.0, toward);
    float farSide = smoothstep(-0.1, 1.0, -toward);

    // ---- 1b. the SHATTER: the shell throwing itself open ----------------------------
    // 2026-08-26, the one item the shell rewrite left open. Until now the filter was simply
    // dropped from \`ActorFilters\`' composed list the frame the pool hit 0 — the shell vanished
    // between two frames and \`EventReactor\`'s burst had to carry the whole moment. \`uShatter\`
    // runs 0 -> 1 over SHATTER_MS while \`ActorFilters\` holds the filter attached, the same
    // "keep the view alive past the state change" shape \`startDissolve\` uses.
    //
    // Eased OUT (fast, then coasting): the shell leaps at the break and drifts apart. The
    // reverse profile reads as a slow inflation, which is a bubble growing, not one bursting.
    float burst = uShatter * (2.0 - uShatter);
    // The exit's whole fade lives here rather than in a second clock in the wiring: at
    // uShatter = 1 every additive term below is exactly 0, so the filter is drawing nothing at
    // the moment \`ActorFilters\` detaches it and there is no step to see.
    //
    // \`ActorFilters\` flares \`uIntensity\` to 1 at the break instead of letting the shell exit
    // from whatever sliver of pool it died with — a shield that broke from 12% would otherwise
    // play its whole exit at 12% brightness, i.e. invisibly. That flare also lifts the
    // refraction below for one frame, which is deliberate: the frame it lands on is behind
    // EventReactor's 50 ms hit-stop and a 28 px burst, and a shell bending light harder as it
    // lets go is the read we want there.
    float energy = uIntensity * (1.0 - uShatter);

    // \`SHELL_R\` is the outer surface in the same \`dist\` units as below. \`Actor\` pins this
    // filter's area to a square 6 body radii per side, so \`dist\` D sits D * 6 / sqrt(2) body
    // radii out: 0.44 is ~1.87 radii, an envelope that encloses the WHOLE character — body,
    // spikes and mounted weapon — while stopping short of pooling on the floor around the
    // feet, where the ground shadow has to stay readable.
    const float SHELL_R = 0.44;
    // How far the exit throws the outer surface, as a fraction of SHELL_R. Bounded by the
    // filter's own area and not by taste: the region reaches \`dist\` 0.707 along its narrowest
    // axis, and everything the shader draws lives inside CULL surfaces, so the ceiling is
    // 0.707 / (0.44 * 1.18) - 1 = 0.36. 0.30 leaves margin; the suite measures the clearance
    // rather than trusting this arithmetic.
    const float BURST = 0.30;
    // The expansion goes into \`surface\` itself, NOT into \`b\` afterwards — which is what keeps
    // the cull below correct for free. \`b\` is measured in surfaces, so a shell that grew by
    // 30% has a cull radius that grew with it and nothing visible is ever clipped by it.
    float surface = SHELL_R * (1.0 + BURST * burst)
      * (1.0 - 0.115 * wob * nearSide + 0.06 * wob * farSide);

    float dist = length(uv) * 1.4142135;
    // \`b\` is the view ray's impact parameter in units of the (possibly dented) surface
    // radius: 0 dead centre, 1 exactly at the silhouette.
    float b = dist / surface;

    // ---- 2. cull ---------------------------------------------------------------------
    // The shell occupies ~30% of the filtered square, so without this two thirds of the
    // pixels run the whole shader to produce zero. The skipped area is one large contiguous
    // ring, which is the case a GPU's branch granularity handles well — whole warps exit.
    // CULL is set where the only term still alive out there, \`halo\`, has fallen below one
    // 8-bit step; the measured suite pins that rather than trusting it, at rest AND across the
    // exit. It is a radius in SURFACES, and the exit's expansion is already inside \`surface\`,
    // so it grows with the shell instead of clipping it — the alternative (adding the burst to
    // \`dist\` or to \`b\`) would need this constant driven from \`uShatter\` to stay honest.
    const float CULL = 1.18;
    if (b > CULL) { finalColor = texture(uTexture, vTextureCoord); return; }

    float r = min(b, 1.0);
    // Sphere normal's z: 1.0 face-on at the centre, 0.0 at the silhouette edge.
    float nz = sqrt(max(0.0, 1.0 - r * r));
    // Feathered from well inside the surface, not from it. \`nz\` has an infinite slope at the
    // silhouette, so a mask that only starts there drops the wall term to zero across about
    // half a screen pixel — a hairline exactly where the 2026-08-26 report said the edge was
    // too hard. Starting at 0.90 spreads that over ~12 px at gameplay zoom and hands the
    // outside over to \`halo\`, which is smooth by construction.
    float inside = 1.0 - smoothstep(0.90, 1.02, b);

    // ---- 3. refraction ---------------------------------------------------------------
    // The single strongest "this is a shell and not a decal" cue, and nearly free: this
    // filter already samples the character's own texture, so bending the sample point by the
    // sphere normal shows the character THROUGH the glass — magnified face-on, smeared
    // toward the limb. The second term is the impact shoving that view sideways for as long
    // as the dent lasts.
    // Faded with \`energy\` along with everything else — the pool while the shield is up, and the
    // exit's own collapse after it breaks. Left at full strength (the first version of this
    // line) the character stayed visibly warped while the glow drained away and then un-warped
    // in a single frame the moment the filter was detached.
    vec2 bend = frameOffset((uv * (-0.17 * (1.0 - nz) * inside)
      + uHit.xy * (0.020 * env * nearSide * inside)) * energy);
    vec4 color = texture(uTexture, clampToFrame(vTextureCoord + bend));

    // ---- 4. the WALL, as a chord and not an edge -------------------------------------
    // 2026-08-26, user report: *"没有被蛋壳包裹的感觉 … 边缘的那个圈太过实线了"*. Every
    // version up to here derived brightness from \`pow(1.0 - nz, 3.0)\`, which equals 1 only
    // AT the silhouette — mathematically a ring, whatever the surrounding code called it,
    // with a flat \`FILL\` plate inside it. What replaces it is the length of the view ray's
    // chord through a shell of real THICKNESS: an outer sphere minus an inner one. That
    // profile peaks at the INNER wall (b = 1 - THICKNESS) and falls away on both sides, so
    // the bright part has width and the outer edge tapers instead of stopping.
    const float THICKNESS = 0.22;
    // The wall THINS as the shell throws itself open. A shell that expanded at constant
    // thickness reads as inflating; one whose wall is stretched to a rim while its radius grows
    // reads as a surface being pulled apart, which is the thing being animated. Not taken all
    // the way to zero — the chord would collapse with it and the last third of the exit would
    // have no wall left to look at, only the halo.
    const float SHATTER_THIN = 0.82;
    float innerR = 1.0 - THICKNESS * (1.0 - SHATTER_THIN * uShatter);
    float innerChord = sqrt(max(0.0, innerR * innerR - r * r));
    float wall = nz - innerChord;
    // Beer-Lambert rather than the raw length: a chord twice as long is not twice as bright,
    // and the saturation is what keeps the peak from blowing out.
    // The 1.6 is a contrast curve, not physics: it pulls the INTERIOR down harder than the
    // wall (0.26 -> 0.11 at the centre, 0.57 -> 0.41 at the peak). What it is set against is
    // \`Entity\`'s SHADOW_ALPHA_INNER of 0.1 — the ground shadow is a 10% darkening, and a shell
    // interior that composites over it at more than about that much stops the actor reading as
    // planted. Measured, not asserted, in shieldShellModel.test.ts.
    float density = pow(1.0 - exp(-1.35 * wall), 1.6) * inside;
    // The soft outer bloom. Rises INTO the surface and decays past it, so it meets the wall
    // term (which is going to zero there) without a seam — together they are one continuous
    // falloff. This is the term the cull above is sized against.
    float halo = exp(-max(0.0, b - 1.0) * 26.0) * 0.18 * smoothstep(0.75, 1.0, b);

    // ---- 5. the MEMBRANE -------------------------------------------------------------
    // A surface needs a repeating detail element before the eye will accept it as a physical
    // membrane; a smooth gradient reads as a filter no matter how well shaped. The tile is
    // generated, not authored — see filters/shieldScales.ts for why.
    //
    // The projection is \`uv / (nz + k)\`, deliberately NOT true spherical coordinates: it
    // compresses the pattern toward the limb (which is the whole point — that is what makes
    // a flat tile read as wrapped onto a sphere) for one divide, where atan/asin would cost
    // four transcendentals per pixel AND introduce a pole singularity that then has to be
    // damped back out.
    // Off \`energy\`, not \`uIntensity\`: the exit's own collapse therefore runs the same
    // extinction the pool drain does, only in 200 ms — whole scales going dark in the tile's
    // shuffled rank order while the shell comes apart, and \`tint\` swinging to the hot end.
    float integrity = smoothstep(0.0, 0.45, energy);
    // Angular distance from the impact point: 0 there, 2 at the antipode.
    float arc = 1.0 - toward;
    float ripple = sin(arc * 9.0 - uHit.z * 0.022) * exp(-arc * 1.6) * env;
    // The slow breath now modulates ONLY the membrane, never the shell's own brightness.
    // Modulating everything is what made the previous version read as a strobe on the
    // character's silhouette; a surface whose pattern shifts while its body stays put reads
    // as energy moving across something solid.
    float breath = 0.62 + 0.12 * sin(uTime * 0.0018) + 0.38 * max(0.0, ripple);
    // Faded out in the last sliver before the limb: that is where the projection's own
    // compression is worst (so the pattern would alias), and where the wall term is
    // brightest anyway.
    float grain = smoothstep(0.0, 0.22, nz);
    // Declared before the branch so the bare wall is what a membrane-less tier draws.
    float front = density;
    float back = density * 0.5;
    // A UNIFORM branch: every fragment in the draw takes the same side, so there is no divergence
    // to pay for. The first version multiplied \`uMembrane\` into the result instead, which turned
    // the membrane off visually while still sampling the tile twice.
    //
    // Measured, and the honest answer is that it does NOT pay on desktop: 0.223 ms with the
    // membrane vs 0.231 ms without, over a 768px region on an Intel Arc Pro — inside the run-to-
    // run spread, i.e. no saving at all. This region is fill-bound, and two cached tile fetches
    // are not what it is spending its time on. The branch stays because it is correct and free,
    // and because a bandwidth-bound mobile GPU is the case where those fetches would show up —
    // but that case is UNMEASURED (design/04 item 6), so nothing here should be read as a
    // promise about it. The lever that actually pays is the radial cull above: 46%.
    if (uMembrane > 0.0) {
        const float TILE = 0.55;
        vec2 warpF = uv * (TILE / (surface * (nz + 0.35)));
        // The back layer is the same projection at a different scale and offset. Not a
        // physically-derived far-side mapping — just a second, non-coincident layer, which is
        // all the volume cue needs.
        vec2 warpB = warpF * 0.92 + vec2(0.37, 0.21);
        // The exit's per-cell THROW. Each scale leaves at its own speed, keyed off the tile's
        // GREEN channel — the cell's place in the shuffled extinction order (shieldScales.ts),
        // which is already a per-cell constant and already scattered across the tile, so the
        // membrane comes apart in pieces rather than sliding off as one sheet. Sampling
        // \`warp - dir * throw\` moves the cell OUTWARD on screen by \`throw\`.
        //
        // Reading a per-cell constant costs a tap of its own: which cell is under this pixel is
        // exactly what the tap answers. At rest \`uShatter\` is 0, the offset is exactly zero, and
        // the second tap lands on the texel the first one already pulled in.
        const float SCATTER = 0.62;
        float throwF = (0.35 + 0.9 * texture(uScales, warpF).g) * SCATTER * uShatter;
        float throwB = (0.35 + 0.9 * texture(uScales, warpB).g) * SCATTER * uShatter;
        vec4 sF = texture(uScales, warpF - dir * throwF);
        vec4 sB = texture(uScales, warpB - dir * throwB);
        // design/13's dual-channel law, applied to the damage state: as the pool drains, whole
        // scales go out one at a time (the tile's GREEN channel is a per-cell constant), so a
        // failing shield changes SHAPE and not only brightness. \`tint\` below carries the second
        // half of it.
        float liveF = mix(0.25, 1.0, step(1.0 - integrity, sF.g * 0.9 + 0.1));
        float liveB = mix(0.25, 1.0, step(1.0 - integrity, sB.g * 0.9 + 0.1));
        float membrane = 0.85 * grain * breath * uMembrane;
        front = density * (1.0 + membrane * sF.r * liveF);
        back = density * (1.0 + membrane * sB.r * liveB) * 0.5;
    }

    // ---- 6. highlights ---------------------------------------------------------------
    // A single specular blob up and to the left, the one cue that reads instantly as "curved
    // and transparent" (every drawn soap bubble / egg has one). Screen-y points down.
    vec2 hi = uv - vec2(-0.085, -0.100);
    float spec = inside * exp(-dot(hi, hi) * 430.0) * 0.55;
    // The impact's own bloom, concentrated on the struck hemisphere.
    float impact = env * exp(-arc * 3.2) * 1.1 * inside;

    // ---- 7. composite: the character sits BETWEEN the two halves ---------------------
    // This is the "包裹" cue, and it is one multiplication: the back hemisphere is occluded
    // by the character's own alpha, the front is not. Every previous version added
    // everything on top of the character, which is why it read as a decal in front of it
    // however the shape was tuned — nothing was ever behind.
    const float GAIN = 0.42;
    vec3 tint = mix(vec3(1.0, 0.62, 0.42), uColor, integrity);
    float glow = (front * GAIN + halo + spec + impact) * energy;
    float behind = (back * GAIN + impact * 0.5) * energy * (1.0 - color.a);
    // A faint tint ON the art, not just light over it — glass with substance. Damped hard,
    // and only where the body is actually opaque: at full strength this flattened the hero's
    // face, the saturated blue eye coming out the same pale cyan as the shell.
    color.rgb = mix(color.rgb, tint * 0.55, 0.16 * density * energy * color.a);
    color.rgb += tint * (glow + behind);
    // 0.7 is also the knob deciding how much floor the shield hides — the ground shadow
    // under a shielded actor has to stay readable through the interior.
    color.a = max(color.a, (glow + behind) * 0.7);
    finalColor = color;
}
`;

/** Rest value of `uHit.z`: far enough back that the impact envelope has decayed to ~2e-5,
 *  so a filter that has never been hit computes an unperturbed sphere. */
const HIT_SETTLED_MS = 4000;

/** A transparent shell enclosing a character — the "energy shield" custom shader (design/01
 * fidelity roadmap milestone 5). `intensity` is driven by the live shield ratio
 * (Actor.setShield): full glow at a full shield pool, fading as it drains. Once it hits 0 the
 * shell plays its own ~200 ms exit (`shatter`, 2026-08-26) rather than being dropped between
 * two frames — expanding, its wall thinning to a rim, its scales thrown outward and its light
 * collapsing to nothing. `EventReactor`'s positional burst and `ParticleSystem.shieldShards`
 * cover the same instant in world space; this covers the shell itself. */
export class EnergyShieldFilter extends Filter {
  private clock = 0;

  constructor(color = 0x66e0ff, intensity = 0) {
    const glProgram = GlProgram.from({ vertex: defaultFilterVert, fragment: shieldFrag, name: 'energy-shield-filter' });
    const scales = shieldScaleTexture();
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
          uMembrane: { value: 1, type: 'f32' },
          uHit: { value: [0, -1, HIT_SETTLED_MS], type: 'vec3<f32>' },
          uShatter: { value: 0, type: 'f32' },
        }),
        // Matches Pixi's own `DisplacementFilter`: the source binds the `sampler2D`, the
        // style is what a WGSL backend would want. Both platforms force `preference:'webgl'`
        // (design/04) so only the first is ever read today.
        uScales: scales.source,
        uScalesSampler: scales.source.style,
      },
    });
  }

  get intensity(): number { return this.resources.shieldUniforms.uniforms.uIntensity; }
  set intensity(v: number) { this.resources.shieldUniforms.uniforms.uIntensity = v; }

  set color(hex: number) { this.resources.shieldUniforms.uniforms.uColor = hexToRgb(hex); }

  /** The shell's exit, 0 (intact) → 1 (gone). Driven by `ActorFilters` over `SHATTER_MS` once
   *  the pool empties, exactly the way `DISSOLVE_MS` drives `DissolveFilter.progress` — the
   *  filter stays attached for the whole of it. At 1 every additive term the shader computes is
   *  0, which is what makes the detach that follows invisible. */
  get shatter(): number { return this.resources.shieldUniforms.uniforms.uShatter; }
  set shatter(v: number) { this.resources.shieldUniforms.uniforms.uShatter = v; }

  /** The membrane pattern, 0..1. The lever for a device that cannot afford it: at 0 the
   *  shader still draws the shell's SHAPE (the wall chord, the occluded back hemisphere,
   *  refraction) and only the two tile samples stop contributing. Nothing sets it below 1
   *  today — `render/quality.ts`'s low tier drops every per-actor shader outright, so a
   *  profile field for this would be a knob whose trigger no code path can reach — but it
   *  exists so a future middle tier is a one-line change rather than a rewrite. */
  set membrane(v: number) { this.resources.shieldUniforms.uniforms.uMembrane = v; }
  get membrane(): number { return this.resources.shieldUniforms.uniforms.uMembrane; }

  /** Milliseconds since the last `hit()`, clamped at `HIT_SETTLED_MS`. */
  get hitAge(): number { return (this.resources.shieldUniforms.uniforms.uHit as number[])[2]!; }

  /**
   * Register an impact. `dx`/`dy` point from the actor's centre toward where the hit landed,
   * in screen space (y down); they are normalized here, so callers can hand over a raw
   * delta. Restarts the elastic dent from zero — a second hit during the first one's rebound
   * is a new dent, not a summed one. A zero-length delta (a hit resolved exactly on the
   * actor's own centre) keeps the previous direction rather than producing a NaN axis.
   */
  hit(dx: number, dy: number): void {
    const len = Math.hypot(dx, dy);
    const u = this.resources.shieldUniforms.uniforms;
    const prev = u.uHit as number[];
    u.uHit = len > 1e-4 ? [dx / len, dy / len, 0] : [prev[0]!, prev[1]!, 0];
  }

  /** Advance the shimmer and impact clocks — call once per rendered frame while attached. */
  tick(frameDt: number): void {
    this.clock += frameDt;
    const u = this.resources.shieldUniforms.uniforms;
    u.uTime = this.clock;
    const hit = u.uHit as number[];
    // Parked at the rest value once settled: left free-running, `uHit.z` would grow without
    // bound for the whole session and `exp(-z * k)` would eventually underflow to a denormal.
    if (hit[2]! < HIT_SETTLED_MS) {
      u.uHit = [hit[0]!, hit[1]!, Math.min(HIT_SETTLED_MS, hit[2]! + frameDt)];
    }
  }
}
