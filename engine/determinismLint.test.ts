/**
 * Makes design/06's "(enforced)" true (design/18-test-strategy.md, G2 / Layer 0).
 *
 * `design/06-netcode-determinism.md` has a section headed **"Banned in the logic layer
 * (enforced)"** listing `Math.random()`, `Date.now()`, `Math.sqrt/sin/cos/atan2` and friends.
 * Nothing enforced any of it. There is no ESLint config anywhere in this repo, and `tsc` has no
 * opinion about which globals a file calls — the rule lived entirely in whoever was reviewing.
 *
 * It is a rule worth a gate, because every item on it fails the same way: silently, on someone
 * else's machine, months later. A single `Math.sqrt` in a system is a desync that reproduces on
 * one player's CPU and not on yours, and no unit test in this repo would ever go red for it.
 *
 * ## Two things this file is careful about
 *
 * **Comments and strings are stripped before scanning.** This repo has been bitten by a
 * source-text contract test matching a value quoted in a COMMENT (see
 * `daydayup-testing-conventions`, the shader-frequency regex that found the pre-fix number
 * inside the comment explaining the fix). Here it would be worse than a false positive: the
 * determinism rules are quoted verbatim in half a dozen doc comments — including the ones
 * saying "zero `Math.random`" — so an unstripped scan would fail on the very prose describing
 * the rule, and the obvious "fix" would be to weaken the pattern until it passed.
 *
 * **The allowlist carries a reason per entry, and is asserted to be minimal.** An allowlist
 * that can grow silently is just a slower version of no rule at all, so `no entry is dead`
 * below fails if a listed exception stops being needed — a stale exemption is exactly how
 * "well, that file was always allowed to" starts.
 */
import { describe, expect, it } from 'vitest';
import { engineSourceFiles, readEngineFile } from './fixtures/repoFiles.mjs';

/**
 * The banned calls, as source patterns. Every one of these is either nondeterministic across
 * machines (the float-math family: results are implementation-defined beyond the basic
 * operations IEEE 754 pins down) or across RUNS (`Math.random`, the clocks).
 *
 * Deliberately NOT banned, because they are exactly specified and this codebase depends on
 * them: `Math.imul`, `Math.round`, `Math.floor`, `Math.ceil`, `Math.trunc`, `Math.abs`,
 * `Math.min`, `Math.max`, `Math.sign`. Integer arithmetic and correctly-rounded operations are
 * bit-identical everywhere; transcendentals are not.
 */
