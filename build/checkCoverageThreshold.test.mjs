/**
 * The coverage gate's own rules, each against a synthetic package tree, plus the real repo as the
 * control.
 *
 * The real-tree assertion alone would be worthless — `expect(verdict).toBe('ok')` passes just as
 * happily if `GATED_PACKAGES` were emptied, or if `readJsonSummary` silently returned 100% for a
 * file it could not read. So every rule below is also fed something that violates it, the canary
 * has its own case, and the real-repo block asserts the scope is non-empty before asserting
 * anything about it (`daydayup-test-assertion-craft`: a sweep's zero with no evidence the case
 * arose).
 *
 * ## What this file deliberately does NOT test
 *
 * That the percentages are correct. Those come from vitest's v8 provider, and re-deriving them
 * here would be testing a dependency. What is ours, and therefore what is pinned below, is the
 * JUDGING: which shortfall is which kind, what a missing directory means in each of the two CI
 * situations, and the arithmetic in the "N lines short" hint — the number a reader acts on.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BRANCH_THRESHOLD,
  DEFAULT_LINE_THRESHOLD,
  GATED_PACKAGES,
  countSrcFiles,
  evaluate,
  readGateEnv,
  readJsonSummary,
} from './coverageLib.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

/** A `coverage-summary.json` total block with the four metrics vitest's json-summary emits. */
function totals({ lines, branches, functions = [1, 1] }) {
  const metric = ([covered, total]) => ({
    total,
    covered,
    skipped: 0,
    pct: total === 0 ? 100 : (covered / total) * 100,
  });
  return {
    total: {
      lines: metric(lines),
      branches: metric(branches),
      functions: metric(functions),
      statements: metric(lines),
    },
    // One measured-file key, so `scopeFiles` is a real 1 rather than an accidental 0.
    'a/b.ts': { lines: metric(lines) },
  };
}

/**
 * Builds a throwaway root holding `coverage/coverage-summary.json` for each named package.
 * A package mapped to `null` gets NO coverage directory — the missing-output case.
 */
function fakeRoot(spec) {
  const root = mkdtempSync(join(tmpdir(), 'dd-coverage-'));
  for (const [pkg, data] of Object.entries(spec)) {
    if (data === null) continue;
    const dir = join(root, pkg, 'coverage');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'coverage-summary.json'), JSON.stringify(data));
  }
  return root;
}

const PKGS = [{ pkg: 'alpha', srcDir: 'src' }];

function judge(spec, opts = {}) {
  const root = fakeRoot(spec);
  try {
    return evaluate(root, { packages: PKGS, ...opts });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the bars', () => {
  it('passes a package over both', () => {
    const ev = judge({ alpha: totals({ lines: [95, 100], branches: [92, 100] }) });
    expect(ev.verdict).toBe('ok');
    expect(ev.failures).toEqual([]);
    expect(ev.measured).toBe(1);
  });

  it('fails a package under the LINE bar, and says how many lines short', () => {
    const ev = judge({ alpha: totals({ lines: [850, 1000], branches: [95, 100] }) });
    expect(ev.verdict).toBe('fail');
    expect(ev.belowBranchBar).toEqual([]);
    expect(ev.belowBar).toHaveLength(1);
    expect(ev.belowBar[0].pkg).toBe('alpha');
    // 90% of 1000 is 900; 850 are covered, so 50 more lines reach the bar. Not a round-trip of
    // the formula: the number is written out here so a changed formula fails rather than agrees.
    expect(ev.belowBar[0].headroom).toBe(50);
  });

  it('fails a package under the BRANCH bar alone — the case a line-only gate misses', () => {
    // The shape the branch bar exists for: 93.81% lines / 82.09% branches was a real package in
    // the sibling project, green for a year under a line-only gate.
    const ev = judge({ alpha: totals({ lines: [938, 1000], branches: [821, 1000] }) });
    expect(ev.verdict).toBe('fail');
    expect(ev.belowBar).toEqual([]);
    expect(ev.belowBranchBar).toHaveLength(1);
    expect(ev.belowBranchBar[0].branchHeadroom).toBe(79);
  });

  it('reports a package under BOTH bars once per bar, not once in total', () => {
    const ev = judge({ alpha: totals({ lines: [500, 1000], branches: [500, 1000] }) });
    expect(ev.belowBar).toHaveLength(1);
    expect(ev.belowBranchBar).toHaveLength(1);
    expect(ev.failures).toHaveLength(2);
  });

  it('does not gate FUNCTIONS — reported only', () => {
    const ev = judge({
      alpha: totals({ lines: [95, 100], branches: [95, 100], functions: [10, 100] }),
    });
    expect(ev.verdict).toBe('ok');
    expect(ev.rows[0].funcPct).toBe(10);
  });

  it('treats exactly-at-the-bar as passing, and one hundredth under as failing', () => {
    expect(judge({ alpha: totals({ lines: [90, 100], branches: [90, 100] }) }).verdict).toBe('ok');
    expect(judge({ alpha: totals({ lines: [8999, 10000], branches: [90, 100] }) }).verdict).toBe(
      'fail',
    );
  });
});

