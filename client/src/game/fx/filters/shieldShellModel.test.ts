/**
 * `EnergyShieldFilter`, MEASURED — the other half of `filters.test.ts`'s shield suite.
 *
 * That suite reads the shipped GLSL as text: it asserts the shader *says* the right things
 * (no term rising with `dist`, a fill constant, a fresnel exponent, a radius in body radii).
 * Text is the wrong evidence for the question the 2026-08-25 report actually asked — *"是一
 * 个圆圈…我希望的是类似一个透明的蛋壳一样的效果将角色全部包裹"* — because that question is
 * about a SHAPE, and a shape is a profile of numbers, not a set of constants. Two shaders can
 * pass every regex in that file and paint completely different things.
 *
 * So this file runs the shader. There is no GL context under vitest (and no way to get one on
 * this machine — see `sceneLightModel.test.ts`, which reimplements its shader's equation in
 * TS for the same reason), but this shader's `main` is straight-line float math over a handful
 * of builtins, which is small enough to INTERPRET. `evalGlsl` below is an evaluator for that
 * subset, and it runs the real `glProgram.fragment` string — prelude functions, `frameUv`'s
 * pow2 remap and all. Nothing here duplicates a constant or a formula: change the shader and
 * these tests re-measure it, rather than passing against a stale copy.
 *
 * Deliberately runs the WHOLE pipeline including `frameUv`, so the pow2 pool-texture bug that
 * produced a long run of "the shield renders as a crescent" reports is a case here (see the
 * last describe) rather than a comment.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  });
});

// eslint-disable-next-line import/first
import { EnergyShieldFilter } from './skinFx';

// ---------------------------------------------------------------------------------------
// A GLSL-subset evaluator.
//
// Values are always number[] — a scalar is length 1 — so every operator broadcasts the way
// GLSL's do without a separate scalar path. Supports: `float/vec2/vec3/vec4` declarations
// (`const` too), assignment and `+=` to a name or a swizzle, single-`return` user functions
// (the prelude's `frameUv`), and the builtins this shader uses. Anything else throws: a
// shader that grows an `if` or a `for` must fail here loudly, not be silently half-evaluated.
// ---------------------------------------------------------------------------------------

type Val = number[];
type Env = Record<string, Val>;

const SWIZZLE: Record<string, number> = {
  x: 0, y: 1, z: 2, w: 3,
  r: 0, g: 1, b: 2, a: 3,
  s: 0, t: 1, p: 2, q: 3,
};

/** Strip comments — a shader's prose quotes old formulas, and they would parse. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

function tokenize(src: string): string[] {
  const re = /\s*(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|[A-Za-z_]\w*|\+=|-=|\*=|\/=|[-+*/(),.;=])/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(src))) {
    if (m.index !== at) throw new Error(`glslEval: cannot tokenize near "${src.slice(at, at + 24)}"`);
    out.push(m[1]!);
    at = re.lastIndex;
  }
  if (src.slice(at).trim()) throw new Error(`glslEval: trailing garbage "${src.slice(at, at + 24)}"`);
  return out;
}

const pick = (v: Val, i: number): number => v[v.length === 1 ? 0 : i]!;

const broadcast = (a: Val, b: Val, f: (x: number, y: number) => number): Val => {
  if (a.length !== 1 && b.length !== 1 && a.length !== b.length) {
    throw new Error(`glslEval: cannot combine vec${a.length} with vec${b.length}`);
  }
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => f(pick(a, i), pick(b, i)));
};

const smoothstep1 = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

interface Fn { params: string[]; body: string }

class Evaluator {
  private toks: string[] = [];
  private at = 0;

  constructor(private readonly fns: Record<string, Fn>, private readonly env: Env) {}

