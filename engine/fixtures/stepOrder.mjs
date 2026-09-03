/**
 * The step-numbering gate's parser, split out of `stepOrder.test.ts` so the checks can be run
 * against SYNTHETIC sources in a unit test rather than only against the real repo. A gate whose
 * only evidence is "it returned zero problems on the real tree" is the shape this repo has been
 * burned by before (`daydayup-test-assertion-craft`: a sweep's zero with no evidence the case
 * arose) — so every rule below is also fed a source that violates it.
 *
 * `.mjs` for the same reason `repoFiles.mjs` is: the engine workspace sets `"types": []` on
 * purpose, and a test needing to read source text is not a reason to hand the sim core `node:*`
 * typings. Types live in `stepOrder.d.mts`. Pure string functions — no filesystem access here,
 * the caller supplies the text.
 *
 * See design/08's `step()` skeleton and design/18-test-strategy.md (Layer 0).
 */

/**
 * A step LABEL is not a number: the shipped order is 1..8, then `8a`/`8b` (two passes inserted
 * after status effects without renumbering everything below them), then 9..11, then `11.5`
 * (doors, inserted between spawns and extraction), then 12..14. Both escape hatches are
 * deliberate — renumbering would have churned every system header and every `design/08` citation
 * for no behavioural reason — so the comparator has to understand them rather than reject them.
 *
 * Sort key is `[numeric, suffix]`: `11.5` sorts by its real value, and `8` < `8a` < `8b` because
 * an absent suffix sorts before any letter.
 */
export function labelKey(label) {
  const m = /^(\d+(?:\.\d+)?)([a-z]?)$/.exec(label);
  if (!m) return null;
  return [Number(m[1]), m[2]];
}

/** Strictly-increasing test over two labels' sort keys. */
export function labelLessThan(a, b) {
  const ka = labelKey(a);
  const kb = labelKey(b);
  if (!ka || !kb) return false;
  return ka[0] !== kb[0] ? ka[0] < kb[0] : ka[1] < kb[1];
}

/**
 * The `step()` body only. Scoped deliberately: `GameEngine` also has `advance()`, and a future
 * helper calling some system's `tick` outside the frozen order must NOT be read as part of it.
 * Ends at the first line that is exactly a two-space-indented `}` — the method's own closing
 * brace at class-member indentation.
 */
