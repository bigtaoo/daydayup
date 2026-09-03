#!/usr/bin/env node
// CI GATE: fails if any package in build/coverageLib.mjs's `GATED_PACKAGES` is below the LINE or
// the BRANCH bar. Both default to 90.
//
// This is the mechanism that turns "the client is over 90%" from a sentence in a doc into
// something a commit can break. It was measured before it was gated (2026-09-03): client 96.52%
// lines / 90.03% branches, engine 97.70% / 92.95%, server 85.23% / 78.27%. Two of the three
// already cleared both bars over their WHOLE source tree — the gate is here to keep that true,
// not to announce it. The branch column is why it is worth having at all: the client sat 0.03
// percentage points over the branch bar, i.e. the next unexercised `if` would have taken it under
// with nothing anywhere to notice.
//
// Runs from the repo root, AFTER every workspace's `test:coverage` has written its
// `coverage/coverage-summary.json`. `npm run coverage` chains both halves.
//
// Ported from `funny`'s scripts/checkCoverageThreshold.mjs. The judging all lives in
// coverageLib.mjs's `evaluate`, shared with build/coverageReport.mjs so the report and the gate
// cannot disagree about the same run; what is unique to this file is the exit code and the
// step's own log output.
//
// Overrides, for a one-off local run only (there is no per-package knob, on purpose — see
// readGateEnv):
//   COVERAGE_THRESHOLD=85            the line bar
//   COVERAGE_BRANCH_THRESHOLD=80     the branch bar
//   TESTS_OK=false                   set by ci.yml when a test job in the same run already failed
//
// Usage (cwd = repo root):
//   node build/checkCoverageThreshold.mjs

import { evaluate, readGateEnv } from './coverageLib.mjs';

const { threshold, branchThreshold, testsOk } = readGateEnv();
const ev = evaluate(process.cwd(), { threshold, branchThreshold, testsOk });

if (ev.verdict === 'empty') {
  console.error(
    'checkCoverageThreshold: FAILED — 0 packages to check. Every assertion here iterates that ' +
      'list, so this run verified nothing (GATED_PACKAGES in build/coverageLib.mjs is empty, or ' +
      'this was not run from the repo root).',
  );
  process.exit(1);
}

// One line per failing package, so the step's own log says what broke without anyone opening an
// artifact. The three kinds stay apart: they are three different pieces of work.
if (ev.belowBar.length > 0) {
  console.error(
    `checkCoverageThreshold: ${ev.belowBar.length} package(s) below the ${threshold}% line bar — ` +
      ev.belowBar.map((f) => `${f.pkg} (${f.pct.toFixed(2)}%, ${f.headroom} lines short)`).join(', '),
  );
}
if (ev.belowBranchBar.length > 0) {
  console.error(
    `checkCoverageThreshold: ${ev.belowBranchBar.length} package(s) below the ${branchThreshold}% ` +
      'branch bar — ' +
      ev.belowBranchBar
        .map((f) => `${f.pkg} (${f.branchPct.toFixed(2)}%, ${f.branchHeadroom} branches short)`)
        .join(', '),
  );
}
if (ev.scopeShrunk.length > 0) {
  console.error(
    `checkCoverageThreshold: ${ev.scopeShrunk.length} package(s) measured LESS than their source ` +
      'tree — ' +
      ev.scopeShrunk.map((f) => `${f.pkg} (${f.scopeFiles} of ${f.srcFiles} files)`).join(', ') +
      '. A narrowed `coverage.include` raises the percentage without a single new test, and is ' +
      'silent in every other signal here. Widen it back, or say why in the config.',
  );
}
if (ev.missingOutput.length > 0) {
  console.error(
    `checkCoverageThreshold: ${ev.missingOutput.length} package(s) produced no coverage output ` +
      `at all — ${ev.missingOutput.map((f) => f.pkg).join(', ')}. That is a broken test/coverage ` +
      'step, not a coverage regression: every gated package must emit coverage/.',
  );
}
if (ev.failures.length > 0) process.exit(1);

const bars = `>= ${threshold}% lines / ${branchThreshold}% branches`;
console.log(
  ev.skipped > 0
    ? `checkCoverageThreshold: not enforced — ${ev.measured} package(s) ${bars}, ${ev.skipped} ` +
        'skipped (a test job in this run already failed).'
    : `checkCoverageThreshold: OK — all ${ev.measured} gated packages ${bars}.`,
);
