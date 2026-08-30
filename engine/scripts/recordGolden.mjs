/**
 * Re-record `engine/fixtures/golden.json`. Run it as `npm run record:golden -w engine`.
 *
 * Deliberately a separate command rather than a `vitest -u`-style flag: the golden gate's whole
 * value is that dismissing it costs a conscious act. See engine/goldenHash.test.ts's header, and
 * design/18-test-strategy.md (Layer 0).
 *
 * All this does is run that one test file with RECORD_GOLDEN=1, which flips it from asserting to
 * writing. Spawning through a shell so `npx` resolves on Windows as well as POSIX.
 */
import { spawnSync } from 'node:child_process';

const run = spawnSync('npx', ['vitest', 'run', 'goldenHash.test.ts'], {
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, RECORD_GOLDEN: '1' },
  stdio: 'inherit',
  shell: true,
});

if (run.status !== 0) {
  console.error('\nrecord:golden failed — fixture NOT written.');
  process.exit(run.status ?? 1);
}

console.log(
  [
    '',
    'Recorded engine/fixtures/golden.json.',
    '',
    'Before committing, check that you also:',
    '  - bumped ENGINE_VERSION in engine/versionHistory.ts, and',
    '  - added a `## vN:` entry to engine/ENGINE_VERSION_HISTORY.md saying what diverges.',
    'versionContract.test.ts will fail if the fixture and ENGINE_VERSION disagree.',
    '',
  ].join('\n'),
);