export function stepBody(gameEngineSrc) {
  // Must match the DECLARATION, not prose. `GameEngine.ts`'s own header comment says
  // "step(commands) is the direct entry (headless/tests)", and an `indexOf('step(commands')`
  // finds that first — then runs to the constructor's closing brace and returns the field
  // declarations as if they were the step order. Requiring the `commands:` type annotation
  // separates the signature from every mention of it, since the prose has no types.
  // (Same trap `determinismLint.test.ts`'s header records: a source-text contract test matching
  // a value quoted in a comment.)
  const sig = /^[ \t]*step\s*\(\s*commands\s*:[^{]*\{/m.exec(gameEngineSrc);
  if (!sig) return null;
  const rest = gameEngineSrc.slice(sig.index);
  const end = rest.indexOf('\n  }');
  return end < 0 ? null : rest.slice(0, end);
}

/** `private readonly pickup = new PickupSystem();` -> Map<field, className>. */
export function fieldClasses(gameEngineSrc) {
  const out = new Map();
  const re = /(?:private\s+)?(?:readonly\s+)?(\w+)\s*=\s*new\s+(\w+)\s*\(/g;
  for (let m; (m = re.exec(gameEngineSrc)); ) out.set(m[1], m[2]);
  return out;
}

/**
 * The frozen order as the code actually states it: every `this.<field>.tick(...)` in `step()`,
 * paired with the `// <label>` that follows it on the same line. A call with NO trailing label
 * comment is reported rather than skipped — an unlabelled call is exactly how a system gets
 * inserted into the contract without anyone renumbering what follows.
 */
export function parseStepOrder(gameEngineSrc) {
  const body = stepBody(gameEngineSrc);
  if (body === null) return { calls: [], problems: ['GameEngine.step(commands…) body not found'] };
  const classes = fieldClasses(gameEngineSrc);
  const calls = [];
  const problems = [];
  const re = /^[ \t]*this\.(\w+)\.tick\(([^)]*)\);(.*)$/gm;
  for (let m; (m = re.exec(body)); ) {
    const [, field, , trailer] = m;
    const label = /\/\/\s*(\d+(?:\.\d+)?[a-z]?)\b/.exec(trailer);
    const className = classes.get(field);
    if (!className) problems.push(`step() calls this.${field}.tick() but no "new …()" declares that field`);
    if (!label) {
      problems.push(`step() calls this.${field}.tick() with no "// <step number>" comment`);
      continue;
    }
    calls.push({ field, className: className ?? null, label: label[1] });
  }
  return { calls, problems };
}

/**
 * A system's own claim about where it runs, from its file header: `* Step 9 — Death & drops.`
 * Only the first 40 lines are scanned, so a later mention of another step in prose (
 * `PickupSystem`'s "a kill in step 9", for one) can never be mistaken for the declaration.
 * Returns null when the header states no number at all — which is its own finding: both
 * `ZoneSystem` and `EnvironmentSystem` said a bare `Step —` until 2026-09-03.
 */
export function parseSystemStep(systemSrc) {
  const head = systemSrc.split('\n').slice(0, 40).join('\n');
  const m = /^\s*\*\s*Step\s+(\d+(?:\.\d+)?[a-z]?)?\s*[—-]/m.exec(head);
  if (!m) return { declared: null, stated: false };
  return { declared: m[1] ?? null, stated: true };
}

/**
 * The gate. `systems` is a Map<fileName, source> over `engine/systems/*System.ts`.
 *
 * Four rules, each of which has failed in this repo for real or is one edit away from it:
 *  1. every `step()` call carries a label, and its field resolves to a class (parseStepOrder);
 *  2. the labels are STRICTLY INCREASING down the body — catches a reorder that moved a call
 *     without renumbering, which is the one that silently changes sim outcomes;
 *  3. each system's header declares the same label `step()` gives it — the off-by-one trio
 *     (`DeathDrops`/`Pickup`/`Spawn`, stale from `ENGINE_VERSION` 8 to 2026-09-03);
 *  4. no `*System.ts` is missing from `step()`, and none is called that has no file — a system
 *     wired but undeclared, or declared but never run.
 */
export function checkStepNumbering(gameEngineSrc, systems) {
  const { calls, problems } = parseStepOrder(gameEngineSrc);
  const out = [...problems];

  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1];
    const cur = calls[i];
    if (!labelLessThan(prev.label, cur.label)) {
      out.push(`step() order is not increasing: ${prev.field} (${prev.label}) then ${cur.field} (${cur.label})`);
    }
  }

  const calledClasses = new Set();
  for (const call of calls) {
    if (!call.className) continue;
    calledClasses.add(call.className);
    const src = systems.get(`${call.className}.ts`);
    if (src === undefined) {
      out.push(`step() runs ${call.className} but engine/systems/${call.className}.ts was not found`);
      continue;
    }
    const { declared, stated } = parseSystemStep(src);
    if (!stated) {
      out.push(`${call.className}.ts header has no "Step N —" line (step() runs it at ${call.label})`);
    } else if (declared === null) {
      out.push(`${call.className}.ts header says "Step —" with no number (step() runs it at ${call.label})`);
    } else if (declared !== call.label) {
      out.push(`${call.className}.ts header says Step ${declared}, but step() runs it at ${call.label}`);
    }
  }

  for (const name of [...systems.keys()].sort()) {
    const className = name.replace(/\.ts$/, '');
    if (!calledClasses.has(className)) {
      out.push(`engine/systems/${name} exists but step() never calls it`);
    }
  }
  return out;
}

/**
 * design/08's `step()` skeleton, as the set of labels it lists. This is the half that would have
 * caught the finding that actually mattered on 2026-09-03: `DoorSystem` ran at 11.5 for four
 * weeks while the doc the repo calls "the determinism contract" did not mention it at all — an
 * omission no amount of checking the numbers that ARE written down can find.
 *
 * Lines look like `  1. Apply input      — …`, ` 8a. Zone …`, `11.5 Doors …` (that last one has
 * no dot, so the dot is optional). Only the fenced skeleton block is scanned; the prose below it
 * cites step numbers constantly.
 */
export function parseDesignStepLabels(designDocSrc) {
  const start = designDocSrc.indexOf('step(tick, commands):');
  if (start < 0) return null;
  const rest = designDocSrc.slice(start);
  const end = rest.indexOf('```');
  const block = end < 0 ? rest : rest.slice(0, end);
  const labels = [];
  for (const line of block.split('\n')) {
    const m = /^\s{0,3}(\d+(?:\.\d+)?[a-z]?)\.?\s+[A-Z]/.exec(line);
    if (m) labels.push(m[1]);
  }
  return labels;
}
