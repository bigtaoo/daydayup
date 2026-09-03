/**
 * `checkDocPaths`' rules, each against a synthetic doc set, plus the real repo as the control.
 *
 * The real-tree assertion alone would be worthless: it is one `expect([]).toEqual([])` that
 * passes just as happily if the token regex matches nothing or the doc walk finds no files. So
 * every rule below is also fed something that violates it, and there is an explicit
 * scope-is-not-empty test (`daydayup-test-assertion-craft`: a sweep's zero with no evidence the
 * case arose).
 *
 * ## The limitation this file is honest about
 *
 * The allowlist exempts a TOKEN, not a sentence. Five entries are deleted files that a decision
 * doc cites *as deleted* — and if someone later rewords one of those sentences into a
 * present-tense claim ("`confirmEdge.test.ts` fails type-check until…", which is the exact defect
 * the 2026-09-03 audit found), the token is still allowlisted and this gate stays green. It
 * cannot read framing. What it does catch is a NEW dangling reference appearing in a decision
 * doc, which is the direction drift actually travels: a file gets deleted or renamed, and a doc
 * elsewhere keeps naming it. The framing half stays a review concern, and the allowlist's `why`
 * strings are where that judgement is written down.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWLIST, checkDocPaths, decisionDocs, extractPathTokens, toPosix } from './checkDocPaths.mjs';

const ROOT = toPosix(join(import.meta.dirname, '..'));

function realInputs() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const docs = new Map(decisionDocs(ROOT).map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
  return { tracked, docs };
}

describe('the real repo', () => {
  it('has no decision doc citing a file that does not exist', () => {
    const { tracked, docs } = realInputs();
    expect(checkDocPaths(docs, tracked).violations).toEqual([]);
  });

  it('has no dead allowlist entry', () => {
    const { tracked, docs } = realInputs();
    expect(checkDocPaths(docs, tracked).deadEntries).toEqual([]);
  });

  // Guards the guard: both assertions above pass vacuously if the walk or the regex finds
  // nothing. These are loose lower bounds, not pinned counts, so ordinary doc growth is fine.
  it('actually has a scope to check', () => {
    const { tracked, docs } = realInputs();
    expect(docs.size).toBeGreaterThan(20);
    expect(tracked.length).toBeGreaterThan(500);
    expect(checkDocPaths(docs, tracked).checked).toBeGreaterThan(500);
  });
});

describe('scope', () => {
  const docs = decisionDocs(ROOT);

  it('covers the decision docs, including the rendering/ split', () => {
    expect(docs).toContain('design/08-simulation-core.md');
    expect(docs).toContain('design/rendering/02-walls.md');
    expect(docs).toContain('CLAUDE.md');
  });

  // The whole reason this gate is narrower than the original sweep: the log is history, and an
  // August entry naming a since-deleted file is correct, not stale.
  it('excludes the append-only log and ROADMAP', () => {
    expect(docs).not.toContain('design/ROADMAP.md');
    expect(docs.filter((d) => d.includes('/roadmap/'))).toEqual([]);
    expect(docs).not.toContain('README.md');
  });
});

describe('the gate catches things', () => {
  const TRACKED = ['client/src/game/scene/Scene.ts', 'engine/content/drops.ts', 'design/08-simulation-core.md'];
  const NO_ALLOW = [];

  it('passes a doc whose references all resolve (the control)', () => {
    const docs = new Map([['design/99.md', 'See `client/src/game/scene/Scene.ts` and `engine/content/drops.ts`.']]);
    expect(checkDocPaths(docs, TRACKED, NO_ALLOW).violations).toEqual([]);
  });

  it('flags a reference to a file that does not exist, with doc and line', () => {
    const docs = new Map([['design/99.md', 'line one\nsee `client/src/game/gone.ts` here']]);
    const { violations } = checkDocPaths(docs, TRACKED, NO_ALLOW);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('design/99.md:2');
    expect(violations[0]).toContain('`client/src/game/gone.ts`');
    expect(violations[0]).toContain('no tracked file is named "gone.ts"');
  });

  // The 2026-09-03 finding, reproduced: design/10 promised a gate in a file deleted a month
  // earlier. Without its allowlist entry, this is exactly what the gate reports.
  it('would have caught the confirmEdge defect', () => {
    const docs = new Map([[
      'design/10-ui-hud.md',
      "`confirmEdge.test.ts`'s exhaustive `Record<Phase, boolean>` fails type-check until a new phase is added.",
    ]]);
    const { violations } = checkDocPaths(docs, TRACKED, NO_ALLOW);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('confirmEdge.test.ts');
  });

  // Shorthand citation is house style, not drift — `game/Scene.ts` means the real Scene.ts.
  it('accepts a shorthand path whose basename resolves', () => {
    const docs = new Map([['design/99.md', 'see `game/Scene.ts`']]);
    expect(checkDocPaths(docs, TRACKED, NO_ALLOW).violations).toEqual([]);
  });

  it('does not flag an allowlisted token', () => {
    const docs = new Map([['design/99.md', "funny's `engine/loop.ts`"]]);
    const allow = [{ token: 'engine/loop.ts', why: 'sibling project' }];
    expect(checkDocPaths(docs, TRACKED, allow).violations).toEqual([]);
  });
});

describe('the allowlist cannot rot', () => {
  const TRACKED = ['engine/content/drops.ts'];

  it('flags an entry no decision doc cites any more', () => {
    const docs = new Map([['design/99.md', 'nothing here but `engine/content/drops.ts`']]);
    const allow = [{ token: 'some/removed.ts', why: 'was cited once' }];
    const { deadEntries } = checkDocPaths(docs, TRACKED, allow);
    expect(deadEntries).toHaveLength(1);
    expect(deadEntries[0]).toContain('no decision doc cites it any more');
  });

  it('flags an entry whose token now resolves — the exemption is stale', () => {
    const docs = new Map([['design/99.md', 'see `engine/content/drops.ts`']]);
    const allow = [{ token: 'engine/content/drops.ts', why: 'was deleted once' }];
    const { violations, deadEntries } = checkDocPaths(docs, TRACKED, allow);
    expect(violations).toEqual([]);
    expect(deadEntries).toHaveLength(1);
    expect(deadEntries[0]).toContain('now RESOLVES');
  });

  it('reports a resolved entry once even when several docs cite it', () => {
    const docs = new Map([
      ['design/98.md', 'see `engine/content/drops.ts`'],
      ['design/99.md', 'also `engine/content/drops.ts`'],
    ]);
    const allow = [{ token: 'engine/content/drops.ts', why: 'stale' }];
    expect(checkDocPaths(docs, TRACKED, allow).deadEntries).toHaveLength(1);
  });

  it('every real entry carries a non-trivial reason', () => {
    for (const { token, why } of ALLOWLIST) {
      expect(typeof why, token).toBe('string');
      expect(why.length, token).toBeGreaterThan(25);
    }
    expect(new Set(ALLOWLIST.map((e) => e.token)).size).toBe(ALLOWLIST.length);
  });
});

describe('token extraction', () => {
  it('only reads inside backticks', () => {
    const found = extractPathTokens('bare Scene.ts is prose; `Scene.ts` is a citation');
    expect(found.map((f) => f.token)).toEqual(['Scene.ts']);
  });

  it('reports the line each token was on', () => {
    expect(extractPathTokens('a\nb `x.ts`\n`y.ts`')).toEqual([
      { token: 'x.ts', line: 2 },
      { token: 'y.ts', line: 3 },
    ]);
  });

  it('takes several tokens from one line', () => {
    const found = extractPathTokens('`a.ts`/`b.test.ts` and `c/d.json`');
    expect(found.map((f) => f.token)).toEqual(['a.ts', 'b.test.ts', 'c/d.json']);
  });

  it('ignores backticked prose that is not a path', () => {
    const found = extractPathTokens('`GameState`, `step()`, `toBe(0)`, `1.5`');
    expect(found).toEqual([]);
  });

  // Version numbers and ratios are all over these docs (`ENGINE_VERSION` 53, `4.07 vs 4.28 ms`)
  // and none of them is a filename; the extension list is what keeps them out.
  it('does not treat a dotted number as a file', () => {
    expect(extractPathTokens('`11.5` and `0.2` and `v53.1`')).toEqual([]);
  });
});
