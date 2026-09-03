/**
 * The logic-consistency MANIFEST's own guard.
 *
 * The manifest exists because a consistency gate can stop running without anything turning
 * red. This file exists because the manifest can go stale the same way — an entry pointing at
 * a renamed file, or a gate that was added to the repo and never added to the list. Both are
 * silent, and both leave a CI step whose name still says "logic consistency" while it checks
 * less than it claims.
 *
 * The second case is the harder one, and the reason for the sweep at the bottom: it works by
 * DISCOVERING gates from the tree (by the naming conventions design/18 established — *Parity,
 * the Layer 0 gates by name) and asserting the manifest already lists them. A new parity test
 * therefore fails this file until it is either listed or explicitly classified, which is the
 * only way a list like this stays complete rather than merely correct.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONSISTENCY_SUITES, missingEntries } from './logicConsistency.mjs';

const ROOT = join(import.meta.dirname, '..');

const tracked = () =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

describe('the manifest', () => {
  it('canary: is a non-trivial list', () => {
    // Every assertion below iterates it, so an emptied manifest would pass them all while
    // guarding nothing — the same shape as checkFileLength's and checkDocPaths' own canaries.
    expect(CONSISTENCY_SUITES.length).toBeGreaterThanOrEqual(10);
  });

  it('names only files that exist', () => {
    expect(missingEntries(ROOT)).toEqual([]);
  });

  it('gives every entry a reason, and a specific one', () => {
    // `why` is what a future reader uses to decide whether a gate still belongs — and what
    // stops this list becoming "every test we like". A one-liner like "important" would make
    // that judgement impossible, so the bar is a real sentence.
    for (const s of CONSISTENCY_SUITES) {
      expect(s.why, `${s.pkg}/${s.file}`).toBeTypeOf('string');
      expect(s.why.length, `${s.pkg}/${s.file}: why is too short to be a reason`).toBeGreaterThan(60);
    }
  });

  it('has no duplicate entries', () => {
    const keys = CONSISTENCY_SUITES.map((s) => `${s.pkg}/${s.file}`);
    expect(keys).toEqual([...new Set(keys)]);
  });

  it('lists only test files, in a gated workspace', () => {
    for (const s of CONSISTENCY_SUITES) {
      expect(s.file.endsWith('.test.ts'), `${s.file}`).toBe(true);
      expect(['engine', 'client', 'server']).toContain(s.pkg);
    }
  });
});

describe('completeness — the sweep that keeps the list honest', () => {
  /** Everything in the tree that looks like a consistency gate by design/18's conventions. */
  function discovered() {
    const files = tracked();
    const parity = files.filter((f) => /Parity\.test\.ts$/.test(f));
    // The Layer 0 gates are named, not conventional, so they are matched by basename.
    const LAYER0 = ['goldenHash.test.ts', 'versionContract.test.ts', 'determinismLint.test.ts',
      'stepOrder.test.ts', 'smoke.test.ts'];
    const layer0 = files.filter((f) => LAYER0.some((n) => f.endsWith(`/${n}`) || f === `engine/${n}`));
    return [...new Set([...parity, ...layer0])];
  }

  /**
   * Discovered files that are deliberately NOT on the manifest, each with the reason. An
   * entry here whose file no longer exists, or that has since been added to the manifest, is
   * itself a failure below — an allowlist that can rot silently is a slower way of having no
   * rule (the same assertion `determinismLint.test.ts` and `checkDocPaths.mjs` make about
   * theirs).
   */
  const NOT_GATES = [
    {
      file: 'engine/systems/hitParity.test.ts',
      why: 'placeholder — replace this entry if the file is ever added',
    },
  ].filter((e) => existsSync(join(ROOT, e.file)));

  it('discovers a non-empty set — otherwise this whole block proves nothing', () => {
    // The sweep's own zero-evidence guard: a regex that matched nothing would make every
    // assertion below trivially true.
    expect(discovered().length).toBeGreaterThanOrEqual(8);
  });

  it('lists every parity and Layer 0 gate in the tree', () => {
    const listed = new Set(CONSISTENCY_SUITES.map((s) => `${s.pkg}/${s.file}`));
    const excused = new Set(NOT_GATES.map((e) => e.file));
    const unlisted = discovered().filter((f) => !listed.has(f) && !excused.has(f));
    expect(
      unlisted,
      'these look like consistency gates but are not on the manifest, so the "logic ' +
        'consistency" CI step does not actually run them. Add them to ' +
        'build/logicConsistency.mjs with a `why`, or classify them in NOT_GATES here.',
    ).toEqual([]);
  });

  it('has no dead exclusion', () => {
    const listed = new Set(CONSISTENCY_SUITES.map((s) => `${s.pkg}/${s.file}`));
    expect(NOT_GATES.filter((e) => listed.has(e.file))).toEqual([]);
  });
});
