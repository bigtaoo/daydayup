/**
 * `ENGINE_VERSION` is tied to nothing — until this file (design/18-test-strategy.md, G2).
 *
 * The number lives in `versionHistory.ts`, its rationale lives in `ENGINE_VERSION_HISTORY.md`,
 * `README.md` quotes it, and `fixtures/golden.json` records the behaviour it stands for. Before
 * these tests, nothing checked that any two of those agreed, and all of them had drifted:
 * `engine/README.md` said 39 against an actual 48, `content/enemies.ts` cited a "v49" that has
 * never existed, and `design/ROADMAP.md` said 47 while conceding it "is not the authority".
 *
 * The load-bearing one is the golden cross-check. Without it the gate next door has an obvious
 * escape hatch: re-record the fixture, skip the bump, go green. With it, a re-record without a
 * bump fails here — so the two files can only be brought back into agreement by making the
 * decision the version is FOR.
 */
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from './config';
import { readGolden } from './fixtures/goldenFile.mjs';
import { readEngineFile } from './fixtures/repoFiles.mjs';

describe('ENGINE_VERSION is anchored to the things that describe it', () => {
  it('has an entry of its own in ENGINE_VERSION_HISTORY.md', () => {
    expect(
      documentedVersions().has(ENGINE_VERSION),
      `ENGINE_VERSION is ${ENGINE_VERSION} but ENGINE_VERSION_HISTORY.md documents no v${ENGINE_VERSION}.\n` +
        'A bump without an entry is a replay break nobody can explain later. Add the entry.',
    ).toBe(true);
  });

  it('the golden fixture was recorded at THIS version', () => {
    // Closes the escape hatch: `npm run record:golden` alone cannot make goldenHash.test.ts
    // green again, because re-recording stamps the fixture with the CURRENT version and this
    // assertion then demands the bump that the re-record was avoiding.
    const golden = readGolden();
    expect(
      golden.engineVersion,
      'fixtures/golden.json was recorded at a different ENGINE_VERSION.\n' +
        'Either you re-recorded without bumping (bump it), or you bumped without re-recording\n' +
        '(run npm run record:golden -w engine).',
    ).toBe(ENGINE_VERSION);
  });

  it("README.md quotes the current version, not a stale one", () => {
    const readme = readEngineFile('README.md');
    const quoted = /`versionHistory\.ts`, currently \*\*(\d+)\*\*/.exec(readme);
    expect(quoted, 'README.md no longer states a version in the expected form').not.toBeNull();
    expect(
      Number(quoted![1]),
      'engine/README.md quotes a stale ENGINE_VERSION. It said 39 against an actual 48 for nine bumps ' +
        'before this test existed.',
    ).toBe(ENGINE_VERSION);
  });

  it('every version up to the current one is documented — no silent bumps', () => {
    // Not a style rule: a gap means some bump shipped with no recorded reason, which is exactly
    // the state a future desync investigation cannot recover from.
    const documented = documentedVersions();
    const missing: number[] = [];
    // v1 is the initial version and has no "bump" to explain, so the range starts at 2.
    for (let v = 2; v <= ENGINE_VERSION; v++) if (!documented.has(v)) missing.push(v);
    expect(missing, `versions with no entry in ENGINE_VERSION_HISTORY.md: ${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * Which versions the changelog actually documents. THREE forms are accepted, because the file
 * genuinely uses all three — normalising 47 historical entries to satisfy a test would be the
 * tail wagging the dog, and each form was found by this test failing rather than by reading:
 *
 *   - `v5: static round solids (pillars) now collide.` — a paragraph-leading label, the
 *     original convention and by far the most common;
 *   - `(v15→16 — orbit ballistic + radial emission, ...)` — a parenthesised TRANSITION entry.
 *     v16 and v17 exist only in this form, which is why a naive scan reported them missing;
 *   - `## v47: a free-standing block's NORTH face...` — a Markdown heading, adopted once
 *     entries grew long enough to want their own sections.
 *
 * All three anchor at the start of a line. That matters: this file mentions "v43" and friends
 * mid-sentence constantly, and counting those as entries would let a genuinely undocumented
 * bump sail through — the exact hole the test exists to close.
 */
function documentedVersions(): Set<number> {
  const history = readEngineFile('ENGINE_VERSION_HISTORY.md');
  const found = new Set<number>();
  for (const m of history.matchAll(/^(?:## )?v(\d+)[ :(]/gm)) found.add(Number(m[1]));
  for (const m of history.matchAll(/^\(v\d+→(\d+)\b/gm)) found.add(Number(m[1]));
  return found;
}
