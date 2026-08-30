/**
 * Filesystem access for the two contract gates (`versionContract.test.ts`,
 * `determinismLint.test.ts`), kept in `.mjs` for the same reason `goldenFile.mjs` is: the
 * engine workspace sets `"types": []` deliberately — "the sim core may resolve only itself" —
 * and a test needing `readFileSync` is not a reason to hand the whole package `node:*` typings.
 * Types live in `repoFiles.d.mts`.
 *
 * See design/18-test-strategy.md (Layer 0).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';

const ENGINE_DIR = new URL('..', import.meta.url);

export function readEngineFile(relPath) {
  return readFileSync(new URL(relPath, ENGINE_DIR), 'utf8');
}

/**
 * Every `.ts` file under the engine, relative to the engine root, EXCLUDING tests, fixtures and
 * `node_modules`. That exclusion list is the lint's scope declaration — a test may say
 * `Math.random` while describing why the sim may not.
 */
export function engineSourceFiles() {
  const out = [];
  const walk = (dirUrl, prefix) => {
    for (const name of readdirSync(dirUrl)) {
      if (name === 'node_modules' || name === 'scripts' || name === 'fixtures') continue;
      const child = new URL(`${name}${statSyncIsDir(dirUrl, name) ? '/' : ''}`, dirUrl);
      const rel = `${prefix}${name}`;
      if (statSyncIsDir(dirUrl, name)) {
        walk(child, `${rel}/`);
      } else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
        out.push(rel);
      }
    }
  };
  walk(ENGINE_DIR, '');
  return out.sort();
}

function statSyncIsDir(dirUrl, name) {
  return statSync(new URL(name, dirUrl)).isDirectory();
}
