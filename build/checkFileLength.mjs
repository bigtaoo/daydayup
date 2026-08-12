#!/usr/bin/env node
// Baseline-drift check for the "source files should stay <=500 lines" convention
// (see CLAUDE.md, "Code organization: 500-line file convention"). Ported from the sibling
// project `funny` (claudedocs/server.md / claudedocs/client-modules.md, "单文件 500 行收敛")
// and made generic so every workspace in this repo can share one implementation instead of
// each carrying its own copy.
//
// This is a baseline-drift gate, not a hard "fail if any file is over the limit" gate — files
// already known to be over the limit are tracked as backlog in the workspace's
// scripts/file-length-baseline.json, not blocked on. It only fails on genuine *regressions*:
//   1. a file NOT in the baseline crosses the limit (a new god-file nobody signed off on), or
//   2. a file already in the baseline grows even bigger than its recorded line count
//      (known debt quietly getting worse instead of getting split).
// A baseline file shrinking back under the limit is reported (info only, does not fail) as a
// reminder to delete its entry from the baseline.
//
// Usage (run with cwd = the workspace root, e.g. from `engine/`'s package.json):
//   node ../build/checkFileLength.mjs [--limit=500] [--ext=.ts,.tsx] [--baseline=scripts/file-length-baseline.json]

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? true];
    }),
);

const LIMIT = Number(args.limit ?? 500);
const EXTENSIONS = String(args.ext ?? '.ts,.tsx').split(',').map((s) => s.trim());
const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, String(args.baseline ?? 'scripts/file-length-baseline.json'));

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'generated', '.git', 'scripts', 'coverage']);
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__']);

/** Recursively collect source files under `dir`, skipping generated output, scripts/, and
 *  anything that looks like a test file/dir. */
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name) || TEST_DIR_SEGMENTS.has(entry.name)) continue;
      collectSourceFiles(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const ext = EXTENSIONS.find((e) => entry.name.endsWith(e));
      if (!ext || entry.name.endsWith('.d.ts')) continue;
      const base = entry.name.slice(0, -ext.length);
      if (base.endsWith('.test') || base.endsWith('.spec') || base.endsWith('.e2e')) continue;
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** wc -l semantics: count newline characters, not "number of segments after split". */
function countLines(absPath) {
  const content = readFileSync(absPath, 'utf8');
  if (content.length === 0) return 0;
  const segments = content.split('\n').length;
  return content.endsWith('\n') ? segments - 1 : segments;
}

function toPosix(p) {
  return p.split('\\').join('/');
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
const files = collectSourceFiles(ROOT);

const violations = [];
const notices = [];
const seenBaselinePaths = new Set();
let overLimitCount = 0;

for (const absPath of files) {
  const relPath = toPosix(relative(ROOT, absPath));
  const lines = countLines(absPath);
  if (lines <= LIMIT) continue;
  overLimitCount++;

  const known = baseline[relPath];
  if (known === undefined) {
    violations.push(
      `NEW  ${relPath}: ${lines} lines (> ${LIMIT}), not in baseline.\n` +
      `     -> split it per CLAUDE.md's priority order (function modules > composition > inheritance chain),\n` +
      `        or if it's genuinely a one-off exception, add it to ${toPosix(relative(ROOT, BASELINE_PATH))} and say why.`,
    );
  } else {
    seenBaselinePaths.add(relPath);
    if (lines > known) {
      violations.push(
        `GREW ${relPath}: ${lines} lines, baseline was ${known} (+${lines - known}).\n` +
        `     -> known debt got worse instead of getting split — see CLAUDE.md's priority order.`,
      );
    }
  }
}

for (const relPath of Object.keys(baseline)) {
  if (relPath.startsWith('_')) continue; // e.g. _readme — not a file entry
  if (seenBaselinePaths.has(relPath)) continue;
  const absPath = join(ROOT, relPath);
  try {
    const lines = countLines(absPath);
    if (lines <= LIMIT) {
      notices.push(`${relPath} is now ${lines} lines (<= ${LIMIT}) — remove it from the baseline.`);
    }
  } catch {
    notices.push(`${relPath} no longer exists on disk — remove it from the baseline.`);
  }
}

const baselineCount = Object.keys(baseline).filter((k) => !k.startsWith('_')).length;
console.log(`checkFileLength: scanned ${files.length} source files under ${toPosix(relative(process.cwd(), ROOT) || '.')}, ${overLimitCount} over ${LIMIT} lines (${baselineCount} tracked in baseline).`);
if (notices.length) {
  console.log('\nHousekeeping (non-blocking):');
  for (const n of notices) console.log(`  - ${n}`);
}
if (violations.length) {
  console.log('\nFAILED — new or worsened violations of the 500-line convention:\n');
  for (const v of violations) console.log(v + '\n');
  process.exit(1);
}
console.log('OK — no new violations, no known files grew past their baseline.');