  /** Evaluate one expression source string against this evaluator's env. */
  expr(src: string): Val {
    const savedToks = this.toks;
    const savedAt = this.at;
    this.toks = tokenize(src);
    this.at = 0;
    const v = this.binary(1);
    const unconsumed = this.at !== this.toks.length;
    this.toks = savedToks;
    this.at = savedAt;
    if (unconsumed) throw new Error(`glslEval: unconsumed input in "${src}"`);
    return v;
  }

  private peek(): string | undefined {
    return this.toks[this.at];
  }

  private take(expected?: string): string {
    const t = this.toks[this.at++];
    if (t === undefined || (expected !== undefined && t !== expected)) {
      throw new Error(`glslEval: expected "${expected ?? '<token>'}", got "${t}"`);
    }
    return t;
  }

  private binary(minPrec: number): Val {
    let left = this.unary();
    for (;;) {
      const op = this.peek();
      const prec = op === '*' || op === '/' ? 2 : op === '+' || op === '-' ? 1 : 0;
      if (prec === 0 || prec < minPrec) return left;
      this.take();
      const right = this.binary(prec + 1);
      left = broadcast(left, right, (a, b) =>
        (op === '*' ? a * b : op === '/' ? a / b : op === '+' ? a + b : a - b));
    }
  }

  private unary(): Val {
    if (this.peek() === '-') {
      this.take();
      return this.unary().map((v) => -v);
    }
    return this.postfix();
  }

  private postfix(): Val {
    let v = this.primary();
    while (this.peek() === '.') {
      this.take('.');
      const swz = this.take();
      v = [...swz].map((c) => {
        const i = SWIZZLE[c];
        if (i === undefined || i >= v.length) throw new Error(`glslEval: bad swizzle ".${swz}"`);
        return v[i]!;
      });
    }
    return v;
  }

  private primary(): Val {
    const t = this.take();
    if (t === '(') {
      const v = this.binary(1);
      this.take(')');
      return v;
    }
    if (/^[\d.]/.test(t)) return [Number(t)];
    if (this.peek() === '(') {
      this.take('(');
      const args: Val[] = [];
      if (this.peek() !== ')') {
        args.push(this.binary(1));
        while (this.peek() === ',') {
          this.take(',');
          args.push(this.binary(1));
        }
      }
      this.take(')');
      return this.call(t, args);
    }
    const v = this.env[t];
    if (!v) throw new Error(`glslEval: undefined identifier "${t}"`);
    return v;
  }

  private call(name: string, args: Val[]): Val {
    const map1 = (f: (x: number) => number): Val => args[0]!.map(f);
    const widest = (): number => Math.max(...args.map((a) => a.length));
    switch (name) {
      case 'vec2': case 'vec3': case 'vec4': {
        const n = Number(name.slice(3));
        const flat = args.flat();
        return flat.length === 1 ? (Array(n).fill(flat[0]!) as Val) : flat.slice(0, n);
      }
      case 'length': return [Math.hypot(...args[0]!)];
      case 'dot': return [args[0]!.reduce((s, x, i) => s + x * args[1]![i]!, 0)];
      case 'sqrt': return map1(Math.sqrt);
      case 'exp': return map1(Math.exp);
      case 'sin': return map1(Math.sin);
      case 'cos': return map1(Math.cos);
      case 'abs': return map1(Math.abs);
      case 'min': return broadcast(args[0]!, args[1]!, Math.min);
      case 'max': return broadcast(args[0]!, args[1]!, Math.max);
      case 'pow': return broadcast(args[0]!, args[1]!, Math.pow);
      case 'clamp':
        return broadcast(broadcast(args[0]!, args[1]!, Math.max), args[2]!, Math.min);
      case 'mix':
        return Array.from({ length: widest() }, (_, i) => {
          const [a, b, t] = [pick(args[0]!, i), pick(args[1]!, i), pick(args[2]!, i)];
          return a + (b - a) * t;
        });
      case 'smoothstep':
        return Array.from({ length: widest() }, (_, i) =>
          smoothstep1(pick(args[0]!, i), pick(args[1]!, i), pick(args[2]!, i)));
      case 'texture': return this.env.__texel!;
      default: {
        const fn = this.fns[name];
        if (!fn) throw new Error(`glslEval: unsupported function "${name}()"`);
        const bound = Object.fromEntries(fn.params.map((p, i) => [p, args[i]!]));
        return new Evaluator(this.fns, { ...this.env, ...bound }).expr(fn.body);
      }
    }
  }
}

