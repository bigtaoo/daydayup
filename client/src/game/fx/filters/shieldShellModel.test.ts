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
import { EnergyShieldFilter } from './shieldFx';

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
  const re = /\s*(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|[A-Za-z_]\w*|>=|<=|==|!=|\+=|-=|\*=|\/=|[-+*/(),.;=<>])/g;
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

/** The comparison operators the shield's cull guard needs. GLSL's are bool-valued; here they
 *  produce 1/0 so the rest of the numeric machinery is untouched. */
const COMPARE: Record<string, ((a: number, b: number) => boolean) | undefined> = {
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

/** Sampler identity. A sampler is not a value, but the expression parser still has to resolve
 *  the identifier, so each one is bound to a distinct number and `texture()` dispatches on it —
 *  the shield samples TWO (the actor's own frame and the membrane tile) and a model that
 *  returned the same texel for both would make the membrane untestable. */
const SAMPLER = { uTexture: 0, uScales: 1 } as const;

/**
 * A membrane-tile sampler, keyed off the coordinate the shader hands `texture()`.
 *
 * Without one, every `texture(uScales, ...)` call returns the same constant texel, which was
 * enough while nothing in the shader depended on WHERE it sampled — and is exactly wrong the
 * moment something does. The shatter's per-cell throw DISPLACES the lookup, so a fixed texel
 * would make a displacement of any size (including none at all) produce an identical result.
 * `evalGlsl`'s third argument supplies a tile with real spatial structure instead.
 */
type TileSampler = (uv: Val) => Val;

interface Fn { params: string[]; body: string }

class Evaluator {
  private toks: string[] = [];
  private at = 0;

  constructor(
    private readonly fns: Record<string, Fn>,
    private readonly env: Env,
    private readonly tile?: TileSampler,
  ) {}

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
      const prec = op === '*' || op === '/' ? 3
        : op === '+' || op === '-' ? 2
        : COMPARE[op ?? ''] ? 1
        : 0;
      if (prec === 0 || prec < minPrec) return left;
      this.take();
      const right = this.binary(prec + 1);
      const cmp = COMPARE[op!];
      left = cmp
        ? broadcast(left, right, (a, b) => (cmp(a, b) ? 1 : 0))
        : broadcast(left, right, (a, b) =>
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
      case 'step': return broadcast(args[0]!, args[1]!, (edge, x) => (x < edge ? 0 : 1));
      case 'texture':
        if (args[0]![0] === SAMPLER.uScales) {
          return this.tile ? this.tile(args[1]!) : (this.env.__scaleTexel ?? [0, 0, 0, 1]);
        }
        return this.env.__texel!;
      default: {
        const fn = this.fns[name];
        if (!fn) throw new Error(`glslEval: unsupported function "${name}()"`);
        const bound = Object.fromEntries(fn.params.map((p, i) => [p, args[i]!]));
        return new Evaluator(this.fns, { ...this.env, ...bound }, this.tile).expr(fn.body);
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

/** Index of the `)` / `}` matching the opener at `from`. */
function matching(src: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return i;
  }
  throw new Error(`glslEval: unterminated "${open}"`);
}

/**
 * Split a block into top-level statements. `;` inside a nested block does not separate, so an
 * `if (...) { ... }` comes back whole.
 */
function statements(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')') depth--;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        out.push(body.slice(start, i + 1));
        start = i + 1;
      }
    } else if (c === ';' && depth === 0) {
      out.push(body.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (body.slice(start).trim()) throw new Error(`glslEval: dangling "${body.slice(start).trim()}"`);
  return out.map((t) => t.trim()).filter(Boolean);
}

/**
 * Execute one block against `env`, which it mutates. Returns true if the block hit a `return`,
 * so an enclosing block stops too.
 *
 * `if` is supported (2026-08-26) because the shield shader gained a real one: a radial cull that
 * skips the ~70% of the filtered square the shell does not reach. That guard is a PERFORMANCE
 * device whose correctness claim — "nothing visible is being skipped" — is exactly the sort of
 * thing this file exists to measure, so evaluating around it was never an option.
 */
function runBlock(body: string, env: Env, fns: Record<string, Fn>, tile?: TileSampler): boolean {
  const ev = new Evaluator(fns, env, tile);
  for (const stmt of statements(body)) {
    if (stmt === 'return;') return true;
    if (stmt.startsWith('if')) {
      const openParen = stmt.indexOf('(');
      if (openParen < 0) throw new Error(`glslEval: "if" without a condition in "${stmt}"`);
      const closeParen = matching(stmt, openParen, '(', ')');
      const openBrace = stmt.indexOf('{', closeParen);
      // No `else`, and nothing between the condition and the block. Both would evaluate to
      // something plausible if waved through, which is the failure mode this file cannot afford.
      if (openBrace < 0) throw new Error(`glslEval: "if" without a block in "${stmt}"`);
      if (stmt.slice(closeParen + 1, openBrace).trim()) {
        throw new Error(`glslEval: unsupported "if" form "${stmt}"`);
      }
      if (stmt.slice(matching(stmt, openBrace, '{', '}') + 1).trim()) {
        throw new Error(`glslEval: trailing clause (an "else"?) in "${stmt}"`);
      }
      const cond = ev.expr(stmt.slice(openParen + 1, closeParen));
      if (cond[0]) {
        if (runBlock(stmt.slice(openBrace + 1, matching(stmt, openBrace, '{', '}')), env, fns, tile)) return true;
      }
      continue;
    }
    const bare = stmt.replace(/;$/, '').trim();
    if (!bare) continue;
    const decl = /^(?:const\s+)?(?:float|vec[234])\s+(\w+)\s*=\s*([\s\S]+)$/.exec(bare);
    if (decl) {
      env[decl[1]!] = ev.expr(decl[2]!);
      continue;
    }
    const asg = /^(\w+)(?:\.(\w+))?\s*(\+=|-=|\*=|\/=|=)\s*([\s\S]+)$/.exec(bare);
    if (!asg) throw new Error(`glslEval: unsupported statement "${bare}"`);
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
  return false;
}

/** Run a fragment shader's `main` and return every name it bound, uniforms included. */
export function evalGlsl(fragment: string, uniforms: Env, tile?: TileSampler): Env {
  const src = stripComments(fragment);
  // A sampler is not a value here, but it is still an identifier the expression parser has to
  // resolve; `texture()` dispatches on the number each one is bound to.
  const env: Env = { uTexture: [SAMPLER.uTexture], uScales: [SAMPLER.uScales], ...uniforms };
  const body = mainBody(src);
  // `if` is now executed (see runBlock). Loops and `discard` still are not, and a shader that
  // grows one must fail here loudly rather than be silently half-evaluated.
  if (/(^|[^A-Za-z_])(for|while|discard|else)([^A-Za-z0-9_]|$)/.test(body)) {
    throw new Error('glslEval: main() gained control flow — extend the evaluator, do not skip it');
  }
  runBlock(body, env, parseFns(src), tile);
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
    expect(() => evalGlsl(wrap('for (;;) { }'), {})).toThrow(/control flow/);
    expect(() => evalGlsl(wrap('discard;'), {})).toThrow(/control flow/);
    // An `if` IS executed now (the shield's radial cull), but only in the one form the shader
    // uses. Anything richer has to fail rather than be half-run.
    expect(() => evalGlsl(wrap('if (1.0 > 0.0) { } else { }'), {})).toThrow(/control flow/);
  });

  it('executes a guard-return, and only the branch that was taken', () => {
    const wrap = (body: string): string => `void main(void) { ${body} }`;
    const taken = evalGlsl(wrap('float a = 1.0; if (a > 0.5) { float b = 7.0; return; } float c = 9.0;'), {});
    expect(taken.b).toEqual([7]);
    expect(taken.c).toBeUndefined(); // the `return` really stopped the block
    const skipped = evalGlsl(wrap('float a = 0.0; if (a > 0.5) { float b = 7.0; return; } float c = 9.0;'), {});
    expect(skipped.b).toBeUndefined();
    expect(skipped.c).toEqual([9]);
  });

  it('evaluates every comparison the guard form can use', () => {
    const wrap = (body: string): string => `void main(void) { ${body} }`;
    const cases: Array<[string, number]> = [
      ['2.0 > 1.0', 1], ['1.0 > 2.0', 0], ['1.0 < 2.0', 1],
      ['2.0 >= 2.0', 1], ['2.0 <= 1.0', 0], ['2.0 == 2.0', 1], ['2.0 != 2.0', 0],
    ];
    for (const [src, want] of cases) {
      expect(evalGlsl(wrap(`float a = 0.0; if (${src}) { a = 1.0; }`), {}).a).toEqual([want]);
    }
  });

  it('hands a positional sampler the coordinate the shader actually sampled', () => {
    // The default sampler answers every uScales lookup with one constant, which is fine until
    // something in the shader depends on WHERE it samples. The shatter's per-cell throw does,
    // so this is the extension it needed — and a sampler that ignored its argument would make
    // a displacement of any size, including none, measure identically.
    const PROBE = `
      void main(void)
      {
          vec4 a = texture(uScales, vec2(0.25, 0.75));
          vec4 b = texture(uScales, vec2(0.5, 0.5));
          finalColor = a + b;
      }
    `;
    const seen: number[][] = [];
    const e = evalGlsl(PROBE, {}, (uv) => {
      seen.push([...uv]);
      return [uv[0]!, uv[1]!, 0, 1];
    });
    expect(seen).toEqual([[0.25, 0.75], [0.5, 0.5]]);
    expect(e.a).toEqual([0.25, 0.75, 0, 1]);
    expect(e.b).toEqual([0.5, 0.5, 0, 1]);
    // ...and the other sampler is untouched by it.
    expect(evalGlsl('void main(void) { vec4 a = texture(uTexture, vec2(0.1)); finalColor = a; }',
      { __texel: [1, 2, 3, 4] }, () => [9, 9, 9, 9]).a).toEqual([1, 2, 3, 4]);
  });

  it('keeps comparison BELOW arithmetic, so `a + b > c` is not `a + (b > c)`', () => {
    const wrap = (body: string): string => `void main(void) { ${body} }`;
    expect(evalGlsl(wrap('float a = 0.0; if (1.0 + 1.0 > 1.5) { a = 1.0; }'), {}).a).toEqual([1]);
    expect(evalGlsl(wrap('float a = 0.0; if (1.0 + 1.0 > 2.5) { a = 1.0; }'), {}).a).toEqual([0]);
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
  /** What the membrane tile reads at this pixel: `r` the scale field, `g` the cell constant.
   *  Defaults to the tile's own mid-grey with a mid-range cell id. The evaluator has no image,
   *  so this is a PARAMETER the tests sweep — the tile's own properties (seamlessness, range,
   *  cell count) are measured from its bytes in `shieldScales.test.ts` instead. */
  scaleTexel?: Val;
  intensity?: number;
  time?: number;
  /** Milliseconds since the last impact, and the direction it came from. */
  hitAge?: number;
  hitDir?: [number, number];
  membrane?: number;
  /** The shell's exit progress, 0 (intact, the rest value) .. 1 (gone). */
  shatter?: number;
  /** A membrane tile with real spatial structure, for the measurements that depend on WHERE the
   *  shader samples it rather than on what it reads. Overrides `scaleTexel` when present. */
  tile?: (uv: Val) => Val;
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
  const dir = o.hitDir ?? [0, -1];
  return evalGlsl(f.glProgram.fragment!, {
    // frameUv() undoes exactly this, which is the point of routing through it.
    vTextureCoord: [(u[0]! * region) / pool, (u[1]! * region) / pool],
    uInputSize: [pool, pool, 1 / pool, 1 / pool],
    uOutputFrame: [0, 0, region, region],
    uInputClamp: [0, 0, region / pool, region / pool],
    uColor: uniforms.uColor as Val,
    uIntensity: [o.intensity ?? 1],
    uTime: [o.time ?? 0],
    uMembrane: [o.membrane ?? 1],
    uHit: [dir[0], dir[1], o.hitAge ?? HIT_SETTLED()],
    // Defaults to the FILTER's own uniform, not to a literal 0. Every measurement below can
    // then be driven either through the harness or through the real `shatter` property, and a
    // setter that dropped its argument stops being invisible here.
    uShatter: [o.shatter ?? f.shatter],
    __texel: o.texel ?? [0, 0, 0, 0],
    __scaleTexel: o.scaleTexel ?? [0.45, 0.5, 0, 1],
  }, o.tile);
}

/** Matches `HIT_SETTLED_MS` in the filter — read off a filter that has never been hit rather
 *  than repeated, so the two cannot drift. Lazy, because constructing a filter needs the
 *  `document` stub that `beforeAll` installs, and module scope runs before it. */
let settled = -1;
const HIT_SETTLED = (): number => {
  if (settled < 0) settled = new EnergyShieldFilter().hitAge;
  return settled;
};

/** Total light this pixel adds, front hemisphere plus the occluded back one. Zero where the
 *  radial cull fired — neither name is bound on that path, and "the shader returned early" and
 *  "the shader added no light" are the same statement, which is the claim the cull suite
 *  measures separately. */
const glowAt = (f: EnergyShieldFilter, o: SampleOpts): number => {
  const s = sample(f, o);
  return (s.glow?.[0] ?? 0) + (s.behind?.[0] ?? 0);
};
const alphaAt = (f: EnergyShieldFilter, o: SampleOpts): number => sample(f, o).finalColor![3]!;

/** The shader's declared outer-surface radius, read off the source rather than repeated. */
function shellR(f: EnergyShieldFilter): number {
  const m = /const float SHELL_R = ([0-9.]+);/.exec(stripComments(f.glProgram.fragment!));
  if (!m) throw new Error('shield shader no longer declares SHELL_R');
  return Number(m[1]);
}

/** The wall thickness, as a fraction of `SHELL_R`, likewise read off the source. */
function thickness(f: EnergyShieldFilter): number {
  const m = /const float THICKNESS = ([0-9.]+);/.exec(stripComments(f.glProgram.fragment!));
  if (!m) throw new Error('shield shader no longer declares THICKNESS');
  return Number(m[1]);
}

/** `Actor` pins the filter area to a square `radiusPx * 3` per side, so `uv` spans 6 radii. */
const bodyRadii = (dist: number): number => (dist * 6) / Math.SQRT2;

// ---------------------------------------------------------------------------------------
// 2026-08-26. The rewrite these were re-measured for, and the report that forced it:
// *"没有被蛋壳包裹的感觉 … 边缘的那个圈太过实线了"*.
//
// The previous shape was `pow(1.0 - nz, 3.0)` over a flat `FILL` plate. Every assertion in the
// old version of this file passed against it, because they asked "is the middle painted?" and
// "is the limb brighter?" — both true of a plate with a hard bright ring around it. The
// property they never asked for is the one that was missing: WIDTH. A shell whose brightness
// is a function that only reaches its maximum AT the silhouette is a line, however solid the
// disc behind it. So these measure the radial profile's shape, not just its endpoints.
// ---------------------------------------------------------------------------------------

describe('EnergyShieldFilter, measured: the wall has thickness', () => {
  /** The radial profile, sampled at `n` points from the centre out to `to` x SHELL_R. */
  function profile(f: EnergyShieldFilter, n = 60, to = 1.25): Array<{ b: number; glow: number }> {
    const R = shellR(f);
    return Array.from({ length: n + 1 }, (_, i) => {
      const b = (i / n) * to;
      return { b, glow: glowAt(f, { dist: b * R }) };
    });
  }

  it('peaks the WALL at the inner surface — where the chord stops being occluded', () => {
    // The wall term alone, not the composite: `halo` is a separate soft bloom centred on the
    // outer surface, and the two together deliberately produce a flat top rather than a spike
    // (the next test measures that). `pow(1 - nz, k)`, the shape this replaced, peaks at b = 1
    // exactly — a chord through a shell of real thickness peaks at b = 1 - THICKNESS.
    const f = filter();
    const R = shellR(f);
    const at = (b: number): number => sample(f, { dist: b * R }).density![0]!;
    const peak = Array.from({ length: 61 }, (_, i) => i / 60)
      .reduce((a, b) => (at(b) > at(a) ? b : a));
    const inner = 1 - thickness(f);
    expect(peak).toBeGreaterThan(inner - 0.05);
    expect(peak).toBeLessThan(inner + 0.05);
  });

  it('puts the composite maximum well inside the silhouette, not on it', () => {
    const f = filter();
    const peak = profile(f).reduce((a, c) => (c.glow > a.glow ? c : a));
    expect(peak.b).toBeLessThan(0.95); // the old shape's maximum sat at b >= 1
    expect(peak.b).toBeGreaterThan(0.6);
  });

  it('is bright across a WIDE band, not a rim — the "边缘的那个圈太过实线" complaint', () => {
    // The width, in units of the surface radius, over which the profile stays above half its
    // peak. The old shader (fresnel^3, cut off with a 0.045 smoothstep) held that for ~0.10 of
    // the radius. Anything under ~0.2 is a line again however it is written.
    const f = filter();
    const p = profile(f, 200);
    const peak = Math.max(...p.map((s) => s.glow));
    const above = p.filter((s) => s.glow >= peak * 0.5);
    const width = Math.max(...above.map((s) => s.b)) - Math.min(...above.map((s) => s.b));
    // 0.25 of the surface radius. Measured on the shader this replaced: 0.08.
    expect(width).toBeGreaterThan(0.25);
  });

  it('never rises monotonically to the edge — it comes back down before the silhouette', () => {
    // The single clearest statement of "not a ring": there is a maximum strictly inside the
    // surface, and the profile is falling by the time it reaches it.
    const f = filter();
    const R = shellR(f);
    expect(glowAt(f, { dist: 0.995 * R })).toBeLessThan(glowAt(f, { dist: (1 - thickness(f)) * R }));
  });

  it('paints the CENTRE — the one thing a ring cannot do', () => {
    const f = filter();
    expect(glowAt(f, { dist: 0 })).toBeGreaterThan(0.05);
  });

  it('has no hole anywhere between the centre and the surface', () => {
    const f = filter();
    const R = shellR(f);
    for (let i = 0; i <= 40; i++) {
      expect(glowAt(f, { dist: (i / 40) * R * 0.98 })).toBeGreaterThan(0.05);
    }
  });

  it('tracks THICKNESS: a thinner declared wall puts the peak further out', () => {
    // Not a second copy of the formula — it re-reads the shipped constant and checks the shape
    // it produces is the one that constant means. A wall term that ignored THICKNESS would
    // still pass every "is it wide" assertion above with a hand-tuned gradient.
    const f = filter();
    const t = thickness(f);
    expect(t).toBeGreaterThan(0.05); // a real wall
    expect(t).toBeLessThan(0.6); // ...not a filled ball, which has no limb at all
    const R = shellR(f);
    const atInner = glowAt(f, { dist: (1 - t) * R });
    const atCentre = glowAt(f, { dist: 0 });
    expect(atInner).toBeGreaterThan(atCentre * 1.5); // the wall is genuinely brighter than the fill
  });

  it('spends the wall term BEFORE the silhouette, so the visible edge is the halo', () => {
    // The anti-hairline property, stated on the term that can produce one. `nz` has an infinite
    // slope at b = 1, so a wall that is still carrying real brightness when it gets there falls
    // off across about half a screen pixel. What stops that is the feather starting well inside
    // (`inside`), and this is the assertion that measures it: by the silhouette the chord has to
    // be all but gone, leaving the smooth halo to draw the edge.
    const f = filter();
    const R = shellR(f);
    const at = (b: number): number => sample(f, { dist: b * R }).density![0]!;
    const peak = at(1 - thickness(f));
    expect(at(0.99)).toBeLessThan(peak * 0.08);
    expect(at(0.9)).toBeGreaterThan(peak * 0.4); // ...but not so early that the wall loses its body
  });

  it('tapers past the surface instead of stopping at it', () => {
    // A hard cutoff at the surface is what draws an outline. The halo has to carry the profile
    // down continuously — no step between the last pixel inside and the first outside.
    const f = filter();
    const R = shellR(f);
    const justIn = glowAt(f, { dist: 0.999 * R });
    const justOut = glowAt(f, { dist: 1.001 * R });
    expect(Math.abs(justIn - justOut)).toBeLessThan(0.03);
    expect(justOut).toBeGreaterThan(0); // ...and there IS something out there to taper
    expect(glowAt(f, { dist: 1.1 * R })).toBeLessThan(justOut);
  });

  it('is a circle at every angle, not an ellipse', () => {
    // A shield is a SPHERE around the body, whose silhouette is a circle from every angle —
    // unlike the ground shadow and the status auras, which are flat discs ON the ground plane
    // and do foreshorten. Squashing this one (2026-08-18, reverted 2026-08-24) read on screen
    // as a flat hoop threaded through the character at gun height.
    const f = filter();
    const d = shellR(f) * (1 - thickness(f));
    // Away from the specular glint, which is deliberately off-centre and would break symmetry.
    const at = (angle: number): number => sample(f, { dist: d, angle }).density![0]!;
    const ref = at(0);
    // 7 places, not 10: the region/pool remap puts a different rounding on each angle, and
    // 1e-8 of disagreement is that, not a crescent (which diverges by whole percent).
    for (let i = 1; i < 12; i++) expect(at((i / 12) * Math.PI * 2)).toBeCloseTo(ref, 7);
  });

  it('encloses more than the body it wraps', () => {
    const f = filter();
    expect(bodyRadii(shellR(f))).toBeGreaterThan(1.7);
    expect(bodyRadii(shellR(f))).toBeLessThan(2.1);
  });

  it('carries a glint that is off-centre, inside the surface, and brighter than the glass', () => {
    const f = filter();
    const R = shellR(f);
    // The glint sits up and to the left; screen y points down, so that is angle ~ -3pi/4.
    const lit = sample(f, { dist: R * 0.42, angle: (-3 * Math.PI) / 4 }).spec![0]!;
    const opposite = sample(f, { dist: R * 0.42, angle: Math.PI / 4 }).spec![0]!;
    expect(lit).toBeGreaterThan(opposite * 10);
    expect(lit).toBeGreaterThan(sample(f, { dist: R * 0.42 }).density![0]!);
    expect(sample(f, { dist: R * 1.3 }).finalColor).toBeDefined(); // culled path still writes a colour
  });
});

// ---------------------------------------------------------------------------------------
// The other half of the same report — *"没有被蛋壳包裹的感觉"*. Shape alone never produced it,
// because every version painted the whole shell ON TOP of the character. What makes a body
// read as enclosed is that part of the shell is BEHIND it.
// ---------------------------------------------------------------------------------------

describe('EnergyShieldFilter, measured: the character is inside it', () => {
  const BODY: Val = [0.8, 0.8, 0.85, 1]; // near-white shell art, opaque (design/13's rigs)

  it('puts the back hemisphere BEHIND the body — occluded exactly by the body alpha', () => {
    const f = filter();
    const d = shellR(f) * 0.35;
    const overFloor = sample(f, { dist: d }).behind![0]!;
    const overBody = sample(f, { dist: d, texel: BODY }).behind![0]!;
    // A real SHARE of the light, not a trace of it. `> 0` passed with the back hemisphere
    // multiplied out entirely (the impact term leaves a denormal behind at rest), which is the
    // one mutant this whole rewrite is about — found by the 2026-08-26 battery, not by review.
    expect(overFloor).toBeGreaterThan(sample(f, { dist: d }).glow![0]! * 0.3);
    expect(overBody).toBe(0); // fully occluded by an opaque body — this is the whole cue
    const half = sample(f, { dist: d, texel: [0.8, 0.8, 0.85, 0.5] }).behind![0]!;
    expect(half).toBeCloseTo(overFloor * 0.5, 10); // ...and it is linear in between
  });

  it('leaves the FRONT hemisphere unoccluded, so the body is sandwiched', () => {
    // If both halves were occluded the shell would vanish over the character; if neither were,
    // it would all be in front and the character would be pasted on top of a decal again.
    const f = filter();
    const d = shellR(f) * 0.35;
    expect(sample(f, { dist: d, texel: BODY }).glow![0]!)
      .toBeCloseTo(sample(f, { dist: d }).glow![0]!, 10);
  });

  it('refracts: the sample point is displaced, inward and by more toward the limb', () => {
    // The evaluator has no image, so what is measured is the DISPLACEMENT the shader computes —
    // its direction and how it grows with the grazing angle. A shell that sampled straight
    // through would read as a decal however well lit.
    const f = filter();
    const R = shellR(f);
    const near = sample(f, { dist: R * 0.3 }).bend as number[];
    const far = sample(f, { dist: R * 0.9 }).bend as number[];
    const mag = (v: number[]): number => Math.hypot(v[0]!, v[1]!);
    expect(mag(near)).toBeGreaterThan(0);
    // Faster than linearly in the radius, which is what `1 - nz` buys and what a plain `uv`
    // scaling does not: a bend proportional to the radius alone reaches only ~3x here, and is a
    // uniform magnification rather than a sphere.
    expect(mag(far)).toBeGreaterThan(mag(near) * 10);
    expect(near[0]).toBeLessThan(0); // sampled at angle 0, i.e. +x — the bend points back inward
    expect(sample(f, { dist: R * 1.3 }).bend).toBeUndefined(); // culled before it is computed
  });

  it('never bends a sample outside the filtered region', () => {
    // `clampToFrame` exists because the pooled texture beyond the region holds whatever the LAST
    // filter to borrow that pool entry left there — not transparent black. Relying on the clamp
    // to save us would mean smearing the region's edge texel around the shell's limb; the
    // displacement has to be small enough that the clamp never actually fires. Swept over the
    // whole disc, and with an impact live, since that adds a second term.
    const f = filter();
    const R = shellR(f);
    for (let i = 0; i <= 16; i++) {
      for (let k = 0; k < 12; k++) {
        const o = { dist: (i / 16) * R * 1.1, angle: (k / 12) * Math.PI * 2, hitAge: 0, hitDir: [1, 0] as [number, number] };
        const s = sample(f, o);
        if (!s.bend) continue; // culled — no sample taken at all
        const at = [s.vTextureCoord![0]! + s.bend[0]!, s.vTextureCoord![1]! + s.bend[1]!];
        expect(at[0]!).toBeGreaterThanOrEqual(s.uInputClamp![0]!);
        expect(at[1]!).toBeGreaterThanOrEqual(s.uInputClamp![1]!);
        expect(at[0]!).toBeLessThanOrEqual(s.uInputClamp![2]!);
        expect(at[1]!).toBeLessThanOrEqual(s.uInputClamp![3]!);
      }
    }
  });

  it('bends by a fraction of a body radius — the character stays recognisable', () => {
    // The growth test above is a RATIO, so it is scale-free: a bend ten times too strong passes
    // it unchanged (2026-08-26 battery, the one survivor of the second pass). And the clamp
    // sweep does not catch it either, because the shell only reaches 62% of the region's
    // half-width — there is enough margin that a grotesque displacement is still "inside".
    // So the magnitude needs its own bound, in the unit that means something.
    const f = filter();
    const R = shellR(f);
    let worst = 0;
    for (let i = 0; i <= 40; i++) {
      for (let k = 0; k < 8; k++) {
        const s = sample(f, { dist: (i / 40) * R * 1.05, angle: (k / 8) * Math.PI * 2 });
        if (!s.bend) continue;
        // `bend` is in texcoord space; `frameOffset`'s inverse puts it back in region units, and
        // the region spans 6 body radii.
        const region = Math.hypot(s.bend[0]! / (s.uOutputFrame![2]! * s.uInputSize![2]!),
          s.bend[1]! / (s.uOutputFrame![3]! * s.uInputSize![3]!));
        worst = Math.max(worst, region * 6);
      }
    }
    expect(worst).toBeGreaterThan(0.05); // there IS refraction
    expect(worst).toBeLessThan(0.4); // ...and it is a lens, not a smear
  });

  it('fades the refraction with the pool, so nothing un-warps in one frame at the break', () => {
    // `ActorFilters` detaches the shell the instant the pool hits 0. Anything still at full
    // strength at that moment pops. The glow already scaled with `uIntensity`; the bend did not.
    const f = filter();
    const d = shellR(f) * 0.7;
    const mag = (v: number[]): number => Math.hypot(v[0]!, v[1]!);
    const full = mag(sample(f, { dist: d }).bend as number[]);
    const dying = mag(sample(f, { dist: d, intensity: 0.05 }).bend as number[]);
    expect(dying).toBeLessThan(full * 0.1);
    expect(mag(sample(f, { dist: d, intensity: 0 }).bend as number[])).toBe(0);
  });

  it('tints the art it covers instead of only glowing over it — glass with substance', () => {
    // Isolated from the additive glow, which dominates the raw channel value and would hide
    // this either way: what is measured is the gap between the shipped result and what a
    // PURELY additive shell would have produced from the same glow.
    const f = filter();
    const d = shellR(f) * 0.5;
    const s = sample(f, { dist: d, texel: BODY });
    const lit = s.glow![0]! + s.behind![0]!;
    const additiveOnly = BODY[0]! + (s.tint as number[])[0]! * lit;
    expect(s.finalColor![0]!).toBeLessThan(additiveOnly);
    // ...but not by so much that the art stops reading. This is the number the 2026-08-25 pass
    // was about (the hero's saturated blue eye flattening to the same pale cyan as the shell).
    expect(additiveOnly - s.finalColor![0]!).toBeLessThan(0.1);
  });

  it('never punches a hole in the art it covers', () => {
    const f = filter();
    for (const k of [0, 0.5, 1.0]) {
      expect(alphaAt(f, { dist: k * shellR(f), texel: BODY })).toBe(1);
    }
  });

  it('leaves the ground under the shell readable, at every instant of the pulse', () => {
    // The 2026-08-19 volume pass added the ground shadow; the shell has to tint the floor
    // around a shielded actor's feet, never hide it. `Entity`'s SHADOW_ALPHA_INNER is 0.1, so a
    // shell interior above that composites more strongly than the shadow it sits over and the
    // actor stops reading as planted. The 2026-08-26 rewrite paints the BACK hemisphere over
    // the floor as well as the front, i.e. it puts more light there for the same shape — the
    // interior stays under the same bound anyway, via the contrast curve on `density`, rather
    // than by relaxing the bound to fit.
    //
    // Swept over a full breath, not read at t=0: any single instant is a lucky sample.
    const f = filter();
    const R = shellR(f);
    const period = (2 * Math.PI) / 0.0018;
    const worst = (dist: number): number =>
      Math.max(...Array.from({ length: 24 }, (_, i) => alphaAt(f, { dist, time: (i / 24) * period })));
    for (let i = 0; i <= 16; i++) expect(worst((i / 16) * R * 0.6)).toBeLessThan(0.11);
    expect(worst(R * (1 - thickness(f)))).toBeLessThan(0.5); // even the wall stays translucent
  });
});

// ---------------------------------------------------------------------------------------
// The cull. A performance device whose entire correctness claim is "nothing visible is being
// skipped", which is a measurement, not a comment.
// ---------------------------------------------------------------------------------------

describe('EnergyShieldFilter, measured: the radial cull skips nothing visible', () => {
  /** The cull radius, in units of the surface, as the shader declares it. */
  function cull(f: EnergyShieldFilter): number {
    const m = /const float CULL = ([0-9.]+);/.exec(stripComments(f.glProgram.fragment!));
    if (!m) throw new Error('shield shader no longer declares CULL');
    return Number(m[1]);
  }

  it('is already below one 8-bit step by the time it culls', () => {
    // Sampled just INSIDE the cull, where the shader still runs: if what it computes there is
    // under 1/255 in both colour and alpha, dropping it beyond that point is invisible.
    const f = filter();
    const b = cull(f) * 0.999;
    const s = sample(f, { dist: b * shellR(f) });
    expect(s.glow![0]! + s.behind![0]!).toBeLessThan(1 / 255);
    expect(s.finalColor![3]!).toBeLessThan(1 / 255);
  });

  it('culls only OUTSIDE the surface, never into the shell', () => {
    expect(cull(filter())).toBeGreaterThan(1);
  });

  it('hands back the untouched texel where it culls', () => {
    const f = filter();
    const texel: Val = [0.3, 0.4, 0.5, 0.6];
    expect(sample(f, { dist: cull(f) * 1.2 * shellR(f), texel }).finalColor).toEqual(texel);
  });

  it('is STILL below one 8-bit step at every instant of the exit', () => {
    // The exit expands the shell, which is exactly the change that would push light past a
    // fixed cull radius — the argument that it does not (the expansion goes into `surface`, and
    // `b` is measured in surfaces, so the cull grows with the shell) is an argument. This is the
    // measurement. Sampled just inside the cull at each instant, against that instant's own
    // surface rather than a remembered one.
    const f = filter();
    const surfaceAt = (shatter: number): number => sample(f, { dist: 0.01, shatter }).surface![0]!;
    for (let i = 0; i <= 20; i++) {
      const shatter = i / 20;
      const s = sample(f, { dist: cull(f) * 0.999 * surfaceAt(shatter), shatter });
      expect(s.glow![0]! + s.behind![0]!).toBeLessThan(1 / 255);
      expect(s.finalColor![3]!).toBeLessThan(1 / 255);
    }
  });

  it('is worth having: it skips well over half the filtered square', () => {
    // The shell reaches SHELL_R in `dist` units over a region whose half-width is 0.5 * sqrt(2)
    // in the same units, so the fraction of the square the shader still runs for is the area of
    // a circle of radius CULL * SHELL_R / (0.5 * sqrt(2)) inscribed in it.
    const f = filter();
    const rel = (cull(f) * shellR(f)) / (0.5 * Math.SQRT2);
    const covered = (Math.PI * rel * rel) / 4;
    expect(covered).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------------------
// The impact. Nothing here existed before 2026-08-26 — the shield's only dynamic was the pool.
// ---------------------------------------------------------------------------------------

describe('EnergyShieldFilter, measured: it reacts to being hit', () => {
  const DIR: [number, number] = [1, 0]; // hit arriving from -x, landing on the -x side

  it('dents the struck side and bulges the far one', () => {
    const f = filter();
    const struck = sample(f, { dist: 0.1, angle: Math.PI, hitAge: 0, hitDir: DIR }).surface![0]!;
    const far = sample(f, { dist: 0.1, angle: 0, hitAge: 0, hitDir: DIR }).surface![0]!;
    const rest = sample(f, { dist: 0.1, angle: Math.PI }).surface![0]!;
    expect(struck).toBeLessThan(rest); // pushed in where it was hit
    expect(far).toBeGreaterThan(rest); // ...and out on the far side
  });

  it('REBOUNDS past rest rather than fading back — the thing a squash frame does', () => {
    // A damped exponential alone would return monotonically to the rest radius, which reads as
    // "the glow faded". The cosine is what makes it spring back through it. Measured as a sign
    // change in the offset from rest, not as a formula.
    const f = filter();
    const at = (age: number): number =>
      sample(f, { dist: 0.1, angle: Math.PI, hitAge: age, hitDir: DIR }).surface![0]!
      - sample(f, { dist: 0.1, angle: Math.PI }).surface![0]!;
    const trace = Array.from({ length: 60 }, (_, i) => at(i * 10));
    expect(trace[0]!).toBeLessThan(0); // dented first
    expect(Math.max(...trace)).toBeGreaterThan(0); // then past rest, the other way
    expect(Math.abs(trace[59]!)).toBeLessThan(Math.abs(trace[0]!) * 0.1); // and settles
  });

  it('settles completely, so a shield that was hit long ago is an unperturbed sphere', () => {
    const f = filter();
    const hit = sample(f, { dist: 0.1, hitAge: HIT_SETTLED(), hitDir: DIR }).surface![0]!;
    const never = sample(f, { dist: 0.1 }).surface![0]!;
    expect(hit).toBeCloseTo(never, 6);
  });

  it('blooms on the struck hemisphere and not the far one', () => {
    const f = filter();
    const d = shellR(f) * 0.6;
    const near = sample(f, { dist: d, angle: Math.PI, hitAge: 0, hitDir: DIR }).impact![0]!;
    const far = sample(f, { dist: d, angle: 0, hitAge: 0, hitDir: DIR }).impact![0]!;
    expect(near).toBeGreaterThan(far * 5);
  });

  it('sends a ripple ACROSS the surface — the crest moves outward from the impact', () => {
    // A pulse that merely decayed in place would brighten and dim the same annulus. This
    // asserts travel: the angle at which the ripple crests is further from the impact point
    // later than it was earlier.
    const f = filter();
    const d = shellR(f) * 0.5;
    const crest = (age: number): number => {
      let best = -Infinity;
      let at = 0;
      for (let i = 0; i <= 40; i++) {
        const angle = Math.PI - (i / 40) * Math.PI; // from the impact point round to the far side
        const v = sample(f, { dist: d, angle, hitAge: age, hitDir: DIR }).ripple![0]!;
        if (v > best) {
          best = v;
          at = i / 40;
        }
      }
      return at;
    };
    expect(crest(60)).toBeGreaterThan(crest(0));
  });

  it('does not touch the resting shield at all', () => {
    // Every impact term has to vanish at rest, or a shielded actor standing still would carry a
    // permanent dent on whichever axis it was last hit.
    const f = filter();
    const s = sample(f, { dist: shellR(f) * 0.5 });
    expect(s.impact![0]!).toBeLessThan(1e-4);
    expect(s.wob![0]!).toBeLessThan(1e-4);
  });
});

// ---------------------------------------------------------------------------------------
// The membrane, the breath, and the damage channel.
// ---------------------------------------------------------------------------------------

describe('EnergyShieldFilter, measured: the membrane', () => {
  it('samples the tile at two DIFFERENT places for the two hemispheres', () => {
    // One sample would put the same scale in front of and behind the body, which is precisely
    // the coincidence that reads as flat.
    const f = filter();
    const s = sample(f, { dist: shellR(f) * 0.5 });
    const [fx, fy] = s.warpF as [number, number];
    const [bx, by] = s.warpB as [number, number];
    expect(Math.hypot(fx - bx, fy - by)).toBeGreaterThan(0.1);
  });

  it('compresses the pattern toward the limb, which is what wraps a flat tile on a sphere', () => {
    const f = filter();
    const R = shellR(f);
    // Tile coordinates per unit of screen distance: higher means the pattern is finer there.
    const rate = (b: number): number => {
      const a = sample(f, { dist: b * R }).warpF as number[];
      const c = sample(f, { dist: (b + 0.02) * R }).warpF as number[];
      return Math.hypot(c[0]! - a[0]!, c[1]! - a[1]!);
    };
    expect(rate(0.85)).toBeGreaterThan(rate(0.1) * 1.5);
  });

  it('fades out before the silhouette, where its own compression would alias', () => {
    // Measured as the membrane's EFFECT on the wall — `front / density` is the multiplier it
    // applies — not as the value of the `grain` term. Reading `grain` alone passed with `grain`
    // computed and then never used (2026-08-26 battery), which is the same shader as one that
    // has no limb fade at all.
    const f = filter();
    const boost = (b: number): number => {
      const s = sample(f, { dist: b * shellR(f), scaleTexel: [1, 0.5, 0, 1] });
      return s.front![0]! / s.density![0]!;
    };
    expect(boost(0.999)).toBeLessThan(1.06); // all but gone at the silhouette
    expect(boost(0.5)).toBeGreaterThan(1.2); // ...and fully present across the face
    expect(sample(f, { dist: shellR(f) * 0.5 }).grain![0]!).toBeGreaterThan(0.9);
  });

  it('brightens the shell where the tile is bright, and is switched off by uMembrane', () => {
    const f = filter();
    const d = shellR(f) * 0.5;
    const dark = sample(f, { dist: d, scaleTexel: [0, 0.5, 0, 1] }).front![0]!;
    const bright = sample(f, { dist: d, scaleTexel: [1, 0.5, 0, 1] }).front![0]!;
    expect(bright).toBeGreaterThan(dark * 1.3);
    const off = sample(f, { dist: d, scaleTexel: [1, 0.5, 0, 1], membrane: 0 }).front![0]!;
    expect(off).toBeCloseTo(dark, 10); // uMembrane 0 leaves exactly the bare wall
  });

  it('keeps the SHAPE when the membrane is off — the cheap tier is still a shell', () => {
    // What a device that cannot afford the tile gives up is detail, not the enclosure cue.
    const f = filter();
    const R = shellR(f);
    const at = (b: number): number => sample(f, { dist: b * R, membrane: 0 }).density![0]!;
    const inner = 1 - thickness(f);
    expect(at(inner)).toBeGreaterThan(at(0) * 1.5);
    expect(at(0.995)).toBeLessThan(at(inner));
  });

  it('extinguishes whole scales as the pool drains — a second channel, not just dimming', () => {
    // design/13's dual-channel law. At full pool every cell is lit whatever its constant; at a
    // low pool a cell with a low constant is dropped to a quarter strength while its neighbour
    // with a high one survives, so the membrane visibly breaks up.
    const f = filter();
    const d = shellR(f) * 0.5;
    const live = (cell: number, intensity: number): number =>
      sample(f, { dist: d, scaleTexel: [1, cell, 0, 1], intensity }).liveF![0]!;
    expect(live(0.05, 1)).toBe(1);
    expect(live(0.95, 1)).toBe(1);
    expect(live(0.05, 0.12)).toBeLessThan(1); // a low-constant cell goes out first...
    expect(live(0.95, 0.12)).toBe(1); // ...while its neighbour is still lit
  });

  it('shifts hue as it fails, so a dying shield is not merely a dimmer one', () => {
    const f = filter();
    const full = sample(f, { dist: shellR(f) * 0.5 }).tint as number[];
    const dying = sample(f, { dist: shellR(f) * 0.5, intensity: 0.1 }).tint as number[];
    // Cyan (low red, high blue) toward a hot pale tone (high red).
    expect(dying[0]!).toBeGreaterThan(full[0]! + 0.3);
  });
});

describe('EnergyShieldFilter, measured: it fades with the pool and breathes', () => {
  it('scales with the shield ratio, and vanishes at zero', () => {
    const f = filter();
    const d = shellR(f) * 0.6;
    expect(glowAt(f, { dist: d, intensity: 0 })).toBe(0);
    const half = glowAt(f, { dist: d, intensity: 0.5 });
    const full = glowAt(f, { dist: d, intensity: 1 });
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
  });

  it('breathes the MEMBRANE and not the shell — a surface with energy moving over it', () => {
    // The pre-2026-08-26 shimmer multiplied the whole glow, so the character's silhouette
    // pulsed. Here the wall is time-invariant and only the pattern on it moves. Measured over a
    // full period so no single instant can be a lucky sample.
    const f = filter();
    const d = shellR(f) * 0.5;
    const period = (2 * Math.PI) / 0.0018;
    const walls = Array.from({ length: 24 }, (_, i) =>
      sample(f, { dist: d, time: (i / 24) * period }).density![0]!);
    expect(Math.max(...walls) - Math.min(...walls)).toBeLessThan(1e-9); // the shell itself is steady
    const breaths = Array.from({ length: 24 }, (_, i) =>
      sample(f, { dist: d, time: (i / 24) * period }).breath![0]!);
    expect(Math.max(...breaths)).toBeGreaterThan(Math.min(...breaths)); // ...but the pattern moves
    expect(Math.min(...breaths)).toBeGreaterThan(Math.max(...breaths) * 0.5); // never dims by half
  });

  it('takes a full breath in seconds, not in frames', () => {
    const src = stripComments(filter().glProgram.fragment!);
    const m = /sin\(uTime \* ([0-9.]+)\)/.exec(src);
    if (!m) throw new Error('shield shader no longer breathes on uTime');
    const hz = (Number(m[1]) * 1000) / (2 * Math.PI);
    expect(hz).toBeGreaterThan(0);
    expect(hz).toBeLessThan(0.5); // ~0.95 Hz read as a strobe (2026-08-17)
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
    const d = shellR(f) * (1 - thickness(f));
    const left = sample(f, { dist: d, angle: Math.PI, region, pool }).density![0]!;
    const right = sample(f, { dist: d, angle: 0, region, pool }).density![0]!;
    expect(left).toBeCloseTo(right, 10); // a crescent is exactly this pair diverging
  });
});

// ---------------------------------------------------------------------------------------
// The EXIT — the one item the 2026-08-26 shell rewrite left open. Until now `ActorFilters`
// dropped this filter from its composed list the frame the pool hit 0: the shell vanished
// between two frames and `EventReactor`'s burst had to carry the whole moment alone.
//
// `uShatter` is the only input that changed, so every measurement here is a difference between
// two runs of the SAME shader. That is deliberately the form that catches a term computed and
// then not used — the mutant this file's membrane suite already lost once.
// ---------------------------------------------------------------------------------------

/** A `const float NAME = x;` the shader declares, read off the shipped source rather than
 *  restated. Same discipline as `shellR`/`thickness` above, generalized because the exit added
 *  three more of them. */
function shaderConst(f: EnergyShieldFilter, name: string): number {
  const m = new RegExp(`const float ${name} = ([0-9.]+);`).exec(stripComments(f.glProgram.fragment!));
  if (!m) throw new Error(`shield shader no longer declares ${name}`);
  return Number(m[1]);
}

describe('EnergyShieldFilter, measured: the shell has an exit', () => {
  /** Where the shell's light stops, in `dist` units: the furthest radius still carrying at
   *  least one 8-bit step of it. Scanned rather than derived, so it follows whatever the shader
   *  actually does with the expansion. */
  const visibleEdge = (f: EnergyShieldFilter, shatter: number): number => {
    let out = 0;
    for (let i = 0; i <= 100; i++) {
      const dist = (i / 100) * 0.75;
      if (glowAt(f, { dist, shatter }) >= 1 / 255) out = dist;
    }
    return out;
  };

  /** The brightest point anywhere on the shell at this instant of the exit. */
  const peakLight = (f: EnergyShieldFilter, shatter: number): number =>
    Math.max(...Array.from({ length: 121 }, (_, i) => glowAt(f, { dist: (i / 120) * 0.72, shatter })));

  /** The wall term against the shader's OWN impact parameter, both read back off each run so
   *  neither the surface formula nor the expansion is duplicated here. */
  const wallProfile = (f: EnergyShieldFilter, shatter: number): Array<{ b: number; v: number }> =>
    Array.from({ length: 181 }, (_, i) => {
      const s = sample(f, { dist: (i / 180) * 0.72, shatter });
      return { b: s.b![0]!, v: s.density?.[0] ?? 0 };
    });

  it('expands the outer surface, by the amount BURST declares, easing OUT', () => {
    const f = filter();
    const R = shellR(f);
    const burst = shaderConst(f, 'BURST');
    expect(burst).toBeGreaterThan(0.1); // a real throw...
    expect(burst).toBeLessThan(0.5); // ...not a balloon
    const at = (shatter: number): number => sample(f, { dist: 0.1, shatter }).surface![0]!;
    expect(at(0)).toBeCloseTo(R, 12); // the intact shell is exactly untouched
    expect(at(1)).toBeCloseTo(R * (1 + burst), 12);
    const trace = Array.from({ length: 21 }, (_, i) => at(i / 20));
    for (let i = 1; i < trace.length; i++) expect(trace[i]!).toBeGreaterThan(trace[i - 1]!);
    // Most of the growth in the first half: the shell leaps and coasts. `>` alone was not
    // enough — a LINEAR ramp splits the growth exactly evenly and survived it on floating-point
    // noise (2026-08-26 battery). An ease-out quad puts 75% of the travel in the first half.
    expect(trace[10]! - trace[0]!).toBeGreaterThan((trace[20]! - trace[10]!) * 1.5);
  });

  it('carries the light OUTWARD on screen, not just the maths', () => {
    // `surface` is a term; where the light actually reaches is the effect. A shader that grew
    // `surface` while the profile stayed pinned to the old radius would pass the test above and
    // look identical to the version with no exit at all.
    const f = filter();
    expect(visibleEdge(f, 0.5)).toBeGreaterThan(visibleEdge(f, 0) * 1.05);
  });

  it('never grows past the filter area it is drawn into', () => {
    // The expansion has a ceiling nobody would notice being crossed: `Actor` pins this filter's
    // area to a fixed square, so `dist` beyond 0.5 * sqrt(2) does not exist along its narrowest
    // axis and a shell that grew past it would be cut off FLAT on four sides only. Both the
    // arithmetic BURST is chosen against and the scanned result.
    const f = filter();
    const REGION_EDGE = 0.5 * Math.SQRT2;
    expect(shellR(f) * (1 + shaderConst(f, 'BURST')) * shaderConst(f, 'CULL'))
      .toBeLessThan(REGION_EDGE);
    for (let i = 0; i <= 8; i++) expect(visibleEdge(f, i / 8)).toBeLessThan(REGION_EDGE);
  });

  it('thins the wall to a rim as it opens, instead of inflating at constant thickness', () => {
    // A shell that expanded at constant thickness reads as inflating. What makes it read as a
    // surface being pulled apart is the wall stretching thin while the radius grows — measured
    // as the same half-peak WIDTH the "边缘的那个圈太过实线" suite above uses to prove the
    // intact shell is not a rim, here required to go the other way.
    const f = filter();
    const thin = shaderConst(f, 'SHATTER_THIN');
    expect(thin).toBeGreaterThan(0.4); // a real thinning...
    expect(thin).toBeLessThan(1.0); // ...that still leaves a wall to look at
    const halfWidth = (shatter: number): number => {
      const p = wallProfile(f, shatter);
      const peak = Math.max(...p.map((x) => x.v));
      const above = p.filter((x) => x.v >= peak * 0.5);
      return Math.max(...above.map((x) => x.b)) - Math.min(...above.map((x) => x.b));
    };
    expect(halfWidth(1)).toBeLessThan(halfWidth(0) * 0.5);
    expect(halfWidth(1)).toBeGreaterThan(0.02); // ...and it is a rim, not nothing
  });

  it('migrates the wall to the outer surface as it thins', () => {
    // The other half of the same statement, and the one a hand-tuned width curve could not
    // fake: the chord's peak sits at the INNER wall (`b = 1 - THICKNESS`), so a wall that
    // genuinely thins has its bright band travel out toward the silhouette.
    const f = filter();
    const peakB = (shatter: number): number =>
      wallProfile(f, shatter).reduce((a, c) => (c.v > a.v ? c : a)).b;
    expect(peakB(0)).toBeCloseTo(1 - thickness(f), 1);
    expect(peakB(1)).toBeGreaterThan(peakB(0) + 0.1);
    expect(peakB(1)).toBeLessThan(1.0);
  });

  it('collapses to LITERALLY nothing by the end, monotonically', () => {
    const f = filter();
    const trace = Array.from({ length: 7 }, (_, i) => peakLight(f, i / 6));
    for (let i = 1; i < trace.length; i++) expect(trace[i]!).toBeLessThan(trace[i - 1]!);
    expect(trace[0]!).toBeGreaterThan(0.05); // there was a shell to lose
    // Not "small": at the instant `ActorFilters` detaches the filter the shader has to be
    // handing back the source texel UNCHANGED, or the detach is itself a visible step — which
    // is the entire defect this animation exists to remove.
    const texel: Val = [0.31, 0.42, 0.53, 0.64];
    for (const k of [0, 0.4, 0.8, 1.0]) {
      expect(sample(f, { dist: k * shellR(f), shatter: 1, texel }).finalColor).toEqual(texel);
    }
  });

  it('fades the refraction out with it, so nothing un-warps at the detach', () => {
    // The same property the pool drain already had (`fades the refraction with the pool`),
    // restated for the exit: the bend is scaled by `energy`, and the exit is a second way for
    // `energy` to reach 0.
    const f = filter();
    const d = shellR(f) * 0.7;
    const mag = (v: number[]): number => Math.hypot(v[0]!, v[1]!);
    expect(mag(sample(f, { dist: d, shatter: 1 }).bend as number[])).toBe(0);
    expect(mag(sample(f, { dist: d, shatter: 0.9 }).bend as number[]))
      .toBeLessThan(mag(sample(f, { dist: d }).bend as number[]) * 0.2);
  });

  it('is driven through the filter\'s own `shatter` property', () => {
    // Everything above reaches the uniform through the harness. `ActorFilters` cannot — it goes
    // through this setter — so a setter that dropped its argument would leave every measurement
    // in this file passing while the shell vanished between two frames exactly as before
    // (2026-08-26 battery survivor).
    const f = filter();
    const d = shellR(f) * 0.6;
    expect(f.shatter).toBe(0);
    const intact = glowAt(f, { dist: d });
    expect(intact).toBeGreaterThan(0.05);
    f.shatter = 1;
    expect(f.shatter).toBe(1);
    expect(glowAt(f, { dist: d })).toBe(0);
    f.shatter = 0.5;
    expect(sample(f, { dist: 0.1 }).surface![0]!).toBeGreaterThan(shellR(f) * 1.05);
    f.shatter = 0;
    expect(glowAt(f, { dist: d })).toBeCloseTo(intact, 12);
  });

  it('swings the tint to the hot end as the shell dies', () => {
    const f = filter();
    const cold = sample(f, { dist: 0.22 }).tint as number[];
    const hot = sample(f, { dist: 0.22, shatter: 0.9 }).tint as number[];
    expect(hot[0]!).toBeGreaterThan(cold[0]! + 0.3);
  });
});

// ---------------------------------------------------------------------------------------
// The membrane's own half of the exit. `shieldScales.ts` publishes each cell's place in a
// shuffled extinction order in the tile's GREEN channel; the exit reuses it as a per-cell
// launch speed, so the scales come apart in pieces rather than sliding off as one sheet.
// ---------------------------------------------------------------------------------------

describe('EnergyShieldFilter, measured: the membrane comes apart in pieces', () => {
  const AT = { dist: 0.22, angle: 0 } as const;
  const TILE_G = 0.95;
  /** A tile with no spatial structure but a definite cell rank — the throw is keyed off the
   *  rank, so it has to be pinned even where the position is not what is being measured. */
  const flat = (): Val => [0.5, TILE_G, 0, 1];

  /**
   * Every uScales lookup the shader made, in order, plus the run itself. The exit DISPLACES
   * those lookups, so what has to be measured is where the shader actually sampled — a factor
   * it computed on the way there is precisely the thing that has survived a mutant here before.
   */
  const lookups = (
    f: EnergyShieldFilter, o: SampleOpts, texel: (uv: Val) => Val = flat,
  ): { at: Val[]; env: Env } => {
    const at: Val[] = [];
    const env = sample(f, { ...o, tile: (uv) => { at.push([...uv]); return texel(uv); } });
    return { at, env };
  };

  it('probes the cell and then fetches the displaced texel, per hemisphere', () => {
    // Reading a per-cell constant costs a tap of its own: which cell is under this pixel is
    // exactly what the tap answers, so four is the count and a shader down to two has stopped
    // displacing anything.
    expect(lookups(filter(), AT).at).toHaveLength(4);
  });

  it('does not move the lookup at all while the shield is intact', () => {
    const { at } = lookups(filter(), AT);
    expect(at[2]).toEqual(at[0]); // the front fetch lands on the texel its probe pulled in...
    expect(at[3]).toEqual(at[1]); // ...and the same for the back layer
  });

  it('throws each scale OUTWARD once the shell lets go', () => {
    // Sampling further IN along the radius is what puts the cell further OUT on screen.
    const angle = 0.7;
    const dir = [Math.cos(angle), Math.sin(angle)];
    const { at } = lookups(filter(), { dist: 0.22, angle, shatter: 1 });
    for (const [probe, fetch] of [[at[0]!, at[2]!], [at[1]!, at[3]!]]) {
      const d = [probe[0]! - fetch[0]!, probe[1]! - fetch[1]!];
      const len = Math.hypot(d[0]!, d[1]!);
      expect(len).toBeGreaterThan(0.05);
      // ...and it is along the outward radius, not in some other direction.
      expect((d[0]! * dir[0]! + d[1]! * dir[1]!) / len).toBeCloseTo(1, 6);
    }
  });

  it('throws each scale at ITS OWN speed, off the extinction rank in the tile', () => {
    // The whole reason the offset is keyed off the GREEN channel. One global slide would move
    // the membrane as a single sheet, which reads as the pattern scrolling rather than as the
    // surface coming apart, and would pass every other assertion in this section.
    const f = filter();
    const throwFor = (rank: number): number => {
      const { at } = lookups(f, { ...AT, shatter: 1 }, () => [0.5, rank, 0, 1]);
      return Math.hypot(at[0]![0]! - at[2]![0]!, at[0]![1]! - at[2]![1]!);
    };
    expect(throwFor(0.9)).toBeGreaterThan(throwFor(0.1) * 1.5);
    expect(throwFor(0.1)).toBeGreaterThan(0); // ...and the slowest cell still leaves
  });

  it('reads the DISPLACED texel and not the probe — the throw reaches the picture', () => {
    // The assertion this section exists for. A shader that computed the offset, sampled with
    // it, and then composited the PROBE's texel would pass everything above while painting a
    // membrane that never moves. So: learn where the two lookups land, hand back a tile that is
    // bright at one of them and dark at the other, and ask which one came out.
    const f = filter();
    const o = { ...AT, shatter: 0.8 };
    const { at } = lookups(f, o);
    const [probe, fetch] = [at[0]!, at[2]!];
    expect(Math.hypot(probe[0]! - fetch[0]!, probe[1]! - fetch[1]!)).toBeGreaterThan(0.05);
    const near = (uv: Val, p: Val): boolean => Math.hypot(uv[0]! - p[0]!, uv[1]! - p[1]!) < 1e-9;
    const boost = (bright: Val, dark: Val): number => {
      const e = sample(f, {
        ...o,
        tile: (uv) => [near(uv, bright) ? 1 : near(uv, dark) ? 0 : 0.5, TILE_G, 0, 1],
      });
      return e.front![0]! / e.density![0]!;
    };
    expect(boost(fetch, probe)).toBeGreaterThan(1.4); // the bright cell arrived...
    expect(boost(probe, fetch)).toBeLessThan(1.02); // ...and the probe's own texel did not
  });

  it('puts the scales OUT as it goes, not merely outward', () => {
    // The exit runs the same dual-channel extinction the pool drain does (design/13), because
    // `integrity` is derived from `energy` and not from `uIntensity`: whole cells go dark in the
    // tile's shuffled rank order while the shell is still expanding. A membrane that only dimmed
    // uniformly is the "brightness only" failure that law exists to forbid.
    const f = filter();
    const live = (rank: number, shatter: number): number =>
      sample(f, { ...AT, scaleTexel: [1, rank, 0, 1], shatter }).liveF![0]!;
    expect(live(0.05, 0)).toBe(1);
    expect(live(0.95, 0)).toBe(1);
    expect(live(0.05, 0.75)).toBeLessThan(1); // the first cells in the order have gone...
    expect(live(0.95, 0.75)).toBe(1); // ...while the last are still lit
    expect(live(0.95, 0.98)).toBeLessThan(1); // and by the end, everything
  });
});
