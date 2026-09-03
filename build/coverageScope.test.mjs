/**
 * Guards the SHAPE of every gated package's `coverage.include` — that it stays a whole-tree glob
 * and never becomes a hand-maintained file list.
 *
 * This is the inverse of the guard it is modelled on. The sibling project `funny` has
 * `client/test/coverageScope.test.ts`, which walks a ~50-entry per-file allow-list and fails when
 * an entry stops matching a real file: there, the list is the design, and the risk is that it
 * ROTS (a renamed file leaves a stale entry, one fewer file is measured, and the percentage goes
 * up). Here there is no list, and the risk runs the other way: that someone under pressure to get
 * a red gate green narrows the include to the files that already pass. That move raises every
 * number in the report while measuring less of the product, which is the single most flattering
 * and least honest edit available anywhere in this setup.
 *
 * So the rule is structural rather than per-entry: an include entry must be a WILDCARD, never a
 * path to one file. Two layers back that up, and it is worth knowing which does what, because
 * this file alone is not enough:
 *
 *   this file           the include is shaped like a whole-tree glob        (static, every `npm test`)
 *   the `scopeShrunk`   the include MEASURED as many files as exist on disk (needs a coverage run)
 *   rule in the gate
 *
 * The second is the real enforcement — it uses the answer vitest's own matcher produced, so it
 * cannot be fooled by a glob that looks right and matches nothing. This one exists because it
 * runs in the plain suite, with no coverage pass, and so fails in the PR that writes the bad
 * config rather than in the job after it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import clientConfig from '../client/vite.config.js';
import engineConfig from '../engine/vitest.config.ts';
import serverConfig from '../server/vitest.config.ts';
import { GATED_PACKAGES } from './coverageLib.mjs';

const REPO_ROOT = join(import.meta.dirname, '..');

const CONFIGS = [
  { pkg: 'client', config: clientConfig },
  { pkg: 'engine', config: engineConfig },
  { pkg: 'server', config: serverConfig },
];

const coverageOf = (config) => config.test?.coverage ?? {};

describe('every gated package', () => {
  it('canary: there is one config here per gated package', () => {
    // Every case below iterates CONFIGS. An emptied or half-written list would pass them all
    // while checking nothing — the same shape as the gate's own empty-list canary.
    expect(CONFIGS).toHaveLength(GATED_PACKAGES.length);
    expect(CONFIGS.map((c) => c.pkg).sort()).toEqual(GATED_PACKAGES.map((p) => p.pkg).sort());
  });

  it.each(CONFIGS)('$pkg declares a v8 coverage block the gate can read', ({ config }) => {
    const cov = coverageOf(config);
    expect(cov.provider).toBe('v8');
    // json-summary is what build/checkCoverageThreshold.mjs parses; without it the gate sees a
    // package with no coverage output and fails closed, which is correct but unhelpful.
    expect(cov.reporter).toContain('json-summary');
    expect(cov.reportsDirectory).toBe('./coverage');
  });

  it.each(CONFIGS)('$pkg includes its whole source tree, not a file list', ({ pkg, config }) => {
    const include = coverageOf(config).include ?? [];
    expect(include.length).toBeGreaterThan(0);
    const perFile = include.filter((e) => !e.includes('*'));
    expect(
      perFile,
      `${pkg}: coverage.include names individual files. A per-file include is how a coverage ` +
        'gate gets quietly narrowed onto the code that already passes — see this file\'s header.',
    ).toEqual([]);
  });

  it.each(CONFIGS)('$pkg excludes only tests, types and fixtures', ({ pkg, config }) => {
    // Everything an exclude is allowed to remove. The list is short on purpose: an exclude is
    // the other way to shrink a scope, and it does not show up in the `scopeShrunk` count when
    // it removes a file `countSrcFiles` also skips.
    const ALLOWED = [
      /\*\.test\.ts$/, // test files
      /\*\.d\.ts$/, // ambient types — no executable lines anyway
      /^fixtures\/\*\*$/, // engine: test data replayed BY the gates
      /^scripts\/\*\*$/, // one-off CLIs (engine's golden recorder)
      /^coverage\/\*\*$/, // this package's own output
      /config\.ts$/, // vitest.config.ts / sim.config.ts
    ];
    const unexplained = (coverageOf(config).exclude ?? []).filter(
      (e) => !ALLOWED.some((re) => re.test(e)),
    );
    expect(
      unexplained,
      `${pkg}: coverage.exclude drops something that is not a test, a type or a fixture. If that ` +
        'is deliberate, add the shape to this test\'s ALLOWED list with the reason.',
    ).toEqual([]);
  });

  it.each(GATED_PACKAGES)('$pkg is a real workspace with a test:coverage script', ({ pkg }) => {
    // The gate's package list and the scripts that feed it can drift apart in silence: a package
    // named here but with no `test:coverage` produces no coverage/, which reads as a broken CI
    // step rather than as the misconfiguration it is.
    expect(existsSync(join(REPO_ROOT, pkg, 'package.json'))).toBe(true);
    const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, pkg, 'package.json'), 'utf8'));
    expect(pkgJson.scripts?.['test:coverage']).toBeTruthy();
  });
});