/** Parse every `vecN name(args) { return expr; }` in the source (the FRAME_UV prelude). */
function parseFns(src: string): Record<string, Fn> {
  const fns: Record<string, Fn> = {};
  const re = /(?:float|vec[234])\s+(\w+)\s*\(([^)]*)\)\s*\{\s*return\s+([^;]+);\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    fns[m[1]!] = {
      params: m[2]!.split(',').map((p) => p.trim().split(/\s+/).pop()!).filter(Boolean),
      body: m[3]!,
    };
  }
  return fns;
}

/** The body of `void main(void) { ... }`, with its braces stripped. */
function mainBody(src: string): string {
  const i = src.indexOf('void main');
  if (i < 0) throw new Error('glslEval: no main()');
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(open + 1, j);
  }
  throw new Error('glslEval: unterminated main()');
}

/** Run a fragment shader's `main` and return every name it bound, uniforms included. */
export function evalGlsl(fragment: string, uniforms: Env): Env {
  const src = stripComments(fragment);
  // A sampler is not a value here — `texture()` ignores its first argument and returns the
  // injected `__texel` — but it is still an identifier the expression parser has to resolve.
  const env: Env = { uTexture: [0], ...uniforms };
  const ev = new Evaluator(parseFns(src), env);
  const body = mainBody(src);
  if (/\b(if|for|while|discard)\b/.test(body)) {
    throw new Error('glslEval: main() gained control flow — extend the evaluator, do not skip it');
  }
  for (const raw of body.split(';')) {
    const stmt = raw.trim();
    if (!stmt) continue;
    const decl = /^(?:const\s+)?(?:float|vec[234])\s+(\w+)\s*=\s*([\s\S]+)$/.exec(stmt);
    if (decl) {
      env[decl[1]!] = ev.expr(decl[2]!);
      continue;
    }
    const asg = /^(\w+)(?:\.(\w+))?\s*(\+=|-=|\*=|\/=|=)\s*([\s\S]+)$/.exec(stmt);
    if (!asg) throw new Error(`glslEval: unsupported statement "${stmt}"`);
    const [, name, swz, op, rhs] = asg;
    const value = ev.expr(rhs!);
    if (!swz) {
      if (op !== '=') throw new Error(`glslEval: "${op}" on a whole value is unsupported`);
      env[name!] = value;
      continue;
    }
    const target = env[name!];
    if (!target) throw new Error(`glslEval: "${name}" is not declared`);
    const next = [...target];
    [...swz].forEach((c, i) => {
      const at = SWIZZLE[c]!;
      const v = pick(value, i);
      next[at] = op === '=' ? v
        : op === '+=' ? next[at]! + v
        : op === '-=' ? next[at]! - v
        : op === '*=' ? next[at]! * v
        : next[at]! / v;
    });
    env[name!] = next;
  }
  return env;
}

// ---------------------------------------------------------------------------------------
// The oracle needs its own oracle: an evaluator that quietly mis-evaluates would make every
// measurement below agree with anything. These pin the pieces the shield shader leans on.
// ---------------------------------------------------------------------------------------

