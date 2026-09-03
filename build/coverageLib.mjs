#!/usr/bin/env node
// Shared reading + judging logic for the two coverage scripts run from the repo root after the
// per-workspace `test:coverage` steps:
//
//   build/coverageReport.mjs           pure report, deliberately never fails
//   build/checkCoverageThreshold.mjs   the CI gate, exits 1 below either bar
//
// One file so the package list and the summary parser cannot drift between them — the two must
// never be able to disagree about what was measured or whether it passed.
//
// Ported from the sibling project `funny` (`scripts/coverageLib.mjs`), with three deliberate
// differences, each recorded where it applies below: no per-package exemption list, no
// second coverage backend (every package here is vitest + v8), and whole-tree `coverage.include`
// in all three packages instead of funny's transitional per-file allow-list.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every workspace held to the bars, with the source root its `Scope` column counts against.
 *
 * There is deliberately NO second list of "measured but not gated" packages. funny had one as a
 * bounded transition device and retired it with the reasoning this repo should inherit up front:
 * leaving a working way to be exempt from a gate in place is a standing invitation to reach for
 * it instead of writing the tests. A package that cannot hold the bar does not belong on this
 * list at all — and then its absence is a visible edit here, not a quiet flag in a JSON file.
 *
 * `tools/*` are absent for that reason and not by oversight: animator, map-editor, png-pipeline
 * and desktop-shell are dev-only tooling that never ships to a player, and adding them would
 * mean either gating them (fine, but it is separate work with its own tests to write) or
 * inventing the exemption list this comment just argued against.
 */
export const GATED_PACKAGES = [
  // 96.52% lines / 90.03% branches when first measured (2026-09-03), over all 217 source files.
  { pkg: 'client', srcDir: 'src' },
  // 97.70% / 92.95%. Sources sit at the package ROOT, not under src/ — see its vitest config.
  { pkg: 'engine', srcDir: '.' },
  // 85.23% / 78.27% when first measured; brought over both bars in the same pass that added
  // this file, which is why it is on the list rather than in an exemption block.
  { pkg: 'server', srcDir: 'src' },
];

/** Bars. Both default to 90; either can be overridden by env for a one-off local run. */
export const DEFAULT_LINE_THRESHOLD = 90;
export const DEFAULT_BRANCH_THRESHOLD = 90;

/**
 * Reads the bars and the CI hand-off from the environment.
 *
 * One GLOBAL knob per bar, not a per-package override — a per-package knob is an exemption list
 * wearing a different hat, and would let one package's number be lowered in a diff nobody reads
 * as "we stopped testing that". Lowering the bar for everyone is a conversation; lowering it for
 * one package should not be a one-line env var.
 *
 * TESTS_OK is how ci.yml tells this script that some test job in the same run already failed.
 * See `evaluate` for why that changes the verdict on a MISSING coverage directory.
 */
export function readGateEnv(env = process.env) {
  const num = (raw, fallback) => {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    threshold: num(env.COVERAGE_THRESHOLD, DEFAULT_LINE_THRESHOLD),
    branchThreshold: num(env.COVERAGE_BRANCH_THRESHOLD, DEFAULT_BRANCH_THRESHOLD),
    // Anything but the literal 'false' means the test jobs were fine. Absent = fine, because a
    // local run has no CI to report and must not silently enter the lenient mode.
    testsOk: env.TESTS_OK !== 'false',
  };
}

/**
 * `<pkg>/coverage/coverage-summary.json`, as written by vitest's v8 provider with the
 * `json-summary` reporter. Returns `{ pkg, missing: true }` when the file is not there —
 * judged by `evaluate`, not here, because "no output" means different things in different runs.
 */
export function readJsonSummary(root, pkg) {
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, pkg, 'coverage', 'coverage-summary.json'), 'utf8'),
    );
    const { total } = parsed;
    return {
      pkg,
      lines: total.lines,
      branches: total.branches,
      functions: total.functions,
      statements: total.statements,
      // Every key but `total` is one measured file, so this is the size of the coverage scope.
      scopeFiles: Object.keys(parsed).filter((k) => k !== 'total').length,
    };
  } catch {
    return { pkg, missing: true };
  }
}

/**
 * Counts the .ts source files under a package's source root — the denominator for the report's
 * `Scope` column.
 *
 * Why that column exists: a percentage is measured over whatever `coverage.include` selects, and
 * narrowing that include is the one knob that raises the number without adding a single test.
 * All three packages here are whole-tree today (`measured === src`, so the column reads N/N),
 * which means any future narrowing shows up as a shrinking numerator in the same table as the
 * percentage it flatters. `client/src/coverageScope.test.ts` fails on such a narrowing outright;
 * this column is the human-readable half of the same guard, and stays useful for the two
 * packages that have no such test.
 */
export function countSrcFiles(root, pkg, srcDir = 'src') {
  const SKIP_DIRS = new Set(['node_modules', 'coverage', 'dist', 'fixtures', 'scripts', 'test']);
  const walk = (dir) => {
    let n = 0;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) n += walk(join(dir, e.name));
      } else if (e.isFile()) {
        if (!e.name.endsWith('.ts')) continue;
        if (e.name.endsWith('.d.ts') || e.name.endsWith('.test.ts')) continue;
        if (e.name === 'vitest.config.ts' || e.name === 'sim.config.ts') continue;
        n++;
      }
    }
    return n;
  };
  return walk(join(root, pkg, srcDir));
}