describe('a missing coverage/ directory', () => {
  it('FAILS CLOSED when the test jobs were fine — and as a broken step, not a regression', () => {
    const ev = judge({ alpha: null }, { testsOk: true });
    expect(ev.verdict).toBe('fail');
    expect(ev.missingOutput).toEqual([{ pkg: 'alpha' }]);
    // The distinction that matters to whoever reads the log: nothing here claims coverage fell.
    expect(ev.belowBar).toEqual([]);
    expect(ev.belowBranchBar).toEqual([]);
  });

  it('is SKIPPED, not failed, when a test job in the same run already failed', () => {
    const ev = judge({ alpha: null }, { testsOk: false });
    expect(ev.verdict).toBe('skipped');
    expect(ev.failures).toEqual([]);
    expect(ev.skipped).toBe(1);
    expect(ev.measured).toBe(0);
  });

  it('still judges the packages that DID report, in the same run', () => {
    const ev = judge(
      { alpha: totals({ lines: [50, 100], branches: [95, 100] }), beta: null },
      { packages: [...PKGS, { pkg: 'beta', srcDir: 'src' }], testsOk: true },
    );
    expect(ev.belowBar).toHaveLength(1);
    expect(ev.missingOutput).toHaveLength(1);
    expect(ev.failures).toHaveLength(2);
  });
});

