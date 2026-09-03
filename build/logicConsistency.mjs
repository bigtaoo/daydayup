#!/usr/bin/env node
// The LOGIC-CONSISTENCY suite: the named set of gates that keep the sim, the client's reading
// of it, and the docs describing it agreeing with one another. Run on EVERY CI event.
//
// ## Why a manifest, when `npm test` already runs all of these
//
// It does — and that is the problem this file solves. These are the highest-value gates in
// the repo (design/18's Layer 0 and Layer 2), and every one of them can stop running without
// anything turning red: rename a file, move it out of an `include` glob, or let a `describe`
// block go empty, and the suite just reports one fewer test. Nothing anywhere says which
// tests were SUPPOSED to run.
//
// So the manifest below is the list, `logicConsistency.test.mjs` asserts that every entry
// still resolves to a real file, and `--run` executes exactly these — a named CI step whose
// name says what it proves, rather than a number buried in a 6,000-test summary.
//
// ## What belongs on this list
//
// A gate qualifies when it pins an agreement between two things that are maintained
// separately and can drift apart in silence. Not "an important test" — an important test that
// nothing else would notice the absence of. Ordinary unit tests fail loudly when the code
// under them changes; these fail only when two halves stop matching, which is a slower and
// much quieter kind of wrong.
//
// Usage (cwd = repo root):
//   node build/logicConsistency.mjs           verify the manifest resolves; print the list
//   node build/logicConsistency.mjs --run     ...and run every suite on it

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The gates, grouped by the agreement each one holds. `why` is not decoration: it is the
 * test for whether a future entry belongs here, and the thing to read before deleting one.
 */
export const CONSISTENCY_SUITES = [
  // ── Layer 0: the sim agrees with its own recorded past ──────────────────────
  {
    pkg: 'engine',
    file: 'goldenHash.test.ts',
    why: 'Replays a recorded fixture and compares the state hash. The one gate that can tell a deliberate sim change from an accidental one — every other engine test asserts what the author believed, this asserts what the engine actually did before.',
  },
  {
    pkg: 'engine',
    file: 'versionContract.test.ts',
    why: 'ENGINE_VERSION, its history file and the golden fixture must move together. Bumping one without the others makes the golden gate compare against the wrong baseline, which reads as "no change".',
  },
  {
    pkg: 'engine',
    file: 'determinismLint.test.ts',
    why: 'No Math.random / Date.now / iteration over an unordered set anywhere in the sim. A single one of those desyncs an online match on one client only, hours later, with no error.',
  },
  {
    pkg: 'engine',
    file: 'stepOrder.test.ts',
    why: 'The system step order in code matches the order design/06 documents. Two systems swapping is a legal-looking refactor that changes every outcome.',
  },
  {
    pkg: 'engine',
    file: 'smoke.test.ts',
    why: 'Five real runs, seven invariants, checked on every tick — the backstop for a change that breaks the sim in a way no unit test covers.',
  },

  // ── Layer 2: the client's reading agrees with the sim's ─────────────────────
  {
    pkg: 'engine',
    file: 'systems/boundaryParity.test.ts',
    why: 'One definition of a solid boundary, used by movement and by collision. Two copies drifting apart is how a player walks into a wall on one side and through it on the other.',
  },
  {
    pkg: 'engine',
    file: 'systems/clearanceParity.test.ts',
    why: 'Spawn clearance measured the same way the mover measures it. A mismatch spawns a monster inside geometry, where it cannot move and the run stalls.',
  },
  {
    pkg: 'client',
    file: 'src/game/scene/simRenderParity.test.ts',
    why: 'What the sim says is at (x, y) is where the renderer draws it. The whole class of "it looks right and the hit lands somewhere else" lives here.',
  },
  {
    pkg: 'client',
    file: 'src/render/muzzleParity.test.ts',
    why: 'The muzzle the art draws and the origin the sim fires from are the same point. Off by a few pixels, every shot visibly misses from behind cover while registering as a hit.',
  },
  {
    pkg: 'client',
    file: 'src/game/ui/pickupProximity.test.ts',
    why: 'The panel offers exactly what the sim would accept. The two ends of one interaction, maintained in different files — see the unpickable-loot investigation for what a gap between them costs.',
  },
  {
    pkg: 'client',
    file: 'src/game/fx/meleeArcParity.test.ts',
    why: 'The swing the player sees covers the arc the sim resolves. ENGINE_VERSION 53 shipped with every blade on a one-tick window because a test staged the swing by hand instead of measuring the drawn arc.',
  },

  // ── The client's own logic layer agrees with itself ─────────────────────────
  {
    pkg: 'client',
    file: 'src/game/pureLayerBoundary.test.ts',
    why: 'The pure modules stay loadable without a browser. A percentage cannot enforce this (see that file\'s header); once it breaks, the affected logic quietly becomes untestable again.',
  },
];

/** Manifest entries that no longer resolve to a real file. */
export function missingEntries(root, suites = CONSISTENCY_SUITES) {
  return suites.filter(({ pkg, file }) => !existsSync(join(root, pkg, file)));
}

function main() {
  const root = process.cwd();
  const missing = missingEntries(root);

  // The canary. Every loop here iterates the manifest, so an emptied list would print a
  // cheerful "all gates present" and exit 0 — a gate that retires itself by turning green.
  if (CONSISTENCY_SUITES.length === 0) {
    console.error(
      'logicConsistency: FAILED — the manifest is empty, so this run verified nothing.',
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(
      `logicConsistency: FAILED — ${missing.length} gate(s) named in the manifest no longer ` +
        `exist: ${missing.map((m) => `${m.pkg}/${m.file}`).join(', ')}. A renamed or deleted ` +
        'consistency gate stops running with NOTHING turning red, which is the entire reason ' +
        'this manifest exists. Update build/logicConsistency.mjs, or restore the file.',
    );
    process.exit(1);
  }

  console.log(`logicConsistency: ${CONSISTENCY_SUITES.length} gates present.`);
  for (const s of CONSISTENCY_SUITES) console.log(`  ${s.pkg}/${s.file}`);

  if (!process.argv.includes('--run')) return;

  // Run them per workspace, so each gets its own vitest config (and therefore its own
  // `@dd/*` alias map — the engine's and the client's differ).
  const byPkg = new Map();
  for (const { pkg, file } of CONSISTENCY_SUITES) {
    if (!byPkg.has(pkg)) byPkg.set(pkg, []);
    byPkg.get(pkg).push(file);
  }
  // vitest's own JS entry, run through this node — not `npx`, which on Windows needs
  // `shell: true` and then concatenates rather than escapes its arguments (DEP0190).
  const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestBin)) {
    console.error(`logicConsistency: FAILED — vitest not found at ${vitestBin}. Run npm ci.`);
    process.exit(1);
  }
  for (const [pkg, files] of byPkg) {
    console.log(`\nlogicConsistency: running ${files.length} gate(s) in ${pkg}/`);
    execFileSync(process.execPath, [vitestBin, 'run', ...files], {
      cwd: join(root, pkg),
      stdio: 'inherit',
    });
  }
  console.log('\nlogicConsistency: OK — every gate ran and passed.');
}

// Only when run directly, so the test file can import the manifest.
if (process.argv[1] && process.argv[1].endsWith('logicConsistency.mjs')) main();