const BANNED: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bMath\.random\s*\(/g, why: 'nondeterministic — use the injected Prng (design/06)' },
  { pattern: /\bMath\.sqrt\s*\(/g, why: 'use isqrt (math/fixed.ts)' },
  { pattern: /\bMath\.(?:sin|cos|tan|asin|acos|atan2?)\s*\(/g, why: 'use cosFp/sinFp/atan2Brad (math/trig.ts)' },
  { pattern: /\bMath\.hypot\s*\(/g, why: 'use isqrt on the squared sum' },
  { pattern: /\bMath\.(?:log2?|log10|exp|pow|cbrt)\s*\(/g, why: 'transcendental — not bit-identical across engines' },
  { pattern: /\bDate\.now\s*\(/g, why: 'wall clock — the sim advances on ticks (design/08)' },
  { pattern: /\bnew\s+Date\s*\(/g, why: 'wall clock — the sim advances on ticks (design/08)' },
  { pattern: /\bperformance\.now\s*\(/g, why: 'wall clock — the sim advances on ticks (design/08)' },
];

/**
 * The one deliberate exception, with the reason it is legitimate rather than tolerated.
 *
 * `state/input.ts` is the INPUT EDGE, not the logic layer: its whole job is turning a raw
 * float controller sample into the integer brad + 0..255 magnitude that every client, replay
 * and broadcast then agrees on. Its own header says so — *"This is the ONE place a float
 * controller sample is allowed to touch the input path… upstream float divergence in
 * atan2/hypot is harmless."* Harmless precisely because the float never survives: the integer
 * it quantizes to is what enters the sim.
 */
const ALLOWED: readonly { file: string; calls: readonly string[]; why: string }[] = [
  {
    file: 'state/input.ts',
    calls: ['Math.hypot(', 'Math.atan2('],
    why: 'the input-edge quantizer — the float is consumed here and never enters the sim (design/06)',
  },
];

/**
 * Remove line comments, block comments and string/template literals, replacing each with an
 * equal number of newlines-preserving blanks so reported line numbers stay honest.
 *
 * Hand-rolled rather than regex-based on purpose: a regex that tries to skip strings and
 * comments in one pass gets `'a // b'` or `"/*"` wrong, and a stripper that is wrong in the
 * PERMISSIVE direction silently disables the lint.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  const keep = (ch: string): void => {
    out += ch === '\n' ? '\n' : ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') keep(src[i++]!);
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) keep(src[i++]!);
      continue;
    }
    const q = src[i]!;
    if (q === '"' || q === "'" || q === '`') {
      keep(src[i++]!);
      while (i < src.length) {
        if (src[i] === '\\') {
          keep(src[i++]!);
          if (i < src.length) keep(src[i++]!);
          continue;
        }
        if (src[i] === q) {
          keep(src[i++]!);
          break;
        }
        keep(src[i++]!);
      }
      continue;
    }
    out += src[i++];
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  call: string;
  why: string;
}

function scan(file: string): Violation[] {
  const code = stripCommentsAndStrings(readEngineFile(file));
  const lines = code.split('\n');
  const found: Violation[] = [];
  for (const { pattern, why } of BANNED) {
    for (let n = 0; n < lines.length; n++) {
      for (const m of lines[n]!.matchAll(new RegExp(pattern.source, 'g'))) {
        found.push({ file, line: n + 1, call: m[0], why });
      }
    }
  }
  return found;
}

const allowedFor = (file: string): readonly string[] => ALLOWED.find((a) => a.file === file)?.calls ?? [];

describe('determinism lint — design/06 "Banned in the logic layer (enforced)", now actually enforced', () => {
  const files = engineSourceFiles();

  it('scans a plausible number of engine source files', () => {
    // Anti-vacuity. A broken walker returning [] would make every assertion below pass while
    // linting nothing at all — the single most likely way this file silently dies.
    expect(files.length, 'the source walker found almost nothing — is it broken?').toBeGreaterThan(50);
    expect(files).toContain('systems/MovementSystem.ts');
    expect(files).toContain('config.ts');
    expect(files.some((f) => f.endsWith('.test.ts')), 'tests must not be linted').toBe(false);
  });

  it('no engine source calls a banned nondeterministic API', () => {
    const violations = files
      .flatMap(scan)
      .filter((v) => !allowedFor(v.file).some((c) => v.call.startsWith(c.slice(0, -1))));
    expect(
      violations.map((v) => `${v.file}:${v.line}  ${v.call})  — ${v.why}`),
      'design/06 bans these in the deterministic core. If one is genuinely an input-edge or\n' +
        'build-time use, add it to ALLOWED above WITH the reason, so the exception is reviewable.',
    ).toEqual([]);
  });

  it('every allowlist entry is still needed — no dead exemptions', () => {
    // A stale exemption is how a rule quietly stops applying. If the code no longer makes the
    // call, the entry must go, so the allowlist can never accumulate.
    const dead: string[] = [];
    for (const entry of ALLOWED) {
      const code = stripCommentsAndStrings(readEngineFile(entry.file));
      for (const call of entry.calls) if (!code.includes(call)) dead.push(`${entry.file} no longer calls ${call})`);
    }
    expect(dead).toEqual([]);
  });

  it('the allowlist stays small enough to read', () => {
    // Not arbitrary: design/06 describes ONE legitimate float boundary (the input edge). A
    // second entry is not forbidden, but it should require deleting this assertion and saying
    // why in the commit — which is the review this file is trying to force.
    expect(ALLOWED.length, 'a growing allowlist is a rule dissolving — justify it explicitly').toBeLessThanOrEqual(1);
  });
});

describe('stripCommentsAndStrings — the lint is only as good as this', () => {
  it('blanks a line comment but keeps the code, the length and the line break', () => {
    // Asserted as PROPERTIES rather than a hand-counted literal: the first draft of this test
    // spelled out the blank run and was off by one space, which says nothing about the
    // stripper and everything about counting spaces in a string literal.
    const src = 'a; // Math.random()\nb;';
    const out = stripCommentsAndStrings(src);
    expect(out.length, 'length must be preserved so column numbers stay honest').toBe(src.length);
    expect(out.split('\n').length, 'line count must be preserved').toBe(2);
    expect(out).not.toContain('Math.random');
    expect(out.startsWith('a; ')).toBe(true);
    expect(out.split('\n')[1]).toBe('b;');
  });

  it('blanks a block comment across lines, preserving newlines', () => {
    const out = stripCommentsAndStrings('x;/* Math.random()\n Date.now() */y;');
    expect(out).toContain('\n');
    expect(out).not.toContain('Math.random');
    expect(out.endsWith('y;')).toBe(true);
  });

  it('blanks string and template literals', () => {
    expect(stripCommentsAndStrings('f("Math.random()");')).not.toContain('Math.random');
    expect(stripCommentsAndStrings('f(`Date.now()`);')).not.toContain('Date.now');
  });

  it('is not fooled by a comment marker inside a string, or a quote inside a comment', () => {
    // Both directions of the classic stripper bug. The first would blank real code from `//`
    // onward; the second would leave the rest of the file inside a phantom string.
    expect(stripCommentsAndStrings("const s = '// not a comment'; Math.random();")).toContain('Math.random');
    expect(stripCommentsAndStrings("// it's fine\nMath.random();")).toContain('Math.random');
  });

  it('respects escapes, so a trailing backslash cannot swallow the rest of the file', () => {
    expect(stripCommentsAndStrings("const s = 'a\\'b'; Math.random();")).toContain('Math.random');
  });

  it('leaves ordinary code untouched', () => {
    expect(stripCommentsAndStrings('const a = b + c;')).toBe('const a = b + c;');
  });
});
