#!/usr/bin/env node
// Pure REPORT over the same coverage/ outputs and the same package list the gate uses. It never
// exits non-zero — build/checkCoverageThreshold.mjs is the only thing in this pair that can fail
// a build, so that "the numbers moved" and "the numbers broke a rule" stay separable.
//
// Both scripts get their verdict from one `evaluate` call in coverageLib.mjs, so the table below
// and the gate's exit code cannot disagree about the same run.
//
// The `Scope` column is the one worth explaining: it prints `measured / src` file counts, so a
// narrowed `coverage.include` shows up in the same table as the percentage it would flatter.
// All three packages read N/N today because all three are whole-tree; a row that stops doing so
// is the interesting event, whether or not the percentage went up.
//
// Writes a GitHub step-summary section when $GITHUB_STEP_SUMMARY is set, and the same table to
// stdout otherwise.
//
// Usage (cwd = repo root):
//   node build/coverageReport.mjs

import { appendFileSync } from 'node:fs';
import { evaluate, readGateEnv } from './coverageLib.mjs';

const { threshold, branchThreshold, testsOk } = readGateEnv();
const ev = evaluate(process.cwd(), { threshold, branchThreshold, testsOk });

const pct = (n) => `${n.toFixed(2)}%`;
const mark = (n, bar) => (n >= bar ? '✅' : '❌');

const header = {
  empty: '⚠️ coverage: nothing measured',
  fail: `❌ coverage: below the ${threshold}% line / ${branchThreshold}% branch bars`,
  skipped: `⏭️ coverage: not enforced (a test job failed in this run)`,
  ok: `✅ coverage: all ${ev.measured} packages >= ${threshold}% lines / ${branchThreshold}% branches`,
}[ev.verdict];

const lines = [
  `## ${header}`,
  '',
  '| Package | Lines | Branches | Functions | Scope (measured/src) |',
  '| --- | --- | --- | --- | --- |',
];

for (const r of ev.rows) {
  if (r.missing) {
    lines.push(`| \`${r.pkg}\` | ❌ no coverage/ output | — | — | — |`);
    continue;
  }
  lines.push(
    `| \`${r.pkg}\` | ${mark(r.pct, threshold)} ${pct(r.pct)} ` +
      `(${r.lines.covered}/${r.lines.total}) | ${mark(r.branchPct, branchThreshold)} ` +
      `${pct(r.branchPct)} (${r.branches.covered}/${r.branches.total}) | ${pct(r.funcPct)} | ` +
      `${r.scopeFiles}/${r.srcFiles} |`,
  );
}

lines.push(
  '',
  '_Functions is reported but not gated — it is the metric most easily satisfied by calling a ' +
    'function once and asserting nothing._',
);

const out = lines.join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n\n`);
console.log(out);