describe('glslEval (the evaluator these measurements depend on)', () => {
  const PROBE = `
    vec2 twice(vec2 v) { return v * 2.0; }
    void main(void)
    {
        vec2 a = twice(vec2(1.0, 2.0));
        float b = length(a);
        float c = smoothstep(0.0, 4.0, 1.0);
        float clamped = smoothstep(0.0, 1.0, -3.0);
        float d = pow(2.0, 3.0);
        float e = dot(a, vec2(1.0, 0.0));
        float f = -a.y + max(1.0, 0.5) * min(3.0, 2.0);
        vec4 col = vec4(0.0);
        col.rgb += vec3(0.25) * 2.0;
        col.a = max(col.a, 0.5);
        finalColor = col;
    }
  `;
  const out = (): Env => evalGlsl(PROBE, {});

  it('evaluates calls, swizzles, broadcasting and precedence', () => {
    const e = out();
    expect(e.a).toEqual([2, 4]); // user function + vec2 constructor
    expect(e.b![0]).toBeCloseTo(Math.hypot(2, 4), 12);
    expect(e.c![0]).toBeCloseTo(0.15625, 12); // 3t²-2t³ at t=0.25, NOT the linear 0.25
    expect(e.clamped![0]).toBe(0); // smoothstep clamps below its edge
    expect(e.d).toEqual([8]);
    expect(e.e).toEqual([2]);
    expect(e.f).toEqual([-2]); // unary minus binds tighter than +, and * tighter than both
  });

  it('writes through a swizzle without disturbing the other components', () => {
    expect(out().col).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(out().finalColor).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('refuses what it cannot evaluate rather than skipping it', () => {
    const wrap = (body: string): string => `void main(void) { ${body} }`;
    expect(() => evalGlsl(wrap('float a = nope(1.0);'), {})).toThrow(/unsupported function/);
    expect(() => evalGlsl(wrap('float a = missing;'), {})).toThrow(/undefined identifier/);
    expect(() => evalGlsl(wrap('if (a) { }'), {})).toThrow(/control flow/);
  });
});

// ---------------------------------------------------------------------------------------
// The shield itself.
// ---------------------------------------------------------------------------------------

/** Region size and pool-texture size in px. Unequal ON PURPOSE — `TexturePool` rounds up to a
 *  power of two, and a shader that treats `vTextureCoord` 0.5 as "the middle" is centred on
 *  the POOL's middle, not the region's. That is the crescent bug; every sample here is taken
 *  through the same mismatch, so a regression cannot hide behind a convenient fixture. */
const REGION = 130;
const POOL = 256;

interface SampleOpts {
  /** Distance in the shader's own `dist` units (0 at the centre). */
  dist: number;
  /** Radians; 0 is +x. The specular glint sits up and to the left, so a ray at 0 misses it. */
  angle?: number;
  /** The texel under this pixel: transparent background by default, or opaque body art. */
  texel?: Val;
  intensity?: number;
  time?: number;
  region?: number;
  pool?: number;
}

const filter = (): EnergyShieldFilter => new EnergyShieldFilter(0x66e0ff, 1);

/** Run the shipped shield shader at one point and hand back every intermediate it computed. */
function sample(f: EnergyShieldFilter, o: SampleOpts): Env {
  const region = o.region ?? REGION;
  const pool = o.pool ?? POOL;
  const uniforms = (f.resources.shieldUniforms as { uniforms: Record<string, unknown> }).uniforms;
  // `dist = length(uv) * sqrt(2)` over a uv that is region-space minus 0.5, so a target
  // `dist` is a region offset of dist / sqrt(2) in that direction.
  const r = o.dist / Math.SQRT2;
  const angle = o.angle ?? 0;
  const u = [0.5 + r * Math.cos(angle), 0.5 + r * Math.sin(angle)];
  return evalGlsl(f.glProgram.fragment!, {
    // frameUv() undoes exactly this, which is the point of routing through it.
    vTextureCoord: [(u[0]! * region) / pool, (u[1]! * region) / pool],
    uInputSize: [pool, pool, 1 / pool, 1 / pool],
    uOutputFrame: [0, 0, region, region],
    uInputClamp: [0, 0, region / pool, region / pool],
    uColor: uniforms.uColor as Val,
    uIntensity: [o.intensity ?? 1],
    uTime: [o.time ?? 0],
    __texel: o.texel ?? [0, 0, 0, 0],
  });
}

const glowAt = (f: EnergyShieldFilter, o: SampleOpts): number => sample(f, o).glow![0]!;
const alphaAt = (f: EnergyShieldFilter, o: SampleOpts): number => sample(f, o).finalColor![3]!;

/** The shader's declared outer-surface radius, read off the source rather than repeated. */
function shellR(f: EnergyShieldFilter): number {
  const m = /const float SHELL_R = ([0-9.]+);/.exec(stripComments(f.glProgram.fragment!));
  if (!m) throw new Error('shield shader no longer declares SHELL_R');
  return Number(m[1]);
}

/** `Actor` pins the filter area to a square `radiusPx * 3` per side, so `uv` spans 6 radii. */
const bodyRadii = (dist: number): number => (dist * 6) / Math.SQRT2;

describe('EnergyShieldFilter, measured: a shell encloses the character', () => {
  it('paints the CENTRE — the one thing a ring cannot do', () => {
    // The whole 2026-08-25 report in one assertion. Every version through 2026-08-24 computed
    // exactly 0 here: the band's inner `smoothstep` zeroed everything within 1.2 body radii,
    // so the character stood in a hole with a hoop around it.
    expect(glowAt(filter(), { dist: 0 })).toBeGreaterThan(0);
  });

  it('has no hole anywhere between the centre and the surface', () => {
    // Sampled along +x, away from the specular glint, so this is the shell's own profile.
    const f = filter();
    const R = shellR(f);
    const ray = (i: number): number => (i / 40) * R;
    const glass = Array.from({ length: 41 }, (_, i) => sample(f, { dist: ray(i) }).glass![0]!);
    for (let i = 1; i < glass.length; i++) {
      expect(glass[i]!).toBeGreaterThanOrEqual(glass[i - 1]!);
    }
    expect(glass[glass.length - 1]!).toBeGreaterThan(glass[0]! * 3); // and the limb dominates
  });

  it('ripples by a fraction of a percent as the shimmer crosses it, not by a hole', () => {
    // The composite is NOT quite monotonic: `sin(uTime * K + dist * 9.0)` bands radially, so
    // a ray outward crosses the wave and dips slightly (measured: 0.03% of peak, at the flat
    // interior where the fresnel term has not started climbing). That is the ripple the term
    // exists for. It is worth pinning as a MAGNITUDE, because the shape this suite is about
    // is the difference between a dip of a fraction of a percent and one of a hundred.
    const f = filter();
    const R = shellR(f);
    const profile = Array.from({ length: 81 }, (_, i) => glowAt(f, { dist: (i / 80) * R }));
    const peak = Math.max(...profile);
    const worstDip = Math.max(...profile.map((v, i) => (i === 0 ? 0 : profile[i - 1]! - v)));
    expect(worstDip).toBeLessThan(0.01 * peak);
  });

  it('peaks AT the surface and is gone past it', () => {
    const f = filter();
    const R = shellR(f);
    const at = (d: number): number => glowAt(f, { dist: d });
    expect(at(R)).toBeGreaterThan(at(R * 0.9));
    expect(at(R * 1.2)).toBe(0); // past the outer fade, nothing is painted at all
    expect(at(R * 1.02)).toBeGreaterThan(0); // ...but the fade itself is soft, not a hard cut
  });

  it('is a circle at every angle, not an ellipse', () => {
    // The behavioural form of "no `uv.y /= 0.62`". `glass` is sampled rather than `glow`
    // because the specular glint is deliberately NOT rotationally symmetric.
    const f = filter();
    const R = shellR(f);
    for (const d of [0.2 * R, 0.6 * R, 0.95 * R]) {
      const ring = Array.from({ length: 16 }, (_, i) =>
        sample(f, { dist: d, angle: (i / 16) * Math.PI * 2 }).glass![0]!);
      for (const v of ring) expect(v).toBeCloseTo(ring[0]!, 10);
    }
  });

  it('carries a glint that is off-centre, inside the surface, and brighter than the glass', () => {
    // A shell without one reads as a flat disc of colour. It has to sit on CLEAR shell, not on
    // the body (an additive glint over pale character art is invisible — measured on screen).
    const f = filter();
    const R = shellR(f);
    const ray = Array.from({ length: 40 }, (_, i) => ({
      d: ((i + 1) / 40) * R,
      spec: sample(f, { dist: ((i + 1) / 40) * R, angle: Math.PI * 1.25 }).spec![0]!,
    }));
    const peak = ray.reduce((a, b) => (b.spec > a.spec ? b : a));
    expect(peak.spec).toBeGreaterThan(0.3);
    expect(peak.d / R).toBeGreaterThan(0.35); // off-centre...
    expect(peak.d / R).toBeLessThan(0.85); // ...but well inside the surface
    expect(sample(f, { dist: 0 }).spec![0]!).toBeLessThan(peak.spec * 0.5); // not centred
  });

  it('encloses more than the body it wraps', () => {
    // `Actor`'s filter area is 6 body radii wide, so the surface has to sit outside 1.0 —
    // a shield drawn INSIDE the silhouette is a skin, not a shield — and outside the mounted
    // weapon's reach, which is what "全部包裹" asked for and 1.55 radii did not deliver.
    expect(bodyRadii(shellR(filter()))).toBeGreaterThan(1.7);
  });
});

describe('EnergyShieldFilter, measured: you can still see through it', () => {
  const BODY: Val = [0.8, 0.8, 0.85, 1]; // near-white shell art, opaque (design/13's rigs)

  it('washes the character far less than it tints the empty background', () => {
    // Undamped, the additive fill flattened the hero's face — the saturated blue eye came out
    // the same pale cyan as the shell around it (measured on screen, 2026-08-25).
    const f = filter();
    const d = 0.3 * shellR(f);
    const overArt = glowAt(f, { dist: d, texel: BODY });
    const overFloor = glowAt(f, { dist: d });
    expect(overArt).toBeLessThan(overFloor * 0.6);
    expect(overArt).toBeGreaterThan(0); // ...but the shell does still pass over the character
  });

  it('keeps the additive wash on the art below a tenth of a channel', () => {
    const f = filter();
    const R = shellR(f);
    const worst = Math.max(...Array.from({ length: 21 }, (_, i) =>
      Math.max(...sample(f, { dist: (i / 20) * R * 0.75, texel: BODY }).finalColor!.slice(0, 3))
      - 0.85));
    expect(worst).toBeLessThan(0.1);
  });

  it('leaves the ground under the shell mostly unpainted, at every instant of the pulse', () => {
    // The 2026-08-19 volume pass added the ground shadow; the ring it replaced blanketed the
    // floor with opaque cyan and ate it. The interior may TINT the floor, never hide it.
    //
    // Swept over a full shimmer period, not read at t=0: the breathing term also bands
    // radially, so any single instant is a lucky sample. A first version of this test read
    // t=0 only and passed with the `glow * 0.7` composite knob mutated to 1.0 — at that
    // radius the wave happened to be near its trough.
    const f = filter();
    const R = shellR(f);
    const period = (2 * Math.PI) / 0.0018;
    const worstAlpha = (dist: number): number =>
      Math.max(...Array.from({ length: 24 }, (_, i) =>
        alphaAt(f, { dist, time: (i / 24) * period })));
    // 0.6R is the flat interior — past it the limb's own ramp is already climbing, and a
    // bound drawn across both would be measuring the limb, not the glass.
    for (let i = 0; i <= 16; i++) {
      expect(worstAlpha((i / 16) * R * 0.6)).toBeLessThan(0.11);
    }
    expect(worstAlpha(R)).toBeLessThan(0.75); // even the limb, at its brightest, stays translucent
  });

  it('never touches a pixel the body already draws opaque', () => {
    // `color.a = max(color.a, …)` must be a no-op at alpha 1 — anything that RAISED it would
    // be writing past full opacity, and anything that lowered it would punch holes in the art.
    const f = filter();
    for (const k of [0, 0.5, 1.0]) {
      expect(alphaAt(f, { dist: k * shellR(f), texel: BODY })).toBe(1);
    }
  });
});

describe('EnergyShieldFilter, measured: it fades with the pool and breathes', () => {
  it('scales linearly with the shield ratio, and vanishes at zero', () => {
    const f = filter();
    const d = shellR(f) * 0.9;
    const full = glowAt(f, { dist: d, intensity: 1 });
    expect(glowAt(f, { dist: d, intensity: 0.5 })).toBeCloseTo(full * 0.5, 12);
    expect(glowAt(f, { dist: d, intensity: 0 })).toBe(0);
    expect(alphaAt(f, { dist: d, intensity: 0 })).toBe(0); // a drained pool paints NOTHING
  });

  it('breathes without ever dimming below half — measured over a full period', () => {
    // `filters.test.ts` asserts the shimmer CONSTANTS; this asserts what they produce, which
    // is the thing the 2026-08-17 report ("护盾的闪烁频率降低") was actually about.
    const f = filter();
    const d = shellR(f) * 0.9;
    const period = (2 * Math.PI) / 0.0018;
    const series = Array.from({ length: 96 }, (_, i) =>
      glowAt(f, { dist: d, time: (i / 96) * period }));
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    expect(hi).toBeGreaterThan(lo); // it does animate at all
    // `0.75 + 0.25 * sin(...)` swings between exactly half and full, so the trough sits AT the
    // limit rather than comfortably inside it — asserted as `>=` with the sampling slack that
    // implies, not as a strict `>`, which passes or fails on where the 96 samples happen to land.
    expect(lo).toBeGreaterThanOrEqual(0.5 * hi - 1e-9);
    expect(hi / lo).toBeLessThanOrEqual(2 + 1e-6);
  });

  it('takes a full pulse in seconds, not in frames', () => {
    const f = filter();
    const d = shellR(f) * 0.9;
    const at = (t: number): number => glowAt(f, { dist: d, time: t });
    // One 16 ms frame must move it imperceptibly — a strobe is exactly the opposite.
    expect(Math.abs(at(16) - at(0))).toBeLessThan(0.02 * at(0));
  });
});

describe('EnergyShieldFilter, measured: centred on the REGION, at any texture size', () => {
  // The long-running "shield renders as a partial crescent at some camera zooms" report. The
  // region's pixel size is `filterArea x zoom x resolution`, and the pool hands out the next
  // power of two, so the mismatch changes with zoom — which is why it read as zoom-specific.
  const POW2_CASES: Array<[number, number]> = [
    [128, 128], // exact fit: the only case a naive `vTextureCoord - 0.5` gets right
    [130, 256], // just past a boundary — `vTextureCoord` only ever reaches 0.508
    [200, 256],
    [257, 512],
  ];

  it.each(POW2_CASES)('centres the shell on the region (region %i in a %i texture)', (region, pool) => {
    const f = filter();
    const baseline = glowAt(f, { dist: 0, region: 128, pool: 128 });
    expect(glowAt(f, { dist: 0, region, pool })).toBeCloseTo(baseline, 12);
  });

  it.each(POW2_CASES)('keeps the shell symmetric about it (region %i in a %i texture)', (region, pool) => {
    const f = filter();
    const d = shellR(f) * 0.9;
    const left = sample(f, { dist: d, angle: Math.PI, region, pool }).glass![0]!;
    const right = sample(f, { dist: d, angle: 0, region, pool }).glass![0]!;
    expect(left).toBeCloseTo(right, 10); // a crescent is exactly this pair diverging
  });
});