describe('a shrunken coverage scope', () => {
  // `fakeRoot` writes exactly one measured-file key, so `scopeFiles` is 1 for every case here;
  // what varies is how many .ts files the synthetic package has on disk.
  function withSources(n, opts = {}) {
    const root = fakeRoot({ alpha: totals({ lines: [100, 100], branches: [100, 100] }) });
    try {
      mkdirSync(join(root, 'alpha', 'src'), { recursive: true });
      for (let i = 0; i < n; i++) writeFileSync(join(root, 'alpha', 'src', `f${i}.ts`), 'export {};');
      return evaluate(root, { packages: PKGS, ...opts });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('FAILS a package at 100% that measured fewer files than the tree holds', () => {
    // The whole point: the percentage is perfect and the scope is a lie. This is what narrowing
    // `coverage.include` looks like from the outside, and nothing else in this file would catch
    // it — dropping the untested files from a scope makes every other number better.
    const ev = withSources(5);
    expect(ev.verdict).toBe('fail');
    expect(ev.belowBar).toEqual([]);
    expect(ev.belowBranchBar).toEqual([]);
    expect(ev.scopeShrunk).toEqual([{ pkg: 'alpha', scopeFiles: 1, srcFiles: 5 }]);
  });

  it('accepts measured === source', () => {
    expect(withSources(1).verdict).toBe('ok');
  });

  it('accepts measured > source — the one-sidedness is deliberate', () => {
    // countSrcFiles skips fixtures/, scripts/ and test/ by name, so a package that legitimately
    // instruments something in one of them must not be failed for it.
    expect(withSources(0).verdict).toBe('ok');
  });
});

describe('the canary', () => {
  it('reports an EMPTY package list as its own verdict, not as a pass', () => {
    // Every loop in `evaluate` iterates the list, so an emptied one would otherwise print a
    // cheerful "all 0 packages >= 90%" and exit 0 — a gate that retires itself by turning green.
    const ev = judge({}, { packages: [] });
    expect(ev.verdict).toBe('empty');
    expect(ev.measured).toBe(0);
  });

  it('does not confuse "empty list" with "every package passed"', () => {
    expect(judge({ alpha: totals({ lines: [100, 100], branches: [100, 100] }) }).verdict).toBe('ok');
  });
});

describe('readJsonSummary', () => {
  it('reports a missing file as missing rather than throwing or inventing a number', () => {
    expect(readJsonSummary(join(tmpdir(), 'definitely-not-here'), 'nope')).toEqual({
      pkg: 'nope',
      missing: true,
    });
  });

  it('reports malformed JSON as missing too — an unreadable summary is not a passing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-coverage-bad-'));
    try {
      mkdirSync(join(root, 'alpha', 'coverage'), { recursive: true });
      writeFileSync(join(root, 'alpha', 'coverage', 'coverage-summary.json'), '{ not json');
      expect(readJsonSummary(root, 'alpha').missing).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readGateEnv', () => {
  it('defaults both bars to 90 and assumes the tests were fine', () => {
    expect(readGateEnv({})).toEqual({ threshold: 90, branchThreshold: 90, testsOk: true });
    expect(DEFAULT_LINE_THRESHOLD).toBe(90);
    expect(DEFAULT_BRANCH_THRESHOLD).toBe(90);
  });

  it('reads both overrides independently', () => {
    expect(readGateEnv({ COVERAGE_THRESHOLD: '85' }).threshold).toBe(85);
    expect(readGateEnv({ COVERAGE_THRESHOLD: '85' }).branchThreshold).toBe(90);
    expect(readGateEnv({ COVERAGE_BRANCH_THRESHOLD: '80' }).branchThreshold).toBe(80);
  });

  it('falls back to the bar rather than NaN on garbage — a typo must not disable the gate', () => {
    // `Number('ninety')` is NaN, and every `pct < NaN` is false, so a typo'd override would
    // silently pass everything.
    expect(readGateEnv({ COVERAGE_THRESHOLD: 'ninety' }).threshold).toBe(90);
    expect(readGateEnv({ COVERAGE_THRESHOLD: '' }).threshold).toBe(90);
  });

  it('enters the lenient mode only on the literal string "false"', () => {
    expect(readGateEnv({}).testsOk).toBe(true);
    expect(readGateEnv({ TESTS_OK: 'true' }).testsOk).toBe(true);
    expect(readGateEnv({ TESTS_OK: '0' }).testsOk).toBe(true);
    expect(readGateEnv({ TESTS_OK: 'false' }).testsOk).toBe(false);
  });
});

describe('the real repo', () => {
  it('gates a non-empty list of packages, each naming a real source root', () => {
    // The scope guard: everything below is meaningless if this list is empty or misspelt.
    expect(GATED_PACKAGES.length).toBeGreaterThanOrEqual(3);
    expect(GATED_PACKAGES.map((p) => p.pkg).sort()).toEqual(['client', 'engine', 'server']);
    for (const { pkg, srcDir } of GATED_PACKAGES) {
      expect(countSrcFiles(REPO_ROOT, pkg, srcDir), `${pkg}: no source files found`).toBeGreaterThan(
        0,
      );
    }
  });

  it('counts the engine at its package ROOT, where its sources actually live', () => {
    // A regression here would read as "the engine shrank", not as "the path is wrong".
    expect(countSrcFiles(REPO_ROOT, 'engine', '.')).toBeGreaterThan(50);
    expect(countSrcFiles(REPO_ROOT, 'engine', 'src')).toBe(0);
  });

  it('excludes tests, configs and fixtures from the source count', () => {
    const n = countSrcFiles(REPO_ROOT, 'engine', '.');
    // `engine/` holds roughly as many .test.ts as .ts at its root; a count that swept them in
    // would be visibly larger than the file list, and `fixtures/` would drag test data in too.
    expect(n).toBeLessThan(120);
  });
});