/** Lines still to cover before `pct` would reach `bar`, given `covered`/`total`. */
function headroomFor(covered, total, bar) {
  return Math.max(0, Math.ceil((bar / 100) * total - covered));
}

/**
 * The verdict, shared by the report and the gate so they cannot disagree.
 *
 * Two failure KINDS, kept apart on purpose — funny's version lumped them together and sent
 * readers hunting for missing tests when the real fix was a missing CI step:
 *
 *   belowBar / belowBranchBar   a real coverage regression: the package ran, and is short.
 *   missingOutput               a broken test/coverage step: the package produced nothing.
 *   scopeShrunk                 the percentage is over the bar but measures less of the tree.
 *
 * `scopeShrunk` is the one that has no equivalent in funny, and it is the whole reason this repo
 * can hold a whole-tree include where funny needs an allow-list. It fires when the coverage
 * report holds FEWER files than the package's source tree does — which is what narrowing
 * `coverage.include` looks like, and it is otherwise completely silent: dropping files from the
 * scope usually makes the percentage go UP, because the files a narrowing removes are the
 * untested ones. funny guards this with a per-entry test over its allow-list; here there is no
 * list to rot, so the check is direct — count what was measured, count what is on disk, and
 * fail if the first is smaller. It uses the REAL matcher's answer (the report vitest just wrote)
 * rather than re-deriving the globs, so it cannot disagree with what was actually instrumented.
 *
 * Deliberately one-sided: measured > source is FINE. `countSrcFiles` skips a few directories by
 * name (fixtures, scripts, test), so a package that legitimately measures something outside them
 * must not be failed for it. Only the shrinking direction is a defect.
 *
 * A missing `coverage/` FAILS CLOSED. We cannot confirm >= 90% without the data, and silently
 * passing would let a broken pipeline masquerade as "coverage is fine" — the same 假绿 class this
 * repo already treats as a bug rather than a pass. The one exception is `testsOk === false`:
 * when ci.yml reports that a test job in this run already failed, a package with no coverage is a
 * CONSEQUENCE of that failure, the run is already red, and reporting it a second time buries the
 * real cause.
 *
 * Line and branch shortfalls are reported SEPARATELY, per package, because "cover the lines
 * nothing runs" and "exercise the other side of the conditions you already run" are different
 * pieces of work. The branch bar is the one that earns its keep: uncovered branches concentrate
 * in absent-field fallbacks, refusal paths and lost-race arms — the code that only runs when
 * something has gone wrong, which is the code a test is most worth having for.
 *
 * `functions` is measured and reported but NOT gated: it is the metric most easily satisfied by
 * calling a function once and asserting nothing.
 */
export function evaluate(root, opts = {}) {
  const {
    threshold = DEFAULT_LINE_THRESHOLD,
    branchThreshold = DEFAULT_BRANCH_THRESHOLD,
    testsOk = true,
    packages = GATED_PACKAGES,
  } = opts;

  const rows = [];
  const belowBar = [];
  const belowBranchBar = [];
  const missingOutput = [];
  const scopeShrunk = [];
  let skipped = 0;

  for (const { pkg, srcDir } of packages) {
    const summary = readJsonSummary(root, pkg);
    if (summary.missing) {
      if (testsOk) missingOutput.push({ pkg });
      else skipped++;
      rows.push({ pkg, missing: true });
      continue;
    }
    const pct = summary.lines.pct;
    const branchPct = summary.branches.pct;
    const row = {
      pkg,
      pct,
      branchPct,
      funcPct: summary.functions.pct,
      lines: summary.lines,
      branches: summary.branches,
      scopeFiles: summary.scopeFiles,
      srcFiles: countSrcFiles(root, pkg, srcDir),
    };
    rows.push(row);
    if (pct < threshold) {
      belowBar.push({
        pkg,
        pct,
        headroom: headroomFor(summary.lines.covered, summary.lines.total, threshold),
      });
    }
    if (branchPct < branchThreshold) {
      belowBranchBar.push({
        pkg,
        branchPct,
        branchHeadroom: headroomFor(
          summary.branches.covered,
          summary.branches.total,
          branchThreshold,
        ),
      });
    }
    if (row.scopeFiles < row.srcFiles) {
      scopeShrunk.push({ pkg, scopeFiles: row.scopeFiles, srcFiles: row.srcFiles });
    }
  }

  const failures = [...belowBar, ...belowBranchBar, ...missingOutput, ...scopeShrunk];
  // The canary. Every loop above iterates `packages`, so an emptied list would print a cheerful
  // "all 0 packages >= 90%" and exit 0 — a gate that retires itself by turning green. Same shape
  // as build/checkFileLength.mjs' and build/checkDocPaths.mjs' own canaries.
  const verdict =
    packages.length === 0 ? 'empty' : failures.length > 0 ? 'fail' : skipped > 0 ? 'skipped' : 'ok';

  return {
    verdict,
    rows,
    belowBar,
    belowBranchBar,
    missingOutput,
    scopeShrunk,
    failures,
    skipped,
    measured: rows.filter((r) => !r.missing).length,
    threshold,
    branchThreshold,
  };
}
